//! The live mainnet mandate `sub_747f99039ba4f43c5234` (evidence/mainnet.md): four
//! weekly installments, signed on 2026-10-27 at a tip of about 3,532,623-3,532,626.
//! Its windows, recomputed with the crate's own prediction, keep installment 2 before
//! NU7's guard band, installment 3 after NU7 and installment 4 before the fee switch.

use cadence_core::mandate::{
    installment_fee, installment_fee_at, predict_height, window, MAINNET_FEE_SWITCH, NU7_BLOCK_SECS, NU7_GUARD_BLOCKS,
    PRE_NU7_BLOCK_SECS,
};
use zcash_protocol::consensus::{BlockHeight, BranchId, MainNetwork, NetworkUpgrade, Parameters};

/// drand quicknet, which the installments are sealed to.
const QUICKNET_GENESIS: u64 = 1_692_803_367;
const QUICKNET_PERIOD: u64 = 3;

/// Each installment's release round (evidence/mainnet.md).
const ROUNDS: [u64; 4] = [33_439_021, 33_640_621, 33_842_221, 34_043_821];

/// The tips the mandate could have been signed at. Installment 1, released a minute
/// after signing, targeted 3,532,627, the block after the runner's tip.
const TIPS: core::ops::RangeInclusive<u32> = 3_532_623..=3_532_626;

/// The web app releases installment 1 at the first round at or after `signed_at` + 60
/// and asks for each window with `at = signed_at + 60 + (k - 1) * period`, taking
/// `now` a moment after `signed_at` (web/src/signer/wasm.ts).
const LEAD: u64 = 60;
const WEEK: u64 = 7 * 24 * 3600;

fn round_time(round: u64) -> u64 {
    QUICKNET_GENESIS + (round - 1) * QUICKNET_PERIOD
}

/// Unix time of `hh:mm:ss` UTC on a proleptic Gregorian date.
fn utc(y: i64, m: i64, d: i64, (hh, mm, ss): (i64, i64, i64)) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    (days * 86_400 + hh * 3600 + mm * 60 + ss) as u64
}

fn nu7() -> u32 {
    u32::from(MainNetwork.activation_height(NetworkUpgrade::Nu7).unwrap())
}

/// `(now, at)` for installment `k`, with `now` taken `lag` seconds after `signed_at`.
/// Only `at - now` matters, so `signed_at` is put at installment 1's release less the lead.
fn now_and_at(k: u32, lag: u64) -> (u64, u64) {
    let signed_at = round_time(ROUNDS[0]) - LEAD;
    (signed_at + lag, signed_at + LEAD + u64::from(k - 1) * WEEK)
}

fn window_k(k: u32, tip: u32, lag: u64) -> Vec<u32> {
    let (now, at) = now_and_at(k, lag);
    window(&MainNetwork, BlockHeight::from_u32(tip), now, at).into_iter().map(u32::from).collect()
}

fn predicted_k(k: u32, tip: u32, lag: u64) -> u32 {
    let (now, at) = now_and_at(k, lag);
    u32::from(predict_height(&MainNetwork, BlockHeight::from_u32(tip), now, at))
}

#[test]
fn release_rounds_fall_weekly_at_17_00_27_utc() {
    let days = [(10, 27), (11, 3), (11, 10), (11, 17)];
    for (round, (m, d)) in ROUNDS.iter().zip(days) {
        assert_eq!(round_time(*round), utc(2026, m, d, (17, 0, 27)), "round {round}");
    }
    assert_eq!(round_time(ROUNDS[1]), 1_793_725_227);
    assert_eq!(round_time(ROUNDS[2]), 1_794_330_027);
    assert_eq!(round_time(ROUNDS[3]), 1_794_934_827);
    for k in 1..4 {
        assert_eq!(round_time(ROUNDS[k]) - round_time(ROUNDS[k - 1]), WEEK);
    }
}

#[test]
fn live_mandate_windows_avoid_nu7_and_the_fee_switch() {
    let nu7 = nu7();
    assert_eq!(nu7, 3_543_405);
    assert_eq!((PRE_NU7_BLOCK_SECS, NU7_BLOCK_SECS, NU7_GUARD_BLOCKS, MAINNET_FEE_SWITCH), (75, 25, 10, 3_590_000));
    let guard_band = nu7 - NU7_GUARD_BLOCKS;

    // From the latest tip it could have been signed at, with `now` at `signed_at`. The
    // runner holds these rungs, so `window` and `predict_height` must not move them.
    let span = |w: &[u32]| (w[0], *w.last().unwrap());
    assert_eq!(span(&window_k(2, 3_532_626, 0)), (3_540_241, 3_541_360));
    assert_eq!(span(&window_k(3, 3_532_626, 0)), (3_558_521, 3_560_795));
    assert_eq!(span(&window_k(4, 3_532_626, 0)), (3_582_223, 3_585_719));

    let mut worst = [u32::MAX; 4];
    for tip in TIPS {
        for lag in 0..=120 {
            let w: Vec<Vec<u32>> = (1..=4).map(|k| window_k(k, tip, lag)).collect();
            for (i, w) in w.iter().enumerate() {
                let (lo, hi) = span(w);
                // No guard band or side rule cut a hole in any of them.
                assert_eq!(w.len() as u32, hi - lo + 1, "installment {}: window has gaps", i + 1);
            }
            // Installment 1 went out at the height it targeted.
            assert!(w[0].contains(&3_532_627));

            let (k2, k3, k4) = (span(&w[1]), span(&w[2]), span(&w[3]));
            assert!(k2.1 < guard_band, "tip {tip}, lag {lag}: installment 2 reaches {}", k2.1);
            assert!(k3.0 >= nu7, "tip {tip}, lag {lag}: installment 3 starts at {}", k3.0);
            assert!(k4.1 < MAINNET_FEE_SWITCH, "tip {tip}, lag {lag}: installment 4 reaches {}", k4.1);
            for h in &w[1] {
                assert_eq!(BranchId::for_height(&MainNetwork, BlockHeight::from_u32(*h)), BranchId::Nu6_3);
            }
            for h in w[2].iter().chain(&w[3]) {
                assert_eq!(BranchId::for_height(&MainNetwork, BlockHeight::from_u32(*h)), BranchId::Nu7);
            }
            // Every rung pays the fee the funding covers.
            for h in w.iter().flatten() {
                assert_eq!(installment_fee_at(&MainNetwork, BlockHeight::from_u32(*h)), installment_fee());
            }

            let margins = [guard_band - k2.1, k3.0 - nu7, k3.1 - predicted_k(3, tip, lag), MAINNET_FEE_SWITCH - k4.1];
            for (w, m) in worst.iter_mut().zip(margins) {
                *w = (*w).min(m);
            }
        }
    }

    let hours = |blocks: u32, secs: u64| f64::from(blocks) * secs as f64 / 3600.0;
    println!("installment 2: last rung {} blocks ({:.1} h) below the guard band", worst[0], hours(worst[0], PRE_NU7_BLOCK_SECS));
    println!("installment 3: first rung {} blocks ({:.1} h) after NU7", worst[1], hours(worst[1], NU7_BLOCK_SECS));
    println!("installment 3: last rung {} blocks ({:.1} h) above its prediction", worst[2], hours(worst[2], NU7_BLOCK_SECS));
    println!("installment 4: last rung {} blocks ({:.1} h) below the fee switch", worst[3], hours(worst[3], NU7_BLOCK_SECS));
    // The tightest is installment 3's slack above its prediction: if NU7 activates about
    // 9 h earlier than predicted, the chain is that many 25 s blocks ahead when it is
    // released, its window has passed, and it is missed.
    assert!(worst[0] > 2_000 && worst[1] > 15_000 && worst[2] > 1_300 && worst[3] > 4_200, "{worst:?}");
}
