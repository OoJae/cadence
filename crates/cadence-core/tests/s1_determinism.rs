//! S1: every rung of an installment must contain byte-identical Ironwood actions
//! and the same change note, whatever its target height, including across the
//! NU7 activation; only the expiry, branch and sighash may differ.

use cadence_core::{build_rung, seed, Installment, Pocket};
use orchard::{
    note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho},
    value::NoteValue,
};
use zcash_protocol::{
    consensus::{BlockHeight, MainNetwork, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

const NU6_3_BRANCH: u32 = 0x37A5_165B;
const NU7_BRANCH: u32 = 0x7719_0AD9;
const NU7_MAINNET: u32 = 3_543_405;

/// A stand-in for the funding note F; it is never mined, so these tests only build
/// and sign, which needs no witness.
fn funding_note(pocket: &Pocket, value: u64) -> Note {
    let rho = Option::from(Rho::from_bytes(&[7u8; 32])).expect("canonical field element");
    (0u8..=255)
        .find_map(|i| {
            let rseed = Option::from(RandomSeed::from_bytes([i; 32], &rho))?;
            Option::from(Note::from_parts(
                pocket.funding_address(),
                NoteValue::from_raw(value),
                rho,
                rseed,
                NoteVersion::V3,
            ))
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

#[test]
fn rungs_share_actions_and_change_across_heights_and_nu7() {
    let (params, pocket, inst) = fixture();
    let s = seed::rung_seed(&seed::app_secret(&pocket), &[1u8; 16], 1, 0);

    let heights = [3_530_000u32, 3_530_001, NU7_MAINNET];
    let rungs: Vec<_> = heights
        .iter()
        .map(|h| build_rung(&params, BlockHeight::from_u32(*h), &pocket, &inst, s).unwrap())
        .collect();

    for r in &rungs[1..] {
        assert_eq!(r.actions, rungs[0].actions, "actions differ at {:?}", r.target_height);
    }

    let c0 = rungs[0].change.expect("installment leaves change");
    for r in &rungs[1..] {
        let c = r.change.expect("installment leaves change");
        assert_eq!(
            ExtractedNoteCommitment::from(c.commitment()),
            ExtractedNoteCommitment::from(c0.commitment())
        );
        assert_eq!(c.nullifier(pocket.fvk()), c0.nullifier(pocket.fvk()));
        assert_eq!(c.value().inner(), 70_000);
    }

    assert_ne!(rungs[0].sighash, rungs[1].sighash);
    assert_ne!(rungs[1].sighash, rungs[2].sighash);

    assert_eq!(u32::from(rungs[0].expiry_height), 3_530_040);
    assert_eq!(u32::from(rungs[1].expiry_height), 3_530_041);
    assert_eq!(u32::from(rungs[2].expiry_height), NU7_MAINNET + 120);
    assert_eq!(u32::from(rungs[0].branch), NU6_3_BRANCH);
    assert_eq!(u32::from(rungs[2].branch), NU7_BRANCH);
    for r in &rungs {
        assert_eq!(u64::from(r.fee), 10_000);
        assert_eq!(r.actions.len(), 2);
    }
}

#[test]
fn next_installment_spends_the_previous_change() {
    let (params, pocket, inst) = fixture();
    let secret = seed::app_secret(&pocket);
    let mandate = [1u8; 16];
    let target = BlockHeight::from_u32(3_530_000);

    let r1 = build_rung(&params, target, &pocket, &inst, seed::rung_seed(&secret, &mandate, 1, 0)).unwrap();
    let c1 = r1.change.unwrap();
    let inst2 = Installment { input: c1, ..inst.clone() };
    let r2 = build_rung(&params, target + 10, &pocket, &inst2, seed::rung_seed(&secret, &mandate, 2, 0)).unwrap();

    let nf_c1 = c1.nullifier(pocket.fvk()).to_bytes();
    assert_eq!(r2.actions[r2.spend_action].nf, nf_c1);
    assert_eq!(r2.change.unwrap().value().inner(), 40_000);
}

#[test]
fn final_installment_has_no_change() {
    let (params, pocket, mut inst) = fixture();
    inst.amount = Zatoshis::const_from_u64(90_000);
    let s = seed::rung_seed(&seed::app_secret(&pocket), &[1u8; 16], 1, 0);
    let r = build_rung(&params, BlockHeight::from_u32(3_530_000), &pocket, &inst, s).unwrap();
    assert!(r.change.is_none());
    assert_eq!(r.actions.len(), 2);
}

#[test]
fn different_seeds_give_different_actions() {
    let (params, pocket, inst) = fixture();
    let secret = seed::app_secret(&pocket);
    let h = BlockHeight::from_u32(3_530_000);
    let a = build_rung(&params, h, &pocket, &inst, seed::rung_seed(&secret, &[1u8; 16], 1, 0)).unwrap();
    let b = build_rung(&params, h, &pocket, &inst, seed::rung_seed(&secret, &[1u8; 16], 1, 1)).unwrap();
    assert_ne!(a.actions, b.actions);
}
