//! A whole mandate: its schedule, the funding it needs, and its pre-signed ladders.
//!
//! This is everything the payer does, independent of where it runs (CLI or browser).
//! Release *times* are chosen here; turning them into drand rounds and sealing the
//! ladders is the caller's job (see `cadence-seal`).

use orchard::{keys::Scope, Address, Note};
use pczt::Pczt;
use zcash_primitives::transaction::{fees::zip317::MARGINAL_FEE, Transaction};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, NetworkType, NetworkUpgrade, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

use crate::{
    build_rung,
    package::{change_of, redact_for_runner, verify_rung, InstallmentLadder, RungPackage},
    seed, Installment, Pocket,
};

/// Block times used to predict when an installment's release falls on chain.
pub const PRE_NU7_BLOCK_SECS: u64 = 75;
pub const NU7_BLOCK_SECS: u64 = 25;

/// From this mainnet height wallets pay ZIP 2009's lower marginal fee: 1,000 zats per
/// action instead of 5,000, so 2,000 for an installment's two actions. Each rung pays
/// the fee for its own target height ([`crate::rung::fee_rule_at`]), and no
/// installment's window straddles the switch, so its rungs still share one change
/// note. Funding still covers the higher fee, and what an installment after the
/// switch saves stays in the pocket for the payer to sweep.
pub const MAINNET_FEE_SWITCH: u32 = 3_590_000;

/// No mainnet rung targets the last blocks before NU7. A rung signed for the old
/// branch is only valid if mined before activation, and these leave it no margin
/// for a block or two of delay.
pub const NU7_GUARD_BLOCKS: u32 = 10;

/// What the merchant's offer fixes, plus when the first installment falls due.
#[derive(Clone)]
pub struct Terms {
    pub amount: Zatoshis,
    pub count: u32,
    pub period_secs: u64,
    /// Unix time at which installment 1 becomes releasable.
    pub first_release_at: u64,
    pub merchant: Address,
    /// What the merchant's wallet shows for each installment, such as the plan name
    /// and pocket id (see [`installment_memo`]).
    pub label: String,
}

impl Terms {
    pub fn release_at(&self, k: u32) -> u64 {
        self.first_release_at + u64::from(k - 1) * self.period_secs
    }
}

#[derive(Debug)]
pub enum Error {
    Rung(crate::rung::Error),
    Encode(String),
    Underfunded { needed: u64, available: u64 },
    NoFundingNote,
    Transaction(String),
    EmptyWindow(u32),
    Schedule(String),
}

/// The memo of installment `k`: ZIP 302 text that the merchant's own wallet shows,
/// such as "Cadence · Pro plan (pkt_…) · payment 2 of 3". Only the merchant can
/// decrypt it, and it says nothing the merchant does not already know.
pub fn installment_memo(label: &str, k: u32, count: u32) -> MemoBytes {
    const MAX: usize = 512;
    let suffix = format!("payment {k} of {count}");
    let clean: String = label.chars().filter(|c| !c.is_control()).collect();
    let room = MAX - "Cadence ·  · ".len() - suffix.len();
    let mut end = clean.len().min(room);
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    let text = match clean[..end].trim() {
        "" => format!("Cadence · {suffix}"),
        label => format!("Cadence · {label} · {suffix}"),
    };
    MemoBytes::from_bytes(text.as_bytes()).expect("at most 512 bytes")
}

/// The most an installment pays: the ZIP 317 fee for two actions (payment and
/// change, or payment and padding) before the ZIP 2009 switch. Funding covers this.
pub fn installment_fee() -> Zatoshis {
    Zatoshis::const_from_u64(u64::from(MARGINAL_FEE) * 2)
}

/// The fee of an installment targeting `height`.
pub fn installment_fee_at<P: Parameters>(params: &P, height: BlockHeight) -> Zatoshis {
    let marginal = crate::rung::fee_rule_at(params, height).marginal_fee();
    Zatoshis::const_from_u64(u64::from(marginal) * 2)
}

/// The single payment that funds a whole mandate.
pub fn funding_total(terms: &Terms) -> Option<Zatoshis> {
    let per = (terms.amount + installment_fee())?;
    per * u64::from(terms.count)
}

/// Predicts the chain height at unix time `at`, from the tip seen at `now`.
pub fn predict_height<P: Parameters>(params: &P, tip: BlockHeight, now: u64, at: u64) -> BlockHeight {
    let mut height = u64::from(u32::from(tip));
    let mut remaining = at.saturating_sub(now);
    if let Some(nu7) = params.activation_height(NetworkUpgrade::Nu7) {
        let nu7 = u64::from(u32::from(nu7));
        if height < nu7 {
            let until_nu7 = (nu7 - height) * PRE_NU7_BLOCK_SECS;
            if remaining <= until_nu7 {
                return BlockHeight::from_u32((height + remaining / PRE_NU7_BLOCK_SECS) as u32);
            }
            remaining -= until_nu7;
            height = nu7;
        }
    }
    BlockHeight::from_u32((height + remaining / NU7_BLOCK_SECS) as u32)
}

/// Which side of the ZIP 2009 fee switch `h` is on (always `false` off mainnet).
fn after_fee_switch<P: Parameters>(params: &P, h: u32) -> bool {
    params.network_type() == NetworkType::Main && h >= MAINNET_FEE_SWITCH
}

fn excluded<P: Parameters>(params: &P, h: u32) -> bool {
    if params.network_type() != NetworkType::Main {
        return false;
    }
    match params.activation_height(NetworkUpgrade::Nu7) {
        Some(nu7) => {
            let nu7 = u32::from(nu7);
            (nu7.saturating_sub(NU7_GUARD_BLOCKS)..nu7).contains(&h)
        }
        None => false,
    }
}

/// Candidate target heights for an installment releasable at `at`.
///
/// The runner can't open the package before `at`, so the window starts a little
/// below the predicted height (in case blocks come fast) and runs well past it
/// (late blocks, a slow previous installment, runner downtime). It widens with the
/// distance to `at`, since block times drift over long horizons. It keeps to the
/// predicted height's side of the ZIP 2009 fee switch, so every rung pays one fee.
pub fn window<P: Parameters>(params: &P, tip: BlockHeight, now: u64, at: u64) -> Vec<BlockHeight> {
    let predicted = u32::from(predict_height(params, tip, now, at));
    let ahead = predicted.saturating_sub(u32::from(tip));
    let spread = 4.0 * f64::from(ahead).sqrt();
    let below = 10 + spread as u32 + ahead / 100;
    let above = 150 + spread as u32 + ahead / 50;
    let start = predicted.saturating_sub(below).max(u32::from(tip) + 1);
    let side = after_fee_switch(params, predicted);
    (start..=predicted + above)
        .filter(|h| after_fee_switch(params, *h) == side && !excluded(params, *h))
        .map(BlockHeight::from_u32)
        .collect()
}

/// Finds the pocket's funding note in a raw transaction.
pub fn decrypt_funding<P: Parameters>(
    params: &P,
    tx_bytes: &[u8],
    height: BlockHeight,
    pocket: &Pocket,
) -> Result<Note, Error> {
    let tx = Transaction::read(tx_bytes, BranchId::for_height(params, height))
        .map_err(|e| Error::Transaction(e.to_string()))?;
    let bundle = tx.ironwood_bundle().ok_or(Error::NoFundingNote)?;
    let ivk = pocket.fvk().to_ivk(Scope::External);
    bundle
        .decrypt_outputs_with_keys(core::slice::from_ref(&ivk))
        .into_iter()
        .map(|(_, _, note, _, _)| note)
        .find(|note| note.recipient() == pocket.funding_address())
        .ok_or(Error::NoFundingNote)
}

/// Every note `pocket` receives in `tx`: its funding (external scope) or an
/// installment's change (internal scope).
pub fn pocket_outputs(tx: &Transaction, pocket: &Pocket) -> Vec<Note> {
    let Some(bundle) = tx.ironwood_bundle() else { return vec![] };
    let ivks = [pocket.fvk().to_ivk(Scope::External), pocket.fvk().to_ivk(Scope::Internal)];
    bundle
        .decrypt_outputs_with_keys(&ivks)
        .into_iter()
        .map(|(_, _, note, _, _)| note)
        .collect()
}

/// One installment's ladder, ready to be sealed to its release time.
pub struct Presigned {
    pub k: u32,
    pub release_at: u64,
    pub ladder: InstallmentLadder,
}

/// Pre-signs every installment of a mandate funded by `funding`.
///
/// `progress(k, rungs_done, rungs_total)` is called after each rung.
#[allow(clippy::too_many_arguments)]
pub fn presign<P: Parameters + Clone>(
    params: &P,
    pocket: &Pocket,
    funding: Note,
    terms: &Terms,
    tip: BlockHeight,
    now: u64,
    mandate_id: [u8; 16],
    progress: impl FnMut(u32, usize, usize),
) -> Result<Vec<Presigned>, Error> {
    let needed = funding_total(terms).ok_or(Error::Underfunded { needed: u64::MAX, available: 0 })?;
    let available = funding.value().inner();
    if available < u64::from(needed) {
        return Err(Error::Underfunded {
            needed: needed.into(),
            available,
        });
    }
    let schedule: Vec<(u32, u64)> = (1..=terms.count).map(|k| (k, terms.release_at(k))).collect();
    let windows = windows(params, tip, now, &schedule)?;
    sign_chain(params, pocket, funding, terms, &schedule, windows, mandate_id, progress)
}

/// Re-signs the installments of a mandate still to pay, under today's rules, from
/// `current`: the pocket's live note, which is the funding note or the change of the
/// last installment mined. `schedule` lists them as `(k, release_at)`, consecutive
/// and ending at `terms.count`, each at the time its package is already sealed to.
///
/// Rung seeds are derived as the first signing derived them, so while the fee stays
/// the same each re-signed installment leaves the same change note as before. The
/// pocket must cover the rest at the fee of each installment's window.
#[allow(clippy::too_many_arguments)]
pub fn presign_remaining<P: Parameters + Clone>(
    params: &P,
    pocket: &Pocket,
    current: Note,
    terms: &Terms,
    schedule: &[(u32, u64)],
    tip: BlockHeight,
    now: u64,
    mandate_id: [u8; 16],
    progress: impl FnMut(u32, usize, usize),
) -> Result<Vec<Presigned>, Error> {
    let consecutive = schedule.windows(2).all(|pair| pair[1].0 == pair[0].0 + 1);
    match (schedule.first(), schedule.last()) {
        (Some(&(first, _)), Some(&(last, _))) if first >= 1 && last == terms.count && consecutive => {}
        _ => {
            return Err(Error::Schedule(format!(
                "the installments to re-sign must run consecutively to installment {}",
                terms.count
            )))
        }
    }
    let windows = windows(params, tip, now, schedule)?;
    let needed = windows
        .iter()
        .try_fold(0u64, |sum, heights| {
            let per = (terms.amount + installment_fee_at(params, heights[0]))?;
            sum.checked_add(per.into())
        })
        .ok_or(Error::Underfunded { needed: u64::MAX, available: 0 })?;
    let available = current.value().inner();
    if available < needed {
        return Err(Error::Underfunded { needed, available });
    }
    sign_chain(params, pocket, current, terms, schedule, windows, mandate_id, progress)
}

/// The candidate heights of each installment in `schedule`.
fn windows<P: Parameters>(
    params: &P,
    tip: BlockHeight,
    now: u64,
    schedule: &[(u32, u64)],
) -> Result<Vec<Vec<BlockHeight>>, Error> {
    schedule
        .iter()
        .map(|&(k, release_at)| {
            let heights = window(params, tip, now, release_at);
            if heights.is_empty() {
                Err(Error::EmptyWindow(k))
            } else {
                Ok(heights)
            }
        })
        .collect()
}

/// Signs the installments of `schedule` over their `windows`, the first spending
/// `input` and each later one the change of the one before.
#[allow(clippy::too_many_arguments)]
fn sign_chain<P: Parameters + Clone>(
    params: &P,
    pocket: &Pocket,
    mut input: Note,
    terms: &Terms,
    schedule: &[(u32, u64)],
    windows: Vec<Vec<BlockHeight>>,
    mandate_id: [u8; 16],
    mut progress: impl FnMut(u32, usize, usize),
) -> Result<Vec<Presigned>, Error> {
    let secret = seed::app_secret(pocket);
    let mut out = Vec::with_capacity(schedule.len());
    for (&(k, release_at), heights) in schedule.iter().zip(windows) {
        let inst = Installment {
            input,
            amount: terms.amount,
            merchant: terms.merchant,
            memo: installment_memo(&terms.label, k, terms.count),
        };
        let rung_seed = seed::rung_seed(&secret, &mandate_id, k, 0);

        let mut rungs = Vec::with_capacity(heights.len());
        let mut change = None;
        let mut spends_nullifier = [0u8; 32];
        for (i, target) in heights.iter().enumerate() {
            let rung = build_rung(params, *target, pocket, &inst, rung_seed).map_err(Error::Rung)?;
            debug_assert_eq!(rung.fee, installment_fee_at(params, *target));
            change = rung.change;
            spends_nullifier = rung.actions[rung.spend_action].nf;
            let bytes = redact_for_runner(rung.pczt)
                .serialize()
                .map_err(|e| Error::Encode(format!("{e:?}")))?;
            rungs.push(RungPackage {
                target_height: u32::from(*target),
                expiry_height: rung.expiry_height.into(),
                pczt: hex::encode(bytes),
            });
            progress(k, i + 1, heights.len());
        }

        out.push(Presigned {
            k,
            release_at,
            ladder: InstallmentLadder {
                k,
                amount_zat: terms.amount.into(),
                spends_nullifier: hex::encode(spends_nullifier),
                rungs,
            },
        });
        match change {
            Some(c) => input = c,
            None if k < terms.count => break,
            None => {}
        }
    }
    Ok(out)
}

/// Checks signed ladders before they are sealed, from their PCZTs alone: every rung
/// pays the merchant the amount with the branch and expiry of its target height
/// ([`verify_rung`]), the first installment spends `input`, all rungs of an
/// installment leave the same change, and each later installment spends the change
/// the one before it leaves.
pub fn check_chain<P: Parameters>(
    params: &P,
    pocket: &Pocket,
    input: &Note,
    terms: &Terms,
    presigned: &[Presigned],
) -> Result<(), String> {
    let mut spends = input.nullifier(pocket.fvk()).to_bytes();
    for (i, p) in presigned.iter().enumerate() {
        let k = p.k;
        if p.ladder.k != k || p.ladder.amount_zat != u64::from(terms.amount) {
            return Err(format!("installment {k}: the ladder is for another installment or amount"));
        }
        if p.ladder.spends_nullifier != hex::encode(spends) {
            return Err(format!("installment {k} does not name the note it must spend, {}", hex::encode(spends)));
        }
        if p.ladder.rungs.is_empty() {
            return Err(format!("installment {k} has no rungs"));
        }
        let mut change: Option<Option<Note>> = None;
        for rung in &p.ladder.rungs {
            let target = BlockHeight::from_u32(rung.target_height);
            let at = |why: String| format!("installment {k} at {target}: {why}");
            let bytes = hex::decode(&rung.pczt).map_err(|_| at("the PCZT is not hex".into()))?;
            let pczt = Pczt::parse(&bytes).map_err(|e| at(format!("{e:?}")))?;
            verify_rung(params, &pczt, &terms.merchant, terms.amount.into(), target).map_err(at)?;
            if *pczt.global().expiry_height() != rung.expiry_height {
                return Err(at(format!("the package says expiry {}", rung.expiry_height)));
            }
            if !pczt.ironwood().actions().iter().any(|a| *a.spend().nullifier() == spends) {
                return Err(at(format!("no action spends {}", hex::encode(spends))));
            }
            let left = change_of(&pczt, &pocket.change_address());
            match &change {
                None => change = Some(left),
                Some(first) if *first == left => {}
                Some(_) => return Err(at("this rung leaves other change than the first".into())),
            }
        }
        match change.flatten() {
            Some(c) => spends = c.nullifier(pocket.fvk()).to_bytes(),
            None if i + 1 < presigned.len() => return Err(format!("installment {k} leaves no change for the next")),
            None => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_protocol::consensus::{MainNetwork, TestNetwork};

    #[test]
    fn prediction_switches_block_time_at_nu7() {
        let nu7 = 3_543_405u32;
        let tip = BlockHeight::from_u32(nu7 - 100);
        // 100 blocks at 75 s reach NU7; 40 more at 25 s.
        let at = 100 * 75 + 40 * 25;
        assert_eq!(u32::from(predict_height(&MainNetwork, tip, 0, at)), nu7 + 40);
        // Testnet is already past NU7.
        let t = BlockHeight::from_u32(4_529_300);
        assert_eq!(u32::from(predict_height(&TestNetwork, t, 0, 250)), 4_529_310);
    }

    #[test]
    fn mainnet_windows_avoid_nu7_and_the_fee_switch() {
        let nu7 = 3_543_405u32;
        let w = window(&MainNetwork, BlockHeight::from_u32(nu7 - 30), 0, 20 * 75);
        assert!(w.iter().all(|h| !(nu7 - 10..nu7).contains(&u32::from(*h))));
        let w = window(&MainNetwork, BlockHeight::from_u32(MAINNET_FEE_SWITCH - 50), 0, 0);
        assert!(w.iter().all(|h| u32::from(*h) < MAINNET_FEE_SWITCH));
    }

    #[test]
    fn mainnet_windows_keep_to_one_side_of_the_fee_switch() {
        // Predicted just past the switch: every rung is after it.
        let tip = BlockHeight::from_u32(MAINNET_FEE_SWITCH - 20);
        let w = window(&MainNetwork, tip, 0, 30 * NU7_BLOCK_SECS);
        assert!(!w.is_empty() && w.iter().all(|h| u32::from(*h) >= MAINNET_FEE_SWITCH));
        // A monthly schedule from today still has a window for each installment.
        let today = BlockHeight::from_u32(3_525_000);
        for k in 0..3u64 {
            assert!(!window(&MainNetwork, today, 0, k * 30 * 24 * 3600).is_empty(), "installment {k}");
        }
    }

    #[test]
    fn funding_covers_every_installment_and_fee() {
        let terms = Terms {
            amount: Zatoshis::const_from_u64(100_000),
            count: 3,
            period_secs: 600,
            first_release_at: 0,
            merchant: Pocket::from_seed(&[1; 32], 133).funding_address(),
            label: String::new(),
        };
        assert_eq!(u64::from(funding_total(&terms).unwrap()), 330_000);
    }

    #[test]
    fn memos_are_zip302_text() {
        let memo = installment_memo("Pro plan (pkt_1)", 2, 3);
        let text = std::str::from_utf8(memo.as_slice()).unwrap().trim_end_matches('\0');
        assert_eq!(text, "Cadence · Pro plan (pkt_1) · payment 2 of 3");
        assert!(memo.as_slice()[0] <= 0xF4, "ZIP 302: a text memo starts below 0xF5");
        assert_eq!(
            std::str::from_utf8(installment_memo("", 1, 1).as_slice()).unwrap().trim_end_matches('\0'),
            "Cadence · payment 1 of 1"
        );
        let long = "é".repeat(400);
        assert!(std::str::from_utf8(installment_memo(&long, 12, 12).as_slice()).is_ok());
        assert_eq!(installment_memo("a\nb\u{7}", 1, 1), installment_memo("ab", 1, 1));
    }
}
