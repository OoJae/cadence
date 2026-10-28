//! Re-signing the installments still to pay: from the pocket's live note, here the
//! change C(1) of a mined installment 1 rather than the funding note, for the same
//! release times, each later installment spending the change of the re-signed one
//! before it.

use std::sync::OnceLock;

use cadence_core::{
    build_rung,
    mandate::{self, check_chain, presign_remaining, Error, Presigned, Terms, MAINNET_FEE_SWITCH},
    package::change_of,
    seed, Installment, Pocket,
};
use orchard::{
    note::{Note, NoteVersion, RandomSeed, Rho},
    value::NoteValue,
};
use pczt::Pczt;
use zcash_protocol::{
    consensus::{BlockHeight, MainNetwork, NetworkConstants, Parameters, TestNetwork},
    value::Zatoshis,
};

const SEED: [u8; 32] = [42; 32];
const MANDATE: [u8; 16] = [1; 16];
const TIP: u32 = 4_550_000;
const NOW: u64 = 1_793_170_000;
const PERIOD: u64 = 300;
const AMOUNT: u64 = 20_000;

fn pocket() -> Pocket {
    Pocket::from_seed(&SEED, TestNetwork.network_type().coin_type())
}

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

fn terms() -> Terms {
    Terms {
        amount: Zatoshis::const_from_u64(AMOUNT),
        count: 3,
        period_secs: PERIOD,
        release_times: (0..3).map(|i| NOW + 60 + i * PERIOD).collect(),
        merchant: Pocket::from_seed(&[9u8; 32], 1).funding_address(),
        label: "Plan (pkt_test)".into(),
    }
}

/// Installment `k` as the first signing built it, from `input`, at one height.
fn first_signing(pocket: &Pocket, input: Note, k: u32, target: u32) -> cadence_core::Rung {
    let t = terms();
    let inst = Installment { input, amount: t.amount, merchant: t.merchant, memo: mandate::installment_memo(&t.label, k, t.count) };
    let s = seed::rung_seed(&seed::app_secret(pocket), &MANDATE, k, 0);
    build_rung(&TestNetwork, BlockHeight::from_u32(target), pocket, &inst, s).unwrap()
}

/// The pocket's live note once installment 1 is mined: its change C(1).
fn current_note(pocket: &Pocket) -> Note {
    let funded = mandate::funding_total(&terms()).unwrap();
    first_signing(pocket, funding_note(pocket, funded.into()), 1, TIP - 20).change.unwrap()
}

/// Installments 2 and 3, at the times they were sealed to.
fn schedule() -> Vec<(u32, u64)> {
    let t = terms();
    vec![(2, t.release_at(2)), (3, t.release_at(3))]
}

/// Installments 2 and 3 re-signed once, shared by the tests below: some 330 rungs.
fn resigned() -> &'static [Presigned] {
    static RESIGNED: OnceLock<Vec<Presigned>> = OnceLock::new();
    RESIGNED.get_or_init(|| {
        let pocket = pocket();
        let tip = BlockHeight::from_u32(TIP);
        presign_remaining(&TestNetwork, &pocket, current_note(&pocket), &terms(), &schedule(), tip, NOW, MANDATE, |_, _, _| {})
            .unwrap()
    })
}

fn parse(p: &Presigned, i: usize) -> Pczt {
    Pczt::parse(&hex::decode(&p.ladder.rungs[i].pczt).unwrap()).unwrap()
}

#[test]
fn resigning_spends_the_current_note_and_keeps_the_release_times() {
    let pocket = pocket();
    let current = current_note(&pocket);
    let resigned = resigned();
    let kept: Vec<(u32, u64)> = resigned.iter().map(|p| (p.k, p.release_at)).collect();
    assert_eq!(kept, schedule());
    assert_eq!(resigned[0].ladder.spends_nullifier, hex::encode(current.nullifier(pocket.fvk()).to_bytes()));
    // Installment 3 spends the change the re-signed installment 2 leaves.
    let c2 = change_of(&parse(&resigned[0], 0), &pocket.change_address()).unwrap();
    assert_eq!(c2.value().inner(), 60_000 - AMOUNT - 10_000);
    assert_eq!(resigned[1].ladder.spends_nullifier, hex::encode(c2.nullifier(pocket.fvk()).to_bytes()));
    // The last installment of the mandate leaves nothing.
    assert!(change_of(&parse(&resigned[1], 0), &pocket.change_address()).is_none());
    for p in resigned {
        assert!(p.ladder.rungs.iter().all(|r| r.target_height > TIP), "installment {}", p.k);
        assert_eq!(p.ladder.amount_zat, AMOUNT);
    }
    assert_eq!(check_chain(&TestNetwork, &pocket, &current, &terms(), resigned), Ok(()));
}

#[test]
fn under_the_same_fee_the_change_is_what_the_first_signing_left() {
    // The first signing's installment 2, at a height of its own window.
    let pocket = pocket();
    let first = first_signing(&pocket, current_note(&pocket), 2, TIP + 5);
    let resigned = change_of(&parse(&resigned()[0], 0), &pocket.change_address()).unwrap();
    assert_eq!(first.change.unwrap(), resigned);
}

#[test]
fn the_chain_check_catches_a_wrong_start_a_broken_link_or_another_merchant() {
    let pocket = pocket();
    let current = current_note(&pocket);
    let resigned = resigned();
    let funding = funding_note(&pocket, 90_000);
    let err = check_chain(&TestNetwork, &pocket, &funding, &terms(), resigned).unwrap_err();
    assert!(err.starts_with("installment 2 does not name the note it must spend"), "{err}");
    let err = check_chain(&TestNetwork, &pocket, &current, &terms(), &resigned[1..]).unwrap_err();
    assert!(err.starts_with("installment 3 does not name the note it must spend"), "{err}");
    let other = Terms { merchant: Pocket::from_seed(&[8u8; 32], 1).funding_address(), ..terms() };
    let err = check_chain(&TestNetwork, &pocket, &current, &other, resigned).unwrap_err();
    assert!(err.ends_with("no output pays 20000 zats to the merchant"), "{err}");
}

#[test]
fn the_pocket_must_cover_the_rest_at_the_fee_of_each_window() {
    let pocket = pocket();
    let tip = BlockHeight::from_u32(TIP);
    let short = funding_note(&pocket, 59_999);
    match presign_remaining(&TestNetwork, &pocket, short, &terms(), &schedule(), tip, NOW, MANDATE, |_, _, _| unreachable!()) {
        Err(Error::Underfunded { needed, available }) => assert_eq!((needed, available), (60_000, 59_999)),
        other => panic!("{:?}", other.map(|p| p.len())),
    }
    // After the ZIP 2009 switch the same two installments cost 2,000 zats of fee each.
    let mainnet = Pocket::from_seed(&SEED, MainNetwork.network_type().coin_type());
    let after = BlockHeight::from_u32(MAINNET_FEE_SWITCH + 1_000);
    let short = funding_note(&mainnet, 43_999);
    match presign_remaining(&MainNetwork, &mainnet, short, &terms(), &schedule(), after, NOW, MANDATE, |_, _, _| unreachable!()) {
        Err(Error::Underfunded { needed, available }) => assert_eq!((needed, available), (44_000, 43_999)),
        other => panic!("{:?}", other.map(|p| p.len())),
    }
}

#[test]
fn only_a_run_of_installments_up_to_the_last_is_resigned() {
    let pocket = pocket();
    let tip = BlockHeight::from_u32(TIP);
    let at = terms().release_at(2);
    for schedule in [vec![], vec![(2, at)], vec![(2, at), (4, at + PERIOD)], vec![(0, at), (1, at), (2, at), (3, at)]] {
        let current = current_note(&pocket);
        let result = presign_remaining(&TestNetwork, &pocket, current, &terms(), &schedule, tip, NOW, MANDATE, |_, _, _| unreachable!());
        assert!(matches!(result, Err(Error::Schedule(_))), "{schedule:?}");
    }
}
