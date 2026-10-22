//! The public shape of a transaction: every field a chain observer can use to tell
//! a Cadence installment apart from an ordinary wallet send.

use orchard::keys::{OutgoingViewingKey, Scope};
use serde::Serialize;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BlockHeight;

#[derive(Serialize)]
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
}

pub fn shape(
    tx: &Transaction,
    mined: Option<BlockHeight>,
    anchor_heights: Option<(BlockHeight, BlockHeight)>,
    ufvks: &[UnifiedFullViewingKey],
) -> Shape {
    let transparent = tx.transparent_bundle();
    let sapling = tx.sapling_bundle();
    let ironwood = tx.ironwood_bundle();

    let zero = OutgoingViewingKey::from([0u8; 32]);
    let supplied: Vec<OutgoingViewingKey> = ufvks
        .iter()
        .filter_map(|u| u.orchard())
        .flat_map(|fvk| [fvk.to_ovk(Scope::External), fvk.to_ovk(Scope::Internal)])
        .collect();

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
        orchard_actions: tx.orchard_bundle().map(|b| b.actions().len()).unwrap_or(0),
        ironwood_actions: ironwood.map(|b| b.actions().len()).unwrap_or(0),
        ironwood_flags: ironwood.and_then(|b| b.flags().to_byte(b.bundle_version())),
        ironwood_value_balance: ironwood.map(|b| i64::from(*b.value_balance())),
        ironwood_anchor: ironwood.map(|b| hex::encode(b.anchor().to_bytes())),
        anchor_heights: anchor_heights.map(|(lo, hi)| (u32::from(lo), u32::from(hi))),
        anchor_depths: match (mined, anchor_heights) {
            (Some(m), Some((lo, hi))) => {
                let m = i64::from(u32::from(m));
                Some((m - i64::from(u32::from(hi)), m - i64::from(u32::from(lo))))
            }
            _ => None,
        },
        ironwood_proof_bytes: ironwood.map(|b| b.authorization().proof().as_ref().len()),
        zero_ovk_recoverable: ironwood
            .map(|b| b.recover_outputs_with_ovks(core::slice::from_ref(&zero)).len())
            .unwrap_or(0),
        supplied_ovk_recoverable: ironwood
            .filter(|_| !supplied.is_empty())
            .map(|b| b.recover_outputs_with_ovks(&supplied).len())
            .unwrap_or(0),
    }
}
