//! The merchant-side executor for Cadence mandates.
//!
//! The runner holds only the pocket's UFVK (no spend authority) and the payer's
//! pre-signed ladders. When an installment falls due it picks the rung signed for
//! exactly the next block, installs a fresh anchor and the spend witness, proves,
//! and broadcasts. It cannot change a single signed byte.

use std::{fs, num::NonZeroU32, path::PathBuf, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use cadence_chain::{lwd, MemBlockCache, Transport};
use cadence_core::package::{InstallmentLadder, Ladder};
use clap::{Args, Parser, Subcommand, ValueEnum};
use incrementalmerkletree::Position;
use orchard::{
    circuit::OrchardCircuitVersion, keys::FullViewingKey, note::Nullifier, tree::MerklePath,
    Anchor,
};
use pczt::{
    roles::{prover::Prover, tx_extractor::TransactionExtractor, updater::Updater},
    Pczt,
};
use rand::{
    rngs::{ChaCha20Rng, ThreadRng},
    SeedableRng,
};
use zcash_client_backend::{
    data_api::{
        wallet::input_selection::LockFilter, AccountBirthday, AccountPurpose, InputSource,
        WalletCommitmentTrees, WalletRead, WalletWrite,
    },
    util::SystemClock,
};
use zcash_client_sqlite::{wallet::init::init_wallet_db, AccountUuid, WalletDb};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::{builder::cached_orchard_proving_key, Transaction, TxId};
use zcash_protocol::{
    consensus::{BlockHeight, Network},
    ShieldedPool,
};

type Db = WalletDb<rusqlite::Connection, Network, SystemClock, ThreadRng>;

/// Anchor depth stock wallets use: the anchor is the tree as of `target - 3`.
const ANCHOR_CONFIRMATIONS: u32 = 3;

#[derive(Parser)]
#[command(name = "cadence-runner", about = "Executes pre-signed Cadence installments")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, ValueEnum)]
enum Net {
    Main,
    Test,
}

impl Net {
    fn params(self) -> Network {
        match self {
            Net::Main => Network::MainNetwork,
            Net::Test => Network::TestNetwork,
        }
    }
}

#[derive(Args)]
struct Common {
    #[arg(long, default_value = "runner.sqlite")]
    db: PathBuf,
    #[arg(long, value_enum, default_value = "test")]
    network: Net,
    /// lightwalletd endpoint.
    #[arg(long, default_value = "https://testnet.zec.rocks:443")]
    server: String,
    /// Connect without Tor. Development only.
    #[arg(long)]
    direct: bool,
    #[arg(long, default_value = ".cadence/runner-tor")]
    tor_dir: PathBuf,
}

impl Common {
    async fn connect(&self) -> Result<lwd::Client> {
        let transport = if self.direct {
            Transport::Direct
        } else {
            Transport::Tor { dir: &self.tor_dir }
        };
        cadence_chain::connect(&self.server, transport).await
    }

    fn open_db(&self) -> Result<Db> {
        Ok(WalletDb::for_path(
            &self.db,
            self.network.params(),
            SystemClock,
            rand::rng(),
        )?)
    }
}

#[derive(Subcommand)]
enum Command {
    /// Create the runner's wallet database.
    Init {
        #[command(flatten)]
        common: Common,
    },
    /// Import a pocket UFVK. The runner never receives a spending key.
    Import {
        #[command(flatten)]
        common: Common,
        #[arg(long)]
        ufvk: String,
        /// Last block before the pocket could have been funded.
        #[arg(long)]
        birthday: u32,
    },
    /// Scan the chain up to the tip.
    Sync {
        #[command(flatten)]
        common: Common,
    },
    /// Execute a ladder's installments in order as each falls due.
    Run {
        #[command(flatten)]
        common: Common,
        #[arg(long)]
        ladder: PathBuf,
        /// Seconds between chain polls.
        #[arg(long, default_value_t = 10)]
        poll: u64,
    },
}

async fn sync(client: &mut lwd::Client, params: &Network, db: &mut Db) -> Result<()> {
    let cache = MemBlockCache::default();
    zcash_client_backend::sync::run(client, params, &cache, db, 1000)
        .await
        .map_err(|e| anyhow!("sync failed: {e:?}"))
}

fn single_pocket(db: &Db) -> Result<(AccountUuid, FullViewingKey)> {
    let ufvks = db.get_unified_full_viewing_keys()?;
    let (account, ufvk) = ufvks.into_iter().next().context("no pocket has been imported")?;
    let fvk = ufvk.orchard().context("pocket UFVK has no Orchard key")?.clone();
    Ok((account, fvk))
}

/// Where the note an installment spends currently stands.
enum Input {
    /// Unspent, at this tree position, mined at this height.
    Unspent { position: Position, mined: BlockHeight },
    /// Not (yet) known to the wallet as an unspent note.
    Absent,
}

fn locate_input(
    db: &Db,
    account: AccountUuid,
    fvk: &FullViewingKey,
    nf: &Nullifier,
    target: BlockHeight,
) -> Result<Input> {
    let notes = db.select_unspent_notes(
        account,
        &[ShieldedPool::Ironwood],
        target.into(),
        &[],
        LockFilter::Unfiltered,
    )?;
    for rn in notes.ironwood() {
        if rn.note().nullifier(fvk) == *nf {
            let mined = rn.mined_height().context("unspent note without a mined height")?;
            return Ok(Input::Unspent {
                position: rn.note_commitment_tree_position(),
                mined,
            });
        }
    }
    Ok(Input::Absent)
}

fn anchor_and_witness(db: &mut Db, position: Position, at: BlockHeight) -> Result<(Anchor, MerklePath)> {
    db.with_ironwood_tree_mut::<_, _, anyhow::Error>(|tree| {
        let root = tree
            .root_at_checkpoint_id(&at)?
            .ok_or_else(|| anyhow!("no Ironwood checkpoint at {at}"))?;
        let path = tree
            .witness_at_checkpoint_id_caching(position, &at)?
            .ok_or_else(|| anyhow!("no witness for position {position:?} at {at}"))?;
        Ok((Anchor::from(root), MerklePath::from(path)))
    })?
    .ok_or_else(|| anyhow!("the wallet has no Ironwood tree"))
}

fn describe(tx: &Transaction, mined: Option<BlockHeight>) -> String {
    let ironwood = tx.ironwood_bundle();
    let transparent = tx
        .transparent_bundle()
        .map(|b| (b.vin.len(), b.vout.len()))
        .unwrap_or((0, 0));
    format!(
        "{:?} branch {:08x}, expiry {}{}, transparent in/out {}/{}, sapling {}, orchard {}, ironwood actions {}, fee {} zats",
        tx.version(),
        u32::from(tx.consensus_branch_id()),
        u32::from(tx.expiry_height()),
        mined
            .map(|h| format!(" (expiry - mined = {})", u32::from(tx.expiry_height()) - u32::from(h)))
            .unwrap_or_default(),
        transparent.0,
        transparent.1,
        tx.sapling_bundle().is_some(),
        tx.orchard_bundle().is_some(),
        ironwood.map(|b| b.actions().len()).unwrap_or(0),
        ironwood.map(|b| i64::from(*b.value_balance())).unwrap_or(0),
    )
}

async fn release(
    common: &Common,
    client: &mut lwd::Client,
    db: &mut Db,
    inst: &InstallmentLadder,
    poll: Duration,
) -> Result<Option<TxId>> {
    let params = common.network.params();
    let (account, fvk) = single_pocket(db)?;
    let nf_bytes: [u8; 32] = hex::decode(&inst.spends_nullifier)?
        .try_into()
        .map_err(|_| anyhow!("nullifier must be 32 bytes"))?;
    let nf = Option::from(Nullifier::from_bytes(&nf_bytes)).context("invalid nullifier")?;
    let mut seen_unspent = false;

    loop {
        sync(client, &params, db).await?;
        let tip = lwd::tip(client).await?;
        let target = tip + 1;
        let anchor_height = target - ANCHOR_CONFIRMATIONS;

        let (position, mined) = match locate_input(db, account, &fvk, &nf, target)? {
            Input::Unspent { position, mined } => {
                seen_unspent = true;
                if mined > anchor_height {
                    println!("installment {}: input mined at {mined}, waiting for anchor depth", inst.k);
                    tokio::time::sleep(poll).await;
                    continue;
                }
                (position, mined)
            }
            Input::Absent if seen_unspent => {
                println!("installment {}: its input was spent elsewhere; mandate cancelled", inst.k);
                return Ok(None);
            }
            Input::Absent => {
                println!("installment {}: input not yet on chain, waiting", inst.k);
                tokio::time::sleep(poll).await;
                continue;
            }
        };

        // Fail closed: never broadcast an expiry other than the one a fresh send
        // at this height would carry.
        let Some(rung) = inst.rungs.iter().find(|r| r.target_height == u32::from(target)) else {
            bail!(
                "installment {}: no rung signed for target {target}; the payer must re-sign",
                inst.k
            );
        };

        let (anchor, witness) = anchor_and_witness(db, position, anchor_height)?;
        let independent = lwd::tree_state(client, anchor_height).await?;
        let independent_root = Anchor::from(independent.ironwood_tree()?.root());
        if independent_root != anchor {
            bail!("the wallet's Ironwood root at {anchor_height} disagrees with lightwalletd");
        }

        let pczt = Pczt::parse(&hex::decode(&rung.pczt)?).map_err(|e| anyhow!("{e:?}"))?;
        let spend_action = pczt
            .ironwood()
            .actions()
            .iter()
            .position(|a| a.spend().witness().is_none())
            .context("rung has no deferred spend")?;
        let pczt = Updater::new(pczt)
            .set_ironwood_anchor(anchor)
            .map_err(|e| anyhow!("setting anchor: {e:?}"))?
            .set_ironwood_spend_witnesses([(spend_action, witness)])
            .map_err(|e| anyhow!("setting witness: {e:?}"))?
            .finish();

        let mut rng = ChaCha20Rng::from_rng(&mut rand::rng());
        let pk = cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3);
        let pczt = Prover::new(pczt)
            .create_ironwood_proof(&mut rng, pk)
            .map_err(|e| anyhow!("proving: {e:?}"))?
            .finish();
        let tx = TransactionExtractor::new(pczt)
            .extract(&mut rng)
            .map_err(|e| anyhow!("extracting: {e:?}"))?;
        let txid = tx.txid();
        let mut bytes = vec![];
        tx.write(&mut bytes)?;
        lwd::send(client, bytes).await?;
        println!(
            "installment {}: broadcast {txid} for target {target} (input mined at {mined}, anchor {anchor_height})",
            inst.k
        );

        loop {
            tokio::time::sleep(poll).await;
            match lwd::transaction(client, &params, &txid).await {
                Ok((tx, Some(height))) => {
                    println!("installment {}: mined at {height}: {}", inst.k, describe(&tx, Some(height)));
                    return Ok(Some(txid));
                }
                Ok((_, None)) => {}
                Err(e) => println!("installment {}: not yet visible ({e})", inst.k),
            }
            if lwd::tip(client).await? > BlockHeight::from_u32(rung.expiry_height) {
                bail!("installment {} expired unmined", inst.k);
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Init { common } => {
            let mut db = common.open_db()?;
            init_wallet_db(&mut db, None).map_err(|e| anyhow!("initialising wallet db: {e:?}"))?;
            println!("initialised {}", common.db.display());
        }
        Command::Import { common, ufvk, birthday } => {
            let params = common.network.params();
            let ufvk = UnifiedFullViewingKey::decode(&params, &ufvk).map_err(|e| anyhow!(e))?;
            if ufvk.p2pkh().is_some() || ufvk.p2sh().is_some() || ufvk.sapling().is_some() {
                bail!("refusing a pocket UFVK with transparent or Sapling components");
            }
            let mut client = common.connect().await?;
            let tree = lwd::tree_state(&mut client, BlockHeight::from_u32(birthday)).await?;
            let birthday = AccountBirthday::from_treestate(tree, None)
                .map_err(|e| anyhow!("birthday: {e:?}"))?;
            let mut db = common.open_db()?;
            // `Spending` with no derivation makes the wallet keep witnesses for the
            // pocket's notes; it still holds no spending key (the UFVK has none).
            db.import_account_ufvk(
                "cadence-pocket",
                &ufvk,
                &birthday,
                AccountPurpose::Spending { derivation: None },
                None,
            )?;
            println!("imported pocket with birthday {}", u32::from(birthday.height()));
        }
        Command::Sync { common } => {
            let mut client = common.connect().await?;
            let mut db = common.open_db()?;
            sync(&mut client, &common.network.params(), &mut db).await?;
            let (_, anchor) = db
                .get_target_and_anchor_heights(NonZeroU32::new(ANCHOR_CONFIRMATIONS).unwrap())?
                .context("no blocks scanned")?;
            println!("synced; anchor height {anchor}");
        }
        Command::Run { common, ladder, poll } => {
            let ladder: Ladder = serde_json::from_slice(&fs::read(&ladder)?)?;
            let mut client = common.connect().await?;
            let mut db = common.open_db()?;
            let poll = Duration::from_secs(poll);
            for inst in &ladder.installments {
                if release(&common, &mut client, &mut db, inst, poll).await?.is_none() {
                    break;
                }
            }
        }
    }
    Ok(())
}
