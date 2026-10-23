//! The public shape of a transaction: every field a chain observer can use to tell
//! a Cadence installment apart from an ordinary wallet send.

pub mod fingerprint;

use orchard::{
    bundle::Authorized,
    keys::{OutgoingViewingKey, Scope},
    Bundle,
};
use serde::{Deserialize, Serialize};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::BlockHeight,
    value::{BalanceError, ZatBalance, Zatoshis},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shape {
    pub txid: String,
    pub version: String,
    pub branch_id: String,
    pub lock_time: u32,
    pub expiry_height: u32,
    pub mined_height: Option<u32>,
    /// `expiry - mined`; a fresh send mined in its target block shows the full delta.
    pub expiry_minus_mined: Option<i64>,
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    pub ironwood_flags: Option<u8>,
    /// Ironwood value balance; equals the fee when value only moves within Ironwood.
    pub ironwood_value_balance: Option<i64>,
    pub ironwood_anchor: Option<String>,
    /// Heights whose Ironwood root equals the anchor. Blocks without Ironwood outputs
    /// leave the root unchanged, so an anchor is consistent with a range of heights.
    pub anchor_heights: Option<(u32, u32)>,
    /// `mined - h` over that range; stock wallets anchor 3 blocks behind their target.
    pub anchor_depths: Option<(i64, i64)>,
    pub ironwood_proof_bytes: Option<usize>,
    /// Ironwood outputs whose sender-side ciphertext opens with the all-zero OVK.
    pub zero_ovk_recoverable: usize,
    /// Ironwood outputs that open with the OVKs of the supplied UFVKs.
    pub supplied_ovk_recoverable: usize,
    // The Orchard-pool counterparts of the Ironwood fields above. They are omitted
    // when the transaction has no Orchard-pool bundle, which keeps the output for an
    // Ironwood-only transaction unchanged. Before Ironwood activated (NU6.3: mainnet
    // 3,428,143, testnet 4,134,000) the Orchard pool is where stock wallets' shielded
    // sends lived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_flags: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_value_balance: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_anchor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_anchor_heights: Option<(u32, u32)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_anchor_depths: Option<(i64, i64)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_proof_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchard_zero_ovk_recoverable: Option<usize>,
}

/// An Ironwood output that a supplied viewing key can decrypt: what that key's
/// wallet shows for the transaction (for an installment and the merchant's UFVK,
/// exactly what the merchant learns from it).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Received {
    /// `external` (a payment to one of the key's addresses) or `internal` (change).
    pub scope: String,
    pub value_zat: u64,
    /// ZIP 302: the text, `(empty)`, or `(binary, N bytes)`.
    pub memo: String,
}

/// Decrypts every Ironwood output with the incoming viewing keys of `ufvks`.
pub fn received(tx: &Transaction, ufvks: &[UnifiedFullViewingKey]) -> Vec<Received> {
    let Some(bundle) = tx.ironwood_bundle() else { return vec![] };
    let mut out = vec![];
    for fvk in ufvks.iter().filter_map(|u| u.orchard()) {
        for (scope, name) in [(Scope::External, "external"), (Scope::Internal, "internal")] {
            let ivk = fvk.to_ivk(scope);
            for (_, _, note, _, memo) in bundle.decrypt_outputs_with_keys(core::slice::from_ref(&ivk)) {
                out.push(Received {
                    scope: name.into(),
                    value_zat: note.value().inner(),
                    memo: memo_text(&memo),
                });
            }
        }
    }
    out
}

fn memo_text(bytes: &[u8; 512]) -> String {
    use zcash_protocol::memo::{Memo, MemoBytes};
    match MemoBytes::from_bytes(bytes).ok().and_then(|m| Memo::try_from(m).ok()) {
        Some(Memo::Text(text)) => text.to_string(),
        Some(Memo::Empty) => "(empty)".into(),
        _ => {
            let len = bytes.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
            format!("(binary, {len} bytes)")
        }
    }
}

/// For each Orchard-family pool, the heights whose tree root equals that bundle's anchor.
#[derive(Clone, Copy, Debug, Default)]
pub struct AnchorRanges {
    pub orchard: Option<(BlockHeight, BlockHeight)>,
    pub ironwood: Option<(BlockHeight, BlockHeight)>,
}

/// The shape with only the Ironwood anchor located (the original decoder behaviour).
pub fn shape(
    tx: &Transaction,
    mined: Option<BlockHeight>,
    anchor_heights: Option<(BlockHeight, BlockHeight)>,
    ufvks: &[UnifiedFullViewingKey],
) -> Shape {
    shape_with_ranges(
        tx,
        mined,
        AnchorRanges {
            orchard: None,
            ironwood: anchor_heights,
        },
        ufvks,
    )
}

fn depths(mined: Option<BlockHeight>, range: Option<(BlockHeight, BlockHeight)>) -> Option<(i64, i64)> {
    match (mined, range) {
        (Some(m), Some((lo, hi))) => {
            let m = i64::from(u32::from(m));
            Some((m - i64::from(u32::from(hi)), m - i64::from(u32::from(lo))))
        }
        _ => None,
    }
}

fn zero_ovk_recoverable(bundle: &Bundle<Authorized, ZatBalance>) -> usize {
    let zero = OutgoingViewingKey::from([0u8; 32]);
    bundle
        .recover_outputs_with_ovks(core::slice::from_ref(&zero))
        .len()
}

pub fn shape_with_ranges(
    tx: &Transaction,
    mined: Option<BlockHeight>,
    ranges: AnchorRanges,
    ufvks: &[UnifiedFullViewingKey],
) -> Shape {
    let transparent = tx.transparent_bundle();
    let sapling = tx.sapling_bundle();
    let orchard = tx.orchard_bundle();
    let ironwood = tx.ironwood_bundle();

    let supplied: Vec<OutgoingViewingKey> = ufvks
        .iter()
        .filter_map(|u| u.orchard())
        .flat_map(|fvk| [fvk.to_ovk(Scope::External), fvk.to_ovk(Scope::Internal)])
        .collect();
    let range_u32 = |r: Option<(BlockHeight, BlockHeight)>| r.map(|(lo, hi)| (u32::from(lo), u32::from(hi)));

    Shape {
        txid: tx.txid().to_string(),
        version: format!("{:?}", tx.version()),
        branch_id: format!("{:08x}", u32::from(tx.consensus_branch_id())),
        lock_time: tx.lock_time(),
        expiry_height: u32::from(tx.expiry_height()),
        mined_height: mined.map(u32::from),
        expiry_minus_mined: mined.map(|h| i64::from(u32::from(tx.expiry_height())) - i64::from(u32::from(h))),
        transparent_inputs: transparent.map(|b| b.vin.len()).unwrap_or(0),
        transparent_outputs: transparent.map(|b| b.vout.len()).unwrap_or(0),
        sapling_spends: sapling.map(|b| b.shielded_spends().len()).unwrap_or(0),
        sapling_outputs: sapling.map(|b| b.shielded_outputs().len()).unwrap_or(0),
        orchard_actions: orchard.map(|b| b.actions().len()).unwrap_or(0),
        ironwood_actions: ironwood.map(|b| b.actions().len()).unwrap_or(0),
        ironwood_flags: ironwood.and_then(|b| b.flags().to_byte(b.bundle_version())),
        ironwood_value_balance: ironwood.map(|b| i64::from(*b.value_balance())),
        ironwood_anchor: ironwood.map(|b| hex::encode(b.anchor().to_bytes())),
        anchor_heights: range_u32(ranges.ironwood),
        anchor_depths: depths(mined, ranges.ironwood),
        ironwood_proof_bytes: ironwood.map(|b| b.authorization().proof().as_ref().len()),
        zero_ovk_recoverable: ironwood.map(zero_ovk_recoverable).unwrap_or(0),
        supplied_ovk_recoverable: ironwood
            .filter(|_| !supplied.is_empty())
            .map(|b| b.recover_outputs_with_ovks(&supplied).len())
            .unwrap_or(0),
        orchard_flags: orchard.and_then(|b| b.flags().to_byte(b.bundle_version())),
        orchard_value_balance: orchard.map(|b| i64::from(*b.value_balance())),
        orchard_anchor: orchard.map(|b| hex::encode(b.anchor().to_bytes())),
        orchard_anchor_heights: range_u32(ranges.orchard),
        orchard_anchor_depths: depths(mined, ranges.orchard),
        orchard_proof_bytes: orchard.map(|b| b.authorization().proof().as_ref().len()),
        orchard_zero_ovk_recoverable: orchard.map(zero_ovk_recoverable),
    }
}

/// The fee, when it can be computed without looking up spent transparent outputs
/// (that is, when the transaction has no transparent inputs).
pub fn fee_without_prevouts(tx: &Transaction) -> Option<u64> {
    tx.fee_paid(|_| Ok::<Option<Zatoshis>, BalanceError>(None))
        .ok()
        .flatten()
        .map(u64::from)
}

/// The heights in `[mined - search, mined - 1]` whose tree root equals `anchor`, as a
/// `(lowest, highest)` range. `root_at` returns the root as of the end of a height.
pub fn matching_range(
    mined: BlockHeight,
    search: u32,
    anchor: &[u8; 32],
    mut root_at: impl FnMut(BlockHeight) -> Option<[u8; 32]>,
) -> Option<(BlockHeight, BlockHeight)> {
    let mut range: Option<(BlockHeight, BlockHeight)> = None;
    for depth in 1..=search {
        if u32::from(mined) < depth {
            break;
        }
        let h = mined - depth;
        if root_at(h).as_ref() == Some(anchor) {
            range = Some(match range {
                None => (h, h),
                Some((lo, hi)) => (lo.min(h), hi.max(h)),
            });
        }
    }
    range
}
