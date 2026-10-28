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
use zcash_protocol::{consensus::BlockHeight, ShieldedPool};

use crate::{lwd, MemBlockCache, Params};

pub type OsRng = UnwrapErr<SysRng>;
pub type Db = WalletDb<rusqlite::Connection, Params, SystemClock, OsRng>;

/// Stock wallets anchor three blocks behind the block they target.
pub const ANCHOR_CONFIRMATIONS: u32 = 3;

pub fn open(path: &Path, params: Params) -> Result<Db> {
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
    params: &Params,
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

pub async fn sync(client: &mut lwd::Client, params: &Params, db: &mut Db) -> Result<()> {
    let cache = MemBlockCache::default();
    zcash_client_backend::sync::run(client, params, &cache, db, 1000)
        .await
        .map_err(|e| anyhow!("sync failed: {e:?}"))
}

/// Whether some account is born by `tip`, so that a sync has blocks to scan. Sync only
/// then: zcash_client_sqlite's `update_chain_tip` panics when every birthday is above
/// the tip it is given, past `tip + 1` always, and at `tip + 1` once blocks below were
/// scanned for an account since deleted ("Split point is within the range of
/// to_insert"). A runner with no older account left is there from registering a
/// pocket, born at `tip + 1`, until the next block.
pub fn born_by(db: &Db, tip: BlockHeight) -> Result<bool> {
    Ok(db.get_wallet_birthday()?.is_some_and(|b| b <= tip))
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
    complete_spends(pczt, anchor, vec![(spend_action, witness)])
}

/// [`complete`] for a PCZT with several spends: `witnesses` pairs each spend's action
/// with its note's path to `anchor`.
pub fn complete_spends(pczt: Pczt, anchor: Anchor, witnesses: Vec<(usize, MerklePath)>) -> Result<Transaction> {
    let pczt = Updater::new(pczt)
        .set_ironwood_anchor(anchor)
        .map_err(|e| anyhow!("setting anchor: {e:?}"))?
        .set_ironwood_spend_witnesses(witnesses)
        .map_err(|e| anyhow!("setting witness: {e:?}"))?
        .finish();
    let rng = UnwrapErr(SysRng);
    let pk = cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3);
    let pczt = Prover::new(pczt)
        .create_ironwood_proof(rng, pk)
        .map_err(|e| anyhow!("proving: {e:?}"))?
        .finish();
    TransactionExtractor::new(pczt)
        .extract(rng)
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
    params: &Params,
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

/// The most notes [`pay_combining`] spends in one payment.
pub const MAX_PAYMENT_INPUTS: usize = 20;

/// [`pay`], but when no single note covers `amount` and its fee, from the fewest of
/// the largest notes that do, up to [`MAX_PAYMENT_INPUTS`]. A wallet that pays out
/// and is paid back in small amounts, as the sandbox faucet is, otherwise ends up
/// holding plenty in notes each too small to pay with. Returns every note it spent.
#[allow(clippy::too_many_arguments)]
pub async fn pay_combining(
    client: &mut lwd::Client,
    broadcaster: &mut lwd::Client,
    db: &mut Db,
    params: &Params,
    account: AccountUuid,
    pocket: &cadence_core::Pocket,
    to: orchard::Address,
    amount: zcash_protocol::value::Zatoshis,
    exclude: &[Nullifier],
) -> Result<(TxId, Vec<Nullifier>)> {
    match pay(client, broadcaster, db, params, account, pocket, to, amount, exclude).await {
        Err(e) if e.to_string() == "no anchor-deep note large enough" => {}
        other => return other.map(|(txid, nf)| (txid, vec![nf])),
    }
    let tip = lwd::tip(client).await?;
    let target = tip + 1;
    let anchor_height = target - ANCHOR_CONFIRMATIONS;
    let mut notes: Vec<_> = unspent_notes(db, account, target)?
        .into_iter()
        .filter(|n| n.mined <= anchor_height)
        .filter(|n| !exclude.contains(&n.note.nullifier(pocket.fvk())))
        .collect();
    notes.sort_by_key(|n| std::cmp::Reverse(n.note.value().inner()));
    notes.truncate(MAX_PAYMENT_INPUTS);
    let mut fresh = [0u8; 32];
    rand::fill(&mut fresh);
    // Add the next largest note until the inputs cover the amount and the fee, which
    // grows with the number of spends.
    let (pczt, spends, chosen) = (2..=notes.len())
        .find_map(|k| {
            let inputs: Vec<_> = notes[..k].iter().map(|n| n.note).collect();
            match cadence_core::build_payment(params, target, pocket, &inputs, to, amount, fresh) {
                Err(cadence_core::rung::Error::Value) => None,
                built => Some(built.map(|(pczt, spends)| (pczt, spends, k))),
            }
        })
        .context("no anchor-deep notes large enough, even together")?
        .map_err(|e| anyhow!("building payment: {e:?}"))?;
    let mut anchor = None;
    let mut witnesses = Vec::with_capacity(chosen);
    for (n, action) in notes[..chosen].iter().zip(spends) {
        let (a, witness) = anchor_and_witness(db, n.position, anchor_height)?;
        if anchor.is_some_and(|prev| prev != a) {
            bail!("the wallet gave two anchors for one height");
        }
        anchor = Some(a);
        witnesses.push((action, witness));
    }
    let anchor = anchor.context("no inputs")?;
    check_anchor(client, &anchor, anchor_height).await?;
    let spent: Vec<_> = notes[..chosen].iter().map(|n| n.note.nullifier(pocket.fvk())).collect();
    let tx = tokio::task::spawn_blocking(move || complete_spends(pczt, anchor, witnesses)).await??;
    Ok((broadcast(broadcaster, &tx).await?, spent))
}

#[cfg(test)]
mod tests {
    use incrementalmerkletree::Hashable;
    use zcash_client_backend::{
        data_api::{
            chain::{scan_cached_blocks, BlockCache, ChainState, CommitmentTreeRoot},
            scanning::{ScanPriority, ScanRange},
        },
        proto::{
            compact_formats::{ChainMetadata, CompactBlock},
            service::compact_tx_streamer_client::CompactTxStreamerClient,
        },
    };
    use zcash_keys::keys::UnifiedSpendingKey;
    use zcash_primitives::block::BlockHash;
    use zcash_protocol::consensus::{NetworkConstants, Parameters};

    use super::*;

    const NETWORK: Params = Params::Public(zcash_protocol::consensus::Network::TestNetwork);

    fn memory_wallet() -> Db {
        let mut db = open(Path::new(":memory:"), NETWORK).unwrap();
        init(&mut db).unwrap();
        db
    }

    fn pocket(byte: u8) -> cadence_core::Pocket {
        cadence_core::Pocket::from_seed(&[byte; 32], NETWORK.network_type().coin_type())
    }

    fn at(height: u32) -> BlockHeight {
        BlockHeight::from_u32(height)
    }

    /// The hash of block `height` in the tests' chain of empty blocks.
    fn hash(height: u32) -> BlockHash {
        let mut hash = [0; 32];
        hash[..4].copy_from_slice(&height.to_le_bytes());
        BlockHash(hash)
    }

    /// Scans `range` of a chain with no transactions, as a sync would.
    async fn scan_empty(db: &mut Db, range: std::ops::Range<u32>) {
        let cache = MemBlockCache::default();
        let blocks = range
            .clone()
            .map(|h| CompactBlock {
                height: h.into(),
                hash: hash(h).0.to_vec(),
                prev_hash: hash(h - 1).0.to_vec(),
                chain_metadata: Some(ChainMetadata::default()),
                ..Default::default()
            })
            .collect();
        cache.insert(blocks).await.unwrap();
        let prior = ChainState::empty(at(range.start - 1), hash(range.start - 1));
        scan_cached_blocks(&NETWORK, &cache, db, at(range.start), &prior, range.len()).unwrap();
    }

    /// The scan queue's rows, read beside the wallet's own connection.
    fn scan_queue(path: &Path) -> Vec<(u32, u32, u8)> {
        let conn = rusqlite::Connection::open(path).unwrap();
        let mut rows = conn
            .prepare("SELECT block_range_start, block_range_end, priority FROM scan_queue ORDER BY block_range_start")
            .unwrap();
        rows.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// The message of a panic `f` raises, if it does.
    fn panic_of<T>(f: impl FnOnce() -> T) -> Option<String> {
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).err()?;
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
    }

    /// A pocket account imported without lightwalletd, from an empty tree.
    fn import_offline(db: &mut Db, pocket: &cadence_core::Pocket, birthday: u32) -> AccountUuid {
        let prior = ChainState::empty(BlockHeight::from_u32(birthday - 1), hash(birthday - 1));
        let birthday = AccountBirthday::from_parts(prior, None);
        db.import_account_ufvk("test", &pocket.ufvk(), &birthday, AccountPurpose::Spending { derivation: None }, None)
            .unwrap()
            .id()
    }

    #[tokio::test]
    async fn pockets_must_be_orchard_only() {
        let mut db = memory_wallet();
        // Nothing listens on the discard port.
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:9").connect_lazy();
        let mut client = CompactTxStreamerClient::new(channel);
        let birthday = BlockHeight::from_u32(3_000_000);

        let usk = UnifiedSpendingKey::from_seed(&NETWORK, &[1; 32], zip32::AccountId::ZERO).unwrap();
        let wide = usk.to_unified_full_viewing_key().encode(&NETWORK).unwrap();
        let err = import_pocket(&mut client, &mut db, &NETWORK, &wide, birthday, "wide").await.unwrap_err();
        assert_eq!(err.to_string(), "a pocket UFVK must contain only an Orchard key");
        assert!(import_pocket(&mut client, &mut db, &NETWORK, "uview1nope", birthday, "bad").await.is_err());

        // An Orchard-only key passes, and goes on to ask for the tree before its birthday.
        let narrow = pocket(2).ufvk().encode(&NETWORK).unwrap();
        let err = import_pocket(&mut client, &mut db, &NETWORK, &narrow, birthday, "narrow").await.unwrap_err();
        assert!(!format!("{err:#}").contains("pocket UFVK"), "{err:#}");
        assert!(db.get_account_ids().unwrap().is_empty());
    }

    #[test]
    fn a_new_pocket_has_its_key_and_no_notes() {
        let mut db = memory_wallet();
        let pocket = pocket(3);
        let account = import_offline(&mut db, &pocket, 3_000_000);
        assert_eq!(pocket_fvk(&db, account).unwrap().to_bytes(), pocket.fvk().to_bytes());
        let target = BlockHeight::from_u32(3_000_100);
        assert!(unspent_notes(&db, account, target).unwrap().is_empty());
        let nf = Nullifier::from_bytes(&[0; 32]).unwrap();
        assert!(find_unspent(&db, account, pocket.fvk(), &nf, target).unwrap().is_none());
        // No block is scanned, so there is no root to anchor to.
        assert!(anchor_and_witness(&mut db, Position::from(0), BlockHeight::from_u32(3_000_050)).is_err());

        db.delete_account(account).unwrap();
        let err = pocket_fvk(&db, account).unwrap_err();
        assert_eq!(err.to_string(), "unknown pocket account");
    }

    /// A runner without a funder deletes its last pocket after blocks were scanned for
    /// it, stops syncing while the chain moves on, and registers a new pocket at the
    /// tip, born at the next block. The sync must wait for that block.
    #[tokio::test]
    async fn the_only_pocket_born_at_the_next_block_waits_for_it() {
        let dir = std::env::temp_dir().join(format!("cadence-chain-born-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet.sqlite");
        let _ = std::fs::remove_file(&path);
        let mut db = open(&path, NETWORK).unwrap();
        init(&mut db).unwrap();
        // A sync first stores the subtree roots lightwalletd reports.
        let root = orchard::tree::MerkleHashOrchard::empty_root(16.into());
        db.put_orchard_subtree_roots(0, &[CommitmentTreeRoot::from_parts(at(4_094_022), root)])
            .unwrap();

        let old = import_offline(&mut db, &pocket(5), 4_550_091);
        assert!(born_by(&db, at(4_550_091)).unwrap() && !born_by(&db, at(4_550_090)).unwrap());
        db.update_chain_tip(at(4_550_106)).unwrap();
        scan_empty(&mut db, 4_550_091..4_550_107).await;
        db.delete_account(old).unwrap();
        assert!(!born_by(&db, at(4_550_138)).unwrap(), "no account, nothing to scan");
        import_offline(&mut db, &pocket(6), 4_550_139);
        // The local runner's wallet when it panicked: Ignored, Scanned, Ignored.
        assert_eq!(
            scan_queue(&path),
            [(280_000, 4_550_091, 0), (4_550_091, 4_550_107, 10), (4_550_107, 4_550_139, 0)]
        );

        let tip = at(4_550_138);
        assert!(!born_by(&db, tip).unwrap());
        let panic = panic_of(|| db.update_chain_tip(tip)).expect("zcash_client_sqlite no longer panics here");
        assert_eq!(panic, "Split point is within the range of to_insert");
        // Further below the birthday (a lagging server's tip), a fresh wallet panics too.
        let mut fresh = memory_wallet();
        import_offline(&mut fresh, &pocket(7), 4_550_139);
        assert!(!born_by(&fresh, at(4_550_100)).unwrap());
        assert!(panic_of(|| fresh.update_chain_tip(at(4_550_100))).is_some());

        // Once the pocket's birthday is mined, the sync goes on as usual.
        let tip = at(4_550_139);
        assert!(born_by(&db, tip).unwrap());
        db.update_chain_tip(tip).unwrap();
        let ranges = db.suggest_scan_ranges().unwrap();
        assert_eq!(ranges, [ScanRange::from_parts(at(4_550_107)..at(4_550_140), ScanPriority::ChainTip)]);
        scan_empty(&mut db, 4_550_107..4_550_140).await;
        db.update_chain_tip(at(4_550_140)).unwrap();
        scan_empty(&mut db, 4_550_140..4_550_141).await;
        assert_eq!(db.block_fully_scanned().unwrap().unwrap().block_height(), at(4_550_140));
        assert!(db.suggest_scan_ranges().unwrap().is_empty());
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The testnet sandbox's funder, or any pocket still kept, is born long before.
    #[tokio::test]
    async fn an_older_account_keeps_the_sync_going() {
        let mut db = memory_wallet();
        let root = orchard::tree::MerkleHashOrchard::empty_root(16.into());
        db.put_orchard_subtree_roots(0, &[CommitmentTreeRoot::from_parts(at(4_094_022), root)])
            .unwrap();
        import_offline(&mut db, &pocket(8), 4_550_091);
        let old = import_offline(&mut db, &pocket(9), 4_550_091);
        db.update_chain_tip(at(4_550_106)).unwrap();
        scan_empty(&mut db, 4_550_091..4_550_107).await;
        db.delete_account(old).unwrap();
        import_offline(&mut db, &pocket(10), 4_550_139);
        let tip = at(4_550_138);
        assert!(born_by(&db, tip).unwrap());
        db.update_chain_tip(tip).unwrap();
        scan_empty(&mut db, 4_550_107..4_550_139).await;
        assert_eq!(db.block_fully_scanned().unwrap().unwrap().block_height(), tip);
    }

    /// The wallet of the local test runner whose scheduler panicked (build 60b910c),
    /// copied from `CADENCE_SPLIT_WALLET`, and opened as `serve` opens it.
    #[test]
    #[ignore = "set CADENCE_SPLIT_WALLET to a copy of that wallet"]
    fn the_wallet_that_panicked_syncs_once_its_pocket_is_born() {
        let source = std::env::var("CADENCE_SPLIT_WALLET").unwrap();
        let dir = std::env::temp_dir().join(format!("cadence-chain-split-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet.sqlite");
        std::fs::copy(source, &path).unwrap();
        compact(&path).unwrap();
        let mut db = open(&path, NETWORK).unwrap();
        assert_eq!(
            scan_queue(&path),
            [(280_000, 4_550_091, 0), (4_550_091, 4_550_107, 10), (4_550_107, 4_550_139, 0)]
        );

        let tip = at(4_550_138);
        assert!(!born_by(&db, tip).unwrap());
        let panic = panic_of(|| db.update_chain_tip(tip));
        assert_eq!(panic.as_deref(), Some("Split point is within the range of to_insert"));
        let tip = at(4_550_139);
        assert!(born_by(&db, tip).unwrap());
        db.update_chain_tip(tip).unwrap();
        let ranges = db.suggest_scan_ranges().unwrap();
        assert_eq!(ranges, [ScanRange::from_parts(at(4_550_107)..at(4_550_140), ScanPriority::ChainTip)]);
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compacting_keeps_the_wallet_and_skips_a_missing_one() {
        let dir = std::env::temp_dir().join(format!("cadence-chain-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet.sqlite");
        let _ = std::fs::remove_file(&path);
        compact(&path).unwrap();
        assert!(!path.exists());

        let account = {
            let mut db = open(&path, NETWORK).unwrap();
            init(&mut db).unwrap();
            import_offline(&mut db, &pocket(4), 3_000_000)
        };
        compact(&path).unwrap();
        let db = open(&path, NETWORK).unwrap();
        assert_eq!(db.get_account_ids().unwrap(), [account]);
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
