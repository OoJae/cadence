//! The light wallet shared by the payer and the runner.
//!
//! Pockets are imported from their Orchard-only UFVK with
//! `AccountPurpose::Spending { derivation: None }`: the wallet keeps the witnesses
//! needed to spend, but it never holds a spending key. Signing always happens
//! elsewhere (the payer, ahead of time), and this module only installs the anchor
//! and witness that ZIP 374 defers to proving time, proves, and extracts.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use incrementalmerkletree::Position;
use orchard::{
    circuit::OrchardCircuitVersion, keys::FullViewingKey, note::Nullifier, tree::MerklePath,
    Anchor, Note,
};
use pczt::{
    roles::{prover::Prover, tx_extractor::TransactionExtractor, updater::Updater},
    Pczt,
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use zcash_client_backend::{
    data_api::{
        wallet::input_selection::LockFilter, Account as _, AccountBirthday, AccountPurpose, InputSource,
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

use crate::{lwd, MemBlockCache};

pub type OsRng = UnwrapErr<SysRng>;
pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

/// Stock wallets anchor three blocks behind the block they target.
pub const ANCHOR_CONFIRMATIONS: u32 = 3;

pub fn open(path: &Path, params: Network) -> Result<Db> {
    let conn = rusqlite::Connection::open(path)?;
    rusqlite::vtab::array::load_module(&conn)?;
    // A deleted pocket's keys and notes are overwritten on disk, not just unlinked.
    conn.pragma_update(None, "secure_delete", "ON")?;
    Ok(WalletDb::from_connection(conn, params, SystemClock, UnwrapErr(SysRng)))
}

/// Rewrites the wallet file so that no free page still holds a deleted pocket's
/// keys or notes. Call it before [`open`], while nothing else has the file open.
pub fn compact(path: &Path) -> Result<()> {
    if path.exists() {
        let conn = rusqlite::Connection::open(path)?;
        conn.pragma_update(None, "secure_delete", "ON")?;
        conn.execute_batch("VACUUM")?;
    }
    Ok(())
}

pub fn init(db: &mut Db) -> Result<()> {
    init_wallet_db(db, None).map_err(|e| anyhow!("initialising wallet db: {e:?}"))
}

/// Imports a pocket, refusing any UFVK that could see beyond the pocket's Orchard key.
pub async fn import_pocket(
    client: &mut lwd::Client,
    db: &mut Db,
    params: &Network,
    ufvk: &str,
    birthday: BlockHeight,
    name: &str,
) -> Result<AccountUuid> {
    let ufvk = UnifiedFullViewingKey::decode(params, ufvk).map_err(|e| anyhow!(e))?;
    if ufvk.p2pkh().is_some() || ufvk.p2sh().is_some() || ufvk.sapling().is_some() {
        bail!("a pocket UFVK must contain only an Orchard key");
    }
    if ufvk.orchard().is_none() {
        bail!("a pocket UFVK must contain an Orchard key");
    }
    let tree = lwd::tree_state(client, birthday - 1).await?;
    let birthday = AccountBirthday::from_treestate(tree, None).map_err(|e| anyhow!("birthday: {e:?}"))?;
    let account = db.import_account_ufvk(
        name,
        &ufvk,
        &birthday,
        AccountPurpose::Spending { derivation: None },
        None,
    )?;
    Ok(account.id())
}

pub async fn sync(client: &mut lwd::Client, params: &Network, db: &mut Db) -> Result<()> {
    let cache = MemBlockCache::default();
    zcash_client_backend::sync::run(client, params, &cache, db, 1000)
        .await
        .map_err(|e| anyhow!("sync failed: {e:?}"))
}

pub fn pocket_fvk(db: &Db, account: AccountUuid) -> Result<FullViewingKey> {
    let ufvks = db.get_unified_full_viewing_keys()?;
    let ufvk = ufvks.get(&account).context("unknown pocket account")?;
    Ok(ufvk.orchard().context("pocket UFVK has no Orchard key")?.clone())
}

/// An unspent Ironwood note of a pocket.
pub struct PocketNote {
    pub note: Note,
    pub position: Position,
    pub mined: BlockHeight,
    /// The transaction that created the note.
    pub txid: TxId,
}

pub fn unspent_notes(db: &Db, account: AccountUuid, target: BlockHeight) -> Result<Vec<PocketNote>> {
    let notes = db.select_unspent_notes(
        account,
        &[ShieldedPool::Ironwood],
        target.into(),
        &[],
        LockFilter::Unfiltered,
    )?;
    // Notes from unmined transactions have no position in the tree yet; skip them.
    Ok(notes
        .ironwood()
        .iter()
        .filter_map(|rn| {
            Some(PocketNote {
                note: *rn.note(),
                position: rn.note_commitment_tree_position(),
                mined: rn.mined_height()?,
                txid: *rn.txid(),
            })
        })
        .collect())
}

/// The unspent pocket note with nullifier `nf`, if the wallet has seen it.
pub fn find_unspent(
    db: &Db,
    account: AccountUuid,
    fvk: &FullViewingKey,
    nf: &Nullifier,
    target: BlockHeight,
) -> Result<Option<PocketNote>> {
    Ok(unspent_notes(db, account, target)?
        .into_iter()
        .find(|n| n.note.nullifier(fvk) == *nf))
}

/// The tree as of the end of block `at`, and the note's witness against it.
///
/// The wallet only checkpoints blocks where its view of the tree changes, so, like
/// stock wallets (`get_max_checkpointed_height`), this uses the highest checkpoint at
/// or below `at`. Blocks without Ironwood commitments leave the root unchanged, so the
/// anchor is the root at `at` exactly; [`check_anchor`] confirms that independently.
pub fn anchor_and_witness(db: &mut Db, position: Position, at: BlockHeight) -> Result<(Anchor, MerklePath)> {
    db.with_ironwood_tree_mut::<_, _, anyhow::Error>(|tree| {
        for depth in 0..=100u32 {
            let h = at - depth;
            if let Some(root) = tree.root_at_checkpoint_id(&h)? {
                let path = tree
                    .witness_at_checkpoint_id_caching(position, &h)?
                    .ok_or_else(|| anyhow!("no witness for position {position:?} at {h}"))?;
                return Ok((Anchor::from(root), MerklePath::from(path)));
            }
        }
        Err(anyhow!("no Ironwood checkpoint within 100 blocks below {at}"))
    })?
    .ok_or_else(|| anyhow!("the wallet has no Ironwood tree"))
}

/// Refuses an anchor the server's independent tree state does not confirm.
pub async fn check_anchor(client: &mut lwd::Client, anchor: &Anchor, at: BlockHeight) -> Result<()> {
    let tree = lwd::tree_state(client, at).await?;
    if Anchor::from(tree.ironwood_tree()?.root()) != *anchor {
        bail!("the wallet's Ironwood root at {at} disagrees with lightwalletd");
    }
    Ok(())
}

/// Installs the deferred anchor and the real spend's witness into a signed PCZT,
/// proves it, and extracts the transaction (which verifies every proof and signature).
pub fn complete(pczt: Pczt, anchor: Anchor, witness: MerklePath) -> Result<Transaction> {
    let spend_action = pczt
        .ironwood()
        .actions()
        .iter()
        .position(|a| a.spend().witness().is_none())
        .context("the PCZT has no deferred spend")?;
    let pczt = Updater::new(pczt)
        .set_ironwood_anchor(anchor)
        .map_err(|e| anyhow!("setting anchor: {e:?}"))?
        .set_ironwood_spend_witnesses([(spend_action, witness)])
        .map_err(|e| anyhow!("setting witness: {e:?}"))?
        .finish();
    let mut rng = UnwrapErr(SysRng);
    let pk = cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3);
    let pczt = Prover::new(pczt)
        .create_ironwood_proof(&mut rng, pk)
        .map_err(|e| anyhow!("proving: {e:?}"))?
        .finish();
    TransactionExtractor::new(pczt)
        .extract(&mut rng)
        .map_err(|e| anyhow!("extracting: {e:?}"))
}

pub async fn broadcast(client: &mut lwd::Client, tx: &Transaction) -> Result<TxId> {
    let mut bytes = vec![];
    tx.write(&mut bytes)?;
    lwd::send(client, bytes).await?;
    Ok(tx.txid())
}

/// Pays `amount` from `pocket`'s largest anchor-deep note to `to`, with change back to
/// the pocket. Every output uses Discard, and the transaction has the same shape as
/// an installment. `exclude` lists nullifiers already spent by unmined transactions.
#[allow(clippy::too_many_arguments)]
pub async fn pay(
    client: &mut lwd::Client,
    broadcaster: &mut lwd::Client,
    db: &mut Db,
    params: &Network,
    account: AccountUuid,
    pocket: &cadence_core::Pocket,
    to: orchard::Address,
    amount: zcash_protocol::value::Zatoshis,
    exclude: &[Nullifier],
) -> Result<(TxId, Nullifier)> {
    let tip = lwd::tip(client).await?;
    let target = tip + 1;
    let anchor_height = target - ANCHOR_CONFIRMATIONS;
    // The anchor must be a root this wallet has scanned. If the chain moved since the
    // last sync, catch up first, or the root would be an older one and fail the check.
    if db.block_fully_scanned()?.is_none_or(|b| b.block_height() < anchor_height) {
        sync(client, params, db).await?;
    }
    let needed = u64::from(amount) + u64::from(cadence_core::mandate::installment_fee_at(params, target));
    let input = unspent_notes(db, account, target)?
        .into_iter()
        .filter(|n| n.mined <= anchor_height && n.note.value().inner() >= needed)
        .filter(|n| !exclude.contains(&n.note.nullifier(pocket.fvk())))
        .max_by_key(|n| n.note.value().inner())
        .context("no anchor-deep note large enough")?;
    let nf = input.note.nullifier(pocket.fvk());
    let (anchor, witness) = anchor_and_witness(db, input.position, anchor_height)?;
    check_anchor(client, &anchor, anchor_height).await?;

    let mut fresh = [0u8; 32];
    rand::fill(&mut fresh);
    let inst = cadence_core::Installment {
        input: input.note,
        amount,
        merchant: to,
        memo: zcash_protocol::memo::MemoBytes::empty(),
    };
    let rung = cadence_core::build_rung(params, target, pocket, &inst, fresh)
        .map_err(|e| anyhow!("building payment: {e:?}"))?;
    let tx = tokio::task::spawn_blocking(move || complete(rung.pczt, anchor, witness)).await??;
    Ok((broadcast(broadcaster, &tx).await?, nf))
}
