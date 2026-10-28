//! The sandbox faucet's payment from several notes (`build_payment`).

use cadence_core::{build_payment, rung::Error, Pocket};
use orchard::{
    note::{Note, NoteVersion, RandomSeed, Rho},
    value::NoteValue,
};
use zcash_protocol::{
    consensus::{BlockHeight, NetworkConstants, Parameters, TestNetwork},
    value::Zatoshis,
};

/// A stand-in for one of the faucet's notes; `tag` makes each one distinct.
fn note(pocket: &Pocket, value: u64, tag: u8) -> Note {
    (1u8..=255)
        .find_map(|i| {
            let rho = Option::from(Rho::from_bytes(&[tag, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?;
            let rseed = Option::from(RandomSeed::from_bytes([i; 32], &rho))?;
            Option::from(Note::from_parts(pocket.funding_address(), NoteValue::from_raw(value), rho, rseed, NoteVersion::V3))
        })
        .expect("some rho and rseed yield a valid note")
}

#[test]
fn several_small_notes_pay_what_none_could_alone() {
    let pocket = Pocket::from_seed(&[5u8; 32], TestNetwork.network_type().coin_type());
    let payee = Pocket::from_seed(&[6u8; 32], 1).funding_address();
    let target = BlockHeight::from_u32(4_550_300);
    let notes: Vec<Note> = (1..=4).map(|t| note(&pocket, 150_000, t)).collect();
    let amount = Zatoshis::const_from_u64(330_000);

    // Two notes hold 300,000: not enough for 330,000 and the fee.
    assert!(matches!(build_payment(&TestNetwork, target, &pocket, &notes[..2], payee, amount, [1; 32]), Err(Error::Value)));

    let (pczt, spends) = build_payment(&TestNetwork, target, &pocket, &notes[..3], payee, amount, [1; 32]).expect("three notes cover it");
    assert_eq!(spends.len(), 3);
    let mut sorted = spends.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), 3, "each input has its own spend action");
    let actions = pczt.ironwood().actions();
    // Three spends and two outputs (the payment and the change) fit in three actions.
    assert_eq!(actions.len(), 3);
    for &i in &spends {
        assert!(actions[i].spend().spend_auth_sig().is_some(), "every spend is signed");
        assert!(actions[i].spend().witness().is_none(), "witnesses come later, from the wallet");
    }
    // What leaves the pool is exactly the fee: 3 actions at the ZIP 317 rate.
    let fee = cadence_core::rung::fee_rule_at(&TestNetwork, target).marginal_fee().into_u64() * 3;
    assert_eq!(*pczt.ironwood().value_sum(), (fee, false), "value balance is the fee, leaving the pool");
}
