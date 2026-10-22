//! A whole mandate: its schedule, the funding it needs, and its pre-signed ladders.
//!
//! This is everything the payer does, independent of where it runs (CLI or browser).
//! Release *times* are chosen here; turning them into drand rounds and sealing the
//! ladders is the caller's job (see `cadence-seal`).

use orchard::{keys::Scope, Address, Note};
use zcash_primitives::transaction::{fees::zip317::MARGINAL_FEE, Transaction};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, NetworkType, NetworkUpgrade, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

use crate::{
    build_rung,
    package::{redact_for_runner, InstallmentLadder, RungPackage},
    seed, Installment, Pocket,
};

/// Block times used to predict when an installment's release falls on chain.
pub const PRE_NU7_BLOCK_SECS: u64 = 75;
pub const NU7_BLOCK_SECS: u64 = 25;

/// Wallets switch to the lower ZIP 317 marginal fee at this mainnet height (ZIP 2009).
/// A pre-signed installment can't know which fee stock wallets will pay after it, so
/// no mainnet rung targets this height or later; the schedule is re-signed instead.
pub const MAINNET_FEE_SWITCH: u32 = 3_590_000;

/// Blocks just before NU7 activation are skipped on mainnet, so no rung's expiry
/// window straddles the upgrade.
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
    /// Opaque tag the merchant uses to recognise its installments.
    pub tag: [u8; 16],
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
}

/// The ZIP 317 fee of one installment: two actions (payment and change, or
/// payment and padding).
pub fn installment_fee() -> Zatoshis {
    Zatoshis::const_from_u64(u64::from(MARGINAL_FEE) * 2)
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

fn excluded<P: Parameters>(params: &P, h: u32) -> bool {
    if params.network_type() != NetworkType::Main {
        return false;
    }
    if h >= MAINNET_FEE_SWITCH {
        return true;
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
/// distance to `at`, since block times drift over long horizons.
pub fn window<P: Parameters>(params: &P, tip: BlockHeight, now: u64, at: u64) -> Vec<BlockHeight> {
    let predicted = u32::from(predict_height(params, tip, now, at));
    let ahead = predicted.saturating_sub(u32::from(tip));
    let spread = 4.0 * f64::from(ahead).sqrt();
    let below = 10 + spread as u32 + ahead / 100;
    let above = 150 + spread as u32 + ahead / 50;
    let start = predicted.saturating_sub(below).max(u32::from(tip) + 1);
    (start..=predicted + above)
        .filter(|h| !excluded(params, *h))
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
    mut progress: impl FnMut(u32, usize, usize),
) -> Result<Vec<Presigned>, Error> {
    let needed = funding_total(terms).ok_or(Error::Underfunded { needed: u64::MAX, available: 0 })?;
    let available = funding.value().inner();
    if available < u64::from(needed) {
        return Err(Error::Underfunded {
            needed: needed.into(),
            available,
        });
    }

    let secret = seed::app_secret(pocket);
    let mut input = funding;
    let mut out = Vec::with_capacity(terms.count as usize);
    for k in 1..=terms.count {
        let mut memo = [0u8; 20];
        memo[..16].copy_from_slice(&terms.tag);
        memo[16..].copy_from_slice(&k.to_le_bytes());
        let inst = Installment {
            input,
            amount: terms.amount,
            merchant: terms.merchant,
            memo: MemoBytes::from_bytes(&memo).map_err(|e| Error::Encode(format!("{e:?}")))?,
        };
        let release_at = terms.release_at(k);
        let heights = window(params, tip, now, release_at);
        if heights.is_empty() {
            return Err(Error::EmptyWindow(k));
        }
        let rung_seed = seed::rung_seed(&secret, &mandate_id, k, 0);

        let mut rungs = Vec::with_capacity(heights.len());
        let mut change = None;
        let mut spends_nullifier = [0u8; 32];
        for (i, target) in heights.iter().enumerate() {
            let rung = build_rung(params, *target, pocket, &inst, rung_seed).map_err(Error::Rung)?;
            debug_assert_eq!(rung.fee, installment_fee());
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
    fn funding_covers_every_installment_and_fee() {
        let terms = Terms {
            amount: Zatoshis::const_from_u64(100_000),
            count: 3,
            period_secs: 600,
            first_release_at: 0,
            merchant: Pocket::from_seed(&[1; 32], 133).funding_address(),
            tag: [0; 16],
        };
        assert_eq!(u64::from(funding_total(&terms).unwrap()), 330_000);
    }
}
