//! The public shape of a transaction: every field a chain observer can use to tell
//! a Cadence installment apart from an ordinary wallet send.

pub mod fingerprint;

use orchard::{
    bundle::Authorization,
    keys::{OutgoingViewingKey, Scope},
    Bundle,
};
use serde::{Deserialize, Serialize};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::BlockHeight,
    value::{BalanceError, Zatoshis},
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

/// The outputs of `bundle` whose sender-side ciphertext opens with one of `ovks`.
/// It reads only the actions, never the proof or signatures. An output built with
/// Discard (spec P3) opens with no key, so this is how the shape shows Discard.
fn ovk_recoverable<A: Authorization, V>(bundle: &Bundle<A, V>, ovks: &[OutgoingViewingKey]) -> usize {
    bundle.recover_outputs_with_ovks(ovks).len()
}

fn zero_ovk_recoverable<A: Authorization, V>(bundle: &Bundle<A, V>) -> usize {
    ovk_recoverable(bundle, &[OutgoingViewingKey::from([0u8; 32])])
}

/// Both OVKs, external and internal, of every UFVK with an Orchard component.
fn supplied_ovks(ufvks: &[UnifiedFullViewingKey]) -> Vec<OutgoingViewingKey> {
    ufvks
        .iter()
        .filter_map(|u| u.orchard())
        .flat_map(|fvk| [fvk.to_ovk(Scope::External), fvk.to_ovk(Scope::Internal)])
        .collect()
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

    let supplied = supplied_ovks(ufvks);
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
            .map(|b| ovk_recoverable(b, &supplied))
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

#[cfg(test)]
mod tests {
    use core::convert::Infallible;

    use cadence_core::{build_rung, rung::fee_rule_at, Installment, Pocket};
    use orchard::{
        bundle::EffectsOnly,
        note::{Note, NoteVersion, RandomSeed, Rho},
        value::NoteValue,
    };
    use pczt::roles::verifier::Verifier;
    use rand::{rngs::ChaCha20Rng, SeedableRng};
    use zcash_primitives::transaction::builder::{BundlePadding, DeferredPcztBuilder};
    use zcash_protocol::{
        consensus::{MainNetwork, NetworkConstants, Parameters},
        memo::MemoBytes,
        value::ZatBalance,
    };

    use super::*;

    const TARGET: u32 = 3_530_000;

    /// A stand-in funding note, as in cadence-core's privacy tests.
    fn funding_note(pocket: &Pocket, value: u64) -> Note {
        let rho = Option::from(Rho::from_bytes(&[7u8; 32])).expect("canonical field element");
        (0u8..=255)
            .find_map(|i| {
                let rseed = Option::from(RandomSeed::from_bytes([i; 32], &rho))?;
                Option::from(Note::from_parts(pocket.funding_address(), NoteValue::from_raw(value), rho, rseed, NoteVersion::V3))
            })
            .expect("some rseed yields a valid note")
    }

    fn fixture() -> (MainNetwork, Pocket, Installment) {
        let params = MainNetwork;
        let pocket = Pocket::from_seed(&[42u8; 32], params.network_type().coin_type());
        let merchant = Pocket::from_seed(&[9u8; 32], params.network_type().coin_type()).funding_address();
        let inst = Installment {
            input: funding_note(&pocket, 100_000),
            amount: Zatoshis::const_from_u64(20_000),
            merchant,
            memo: MemoBytes::from_bytes(b"cadence:test:k=1").unwrap(),
        };
        (params, pocket, inst)
    }

    /// An installment's Ironwood bundle as its transaction carries it, less the proof
    /// and signatures, which the OVK check does not read.
    fn effects(bundle: &orchard::pczt::Bundle) -> Bundle<EffectsOnly, ZatBalance> {
        bundle.extract_effects().unwrap().expect("two actions")
    }

    /// The installment `build_rung` builds, but with these OVKs on the payment and
    /// the change instead of `None`.
    fn built_with(
        pocket: &Pocket,
        inst: &Installment,
        payment_ovk: Option<OutgoingViewingKey>,
        change_ovk: Option<OutgoingViewingKey>,
    ) -> Bundle<EffectsOnly, ZatBalance> {
        let (params, target) = (MainNetwork, BlockHeight::from_u32(TARGET));
        let fee_rule = fee_rule_at(&params, target);
        let mut b = DeferredPcztBuilder::new::<Infallible>(params, target, BundlePadding::DEFAULT, BundlePadding::DEFAULT).unwrap();
        b.add_ironwood_spend::<Infallible>(pocket.fvk().clone(), inst.input).unwrap();
        b.add_ironwood_output::<Infallible>(payment_ovk, inst.merchant, inst.amount, inst.memo.clone()).unwrap();
        let change = Zatoshis::const_from_u64(100_000 - 20_000 - 10_000);
        b.add_ironwood_output::<Infallible>(change_ovk, pocket.change_address(), change, MemoBytes::empty()).unwrap();
        let res = b.build_for_pczt(ChaCha20Rng::from_seed([1u8; 32]), &fee_rule).unwrap();
        effects(res.pczt_parts.ironwood.as_ref().unwrap())
    }

    #[test]
    fn the_ovk_check_counts_zero_for_discard_and_finds_what_an_ovk_encrypts() {
        let (params, pocket, inst) = fixture();
        let ufvk = [pocket.ufvk()];
        let pocket_ovks = supplied_ovks(&ufvk);
        assert_eq!(pocket_ovks.len(), 2);

        // A real installment, as `build_rung` signs it: nothing opens with any key.
        let rung = build_rung(&params, BlockHeight::from_u32(TARGET), &pocket, &inst, [5u8; 32]).unwrap();
        let mut signed = None;
        Verifier::new(rung.pczt)
            .with_ironwood::<Infallible, _>(|b| {
                signed = Some(effects(b));
                Ok(())
            })
            .unwrap();
        let signed = signed.unwrap();
        assert_eq!(zero_ovk_recoverable(&signed), 0);
        assert_eq!(ovk_recoverable(&signed, &pocket_ovks), 0);
        assert_eq!(ovk_recoverable(&built_with(&pocket, &inst, None, None), &pocket_ovks), 0);

        // A stock wallet's policy: both outputs open with the pocket's own OVKs.
        let (external, internal) = (pocket.fvk().to_ovk(Scope::External), pocket.fvk().to_ovk(Scope::Internal));
        let wallet = built_with(&pocket, &inst, Some(external.clone()), Some(internal));
        assert_eq!(ovk_recoverable(&wallet, &pocket_ovks), 2);
        assert_eq!(zero_ovk_recoverable(&wallet), 0);
        // Another UFVK's OVKs open none of them.
        let stranger = supplied_ovks(&[Pocket::from_seed(&[3u8; 32], 133).ufvk()]);
        assert_eq!(ovk_recoverable(&wallet, &stranger), 0);

        // An output built under the zero OVK opens with it; the payment alone here.
        let zero = built_with(&pocket, &inst, Some(OutgoingViewingKey::from([0u8; 32])), None);
        assert_eq!(zero_ovk_recoverable(&zero), 1);
        assert_eq!(ovk_recoverable(&built_with(&pocket, &inst, Some(external), None), &pocket_ovks), 1);
    }
}
