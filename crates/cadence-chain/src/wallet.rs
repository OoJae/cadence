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
    Ok(WalletDb::for_path(path, params, SystemClock, UnwrapErr(SysRng))?)
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
}

pub fn unspent_notes(db: &Db, account: AccountUuid, target: BlockHeight) -> Result<Vec<PocketNote>> {
    let notes = db.select_unspent_notes(
        account,
        &[ShieldedPool::Ironwood],
        target.into(),
        &[],
        LockFilter::Unfiltered,
    )?;
    notes
        .ironwood()
        .iter()
        .map(|rn| {
            Ok(PocketNote {
                note: *rn.note(),
                position: rn.note_commitment_tree_position(),
                mined: rn.mined_height().context("unspent note without a mined height")?,
            })
        })
        .collect()
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

pub fn anchor_and_witness(db: &mut Db, position: Position, at: BlockHeight) -> Result<(Anchor, MerklePath)> {
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
