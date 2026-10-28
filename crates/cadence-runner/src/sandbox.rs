//! Testnet-only endpoints for the judge sandbox: an offer anyone can subscribe to,
//! a funded pocket, and the runner *genuinely attempting* things that must not
//! work. Each cheat returns the real error from the component that stops it.

use std::{convert::Infallible, sync::Arc};

use anyhow::{anyhow, bail, Context, Result};
use axum::{extract::State, http::StatusCode, Json};
use cadence_chain::{lwd, wallet};
use cadence_core::package::InstallmentLadder;
use orchard::{
    keys::{FullViewingKey, Scope},
    note::{NoteVersion, RandomSeed, Rho},
    primitives::redpallas,
    value::NoteValue,
    Address, Note,
};
use pczt::{
    roles::{creator::Creator, io_finalizer::IoFinalizer, signer::Signer},
    Pczt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use zcash_client_backend::data_api::WalletRead;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::{
    builder::{BundlePadding, DeferredPcztBuilder},
    fees::zip317::FeeRule,
    Transaction,
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId},
    memo::MemoBytes,
    value::Zatoshis,
};

use crate::{
    api::{bad, check_extras, check_schedule, insert_offer, not_found, ApiError, ApiResult, NewOffer},
    refund,
    service::{fetch_beacon, now, parse_account, parse_nullifier, parse_txid, App, Funder},
    store::{Installment, Quote, Subscription},
};

fn funder(app: &App) -> ApiResult<&Funder> {
    if app.cfg.network_name != "test" {
        return Err(bad("the sandbox only runs on testnet"));
    }
    app.funder
        .as_ref()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "the sandbox is not enabled".into()))
}

#[derive(Deserialize)]
pub struct SandboxOffer {
    count: u32,
    period_secs: u64,
    amount_zat: u64,
    #[serde(default)]
    trial_secs: u64,
    #[serde(default)]
    quote: Option<Quote>,
}

/// An offer whose merchant is the sandbox wallet itself, so judges' installments
/// flow back into the faucet.
pub async fn offer(
    State(app): State<Arc<App>>,
    Json(req): Json<SandboxOffer>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let funder = funder(&app)?;
    if !(1..=6).contains(&req.count) || !(60..=900).contains(&req.period_secs) {
        return Err(bad("sandbox offers have 1-6 installments, 60-900 s apart"));
    }
    if !(10_000..=200_000).contains(&req.amount_zat) {
        return Err(bad("sandbox installments are 10,000-200,000 zats"));
    }
    check_extras(req.trial_secs, req.quote.as_ref()).map_err(bad)?;
    let offer = NewOffer {
        name: "Sandbox standing order".into(),
        amount_zat: req.amount_zat,
        period_secs: req.period_secs,
        count: req.count,
        merchant_ua: funder.pocket.funding_ua(&app.cfg.network),
        trial_secs: req.trial_secs,
        quote: req.quote,
    };
    let created = insert_offer(&app, offer)?;
    Ok((StatusCode::CREATED, Json(created)))
}

#[derive(Deserialize)]
pub struct SandboxFund {
    pocket_id: Option<String>,
    ua: Option<String>,
    amount_zat: u64,
}

/// Pays a registered pocket once from the sandbox wallet (custodial, disclosed).
pub async fn fund(State(app): State<Arc<App>>, Json(req): Json<SandboxFund>) -> ApiResult<Json<Value>> {
    let funder = funder(&app)?;
    if req.amount_zat == 0 || req.amount_zat > 2_000_000 {
        return Err(bad("amount_zat must be between 1 and 2,000,000"));
    }
    let pocket = {
        let store = app.store.lock().unwrap();
        match (&req.pocket_id, &req.ua) {
            (Some(id), _) => store.pocket(id)?,
            (None, Some(ua)) => store.unfunded_pockets()?.into_iter().find(|p| {
                UnifiedFullViewingKey::decode(&app.cfg.network, &p.ufvk)
                    .ok()
                    .and_then(|u| u.orchard().cloned())
                    .map(|fvk| funding_ua(&app, &fvk) == *ua)
                    .unwrap_or(false)
            }),
            (None, None) => return Err(bad("give pocket_id or ua")),
        }
        .ok_or_else(|| bad("register the pocket with POST /api/pockets first"))?
    };
    if pocket.funding.is_some() || !funder.funded.lock().unwrap().insert(pocket.pocket_id.clone()) {
        return Err(bad("this pocket has already been funded"));
    }
    let fvk = pocket_fvk(&app, &pocket.ufvk)?;
    let to = fvk.address_at(0u32, Scope::External);
    let amount = Zatoshis::from_u64(req.amount_zat).map_err(|_| bad("bad amount"))?;

    let _turn = funder.queue.lock().await;
    let exclude = funder.in_flight.lock().unwrap().clone();
    let mut client = app.sync_client.clone();
    let mut broadcaster = app.broadcast_client.clone();
    let result = {
        let mut db = app.wallet.lock().await;
        wallet::pay(
            &mut client,
            &mut broadcaster,
            &mut db,
            &app.cfg.network,
            funder.account,
            &funder.pocket,
            to,
            amount,
            &exclude,
        )
        .await
    };
    match result {
        Ok((txid, nf)) => {
            funder.in_flight.lock().unwrap().push(nf);
            Ok(Json(json!({ "txid": txid.to_string(), "mined_height": null })))
        }
        Err(e) => {
            funder.funded.lock().unwrap().remove(&pocket.pocket_id);
            Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("the sandbox wallet is busy, retry in a minute: {e:#}"),
            ))
        }
    }
}

fn funding_ua(app: &App, fvk: &FullViewingKey) -> String {
    zcash_keys::address::UnifiedAddress::from_receivers(
        Some(fvk.address_at(0u32, Scope::External)),
        None,
        None,
        None,
        None,
    )
    .map(|ua| ua.encode(&app.cfg.network))
    .unwrap_or_default()
}

fn pocket_fvk(app: &App, ufvk: &str) -> Result<FullViewingKey> {
    let ufvk = UnifiedFullViewingKey::decode(&app.cfg.network, ufvk).map_err(|e| anyhow!(e))?;
    ufvk.orchard().cloned().context("pocket has no Orchard key")
}

#[derive(Deserialize)]
pub struct Cheat {
    subscription_id: String,
    kind: String,
    k: u32,
}

fn verdict(kind: &str, k: u32, outcome: &str, stage: Option<&str>, log: Vec<String>) -> Json<Value> {
    Json(json!({ "kind": kind, "k": k, "outcome": outcome, "stage": stage, "log": log }))
}

pub async fn cheat(State(app): State<Arc<App>>, Json(req): Json<Cheat>) -> ApiResult<Json<Value>> {
    funder(&app)?;
    let sub = app
        .store
        .lock()
        .unwrap()
        .subscription(&req.subscription_id)?
        .ok_or_else(not_found)?;
    let result = match req.kind.as_str() {
        "open_early" => open_early(&app, &sub, req.k).await,
        "tamper_amount" => tamper_amount(&app, &sub, req.k).await,
        "stretch_schedule" => stretch_schedule(&app, &sub),
        // The old name: the node refuses the copy whether or not the payer cancelled.
        "rebroadcast" | "replay_after_cancel" => rebroadcast(&app, &sub, &req.kind).await,
        "charge_after_cancel" => {
            if let Some(secs) = voided(&sub, req.k).ok().and_then(|inst| opens_in(&app, inst, now())) {
                return Err(ApiError(StatusCode::CONFLICT, format!("installment {} opens in {secs} s", req.k)));
            }
            charge_after_cancel(&app, &sub, req.k).await
        }
        _ => return Err(bad("unknown cheat")),
    };
    Ok(match result {
        Ok(v) => v,
        Err(e) => verdict(&req.kind, req.k, "not_applicable", None, vec![format!("{e:#}")]),
    })
}

fn installment<'a>(sub: &'a Subscription, k: u32) -> Result<&'a Installment> {
    sub.installments
        .iter()
        .find(|i| i.k == k)
        .with_context(|| format!("no installment {k}"))
}

/// Try to decrypt a sealed package with the newest drand beacon, which is not the
/// one it was sealed to.
async fn open_early(app: &App, sub: &Subscription, k: u32) -> Result<Json<Value>> {
    let inst = installment(sub, k)?;
    let sealed = match (&inst.state[..], &inst.sealed) {
        ("sealed", Some(s)) => s.clone(),
        _ => bail!("installment {k} is no longer sealed; pick one that hasn't opened"),
    };
    let round_now = cadence_seal::round_at(&app.chain, now());
    let beacon = fetch_beacon(app, round_now).await?;
    let mut log = vec![
        format!("runner: installment {k} is sealed to drand round {}", inst.release_round),
        format!("runner: newest drand beacon is round {round_now}; trying it"),
    ];
    match cadence_seal::open(&sealed, &app.identity, &app.chain, &beacon) {
        Err(e) => {
            log.push(format!("cadence-seal: {e:?}"));
            Ok(verdict("open_early", k, "rejected", Some("tlock"), log))
        }
        Ok(_) => bail!("the package opened early, which must never happen"),
    }
}

/// Note bytes recorded in a parsed PCZT output, rebuilt into a note.
fn note_from_output(action: &pczt::orchard::Action) -> Option<Note> {
    let out = action.output();
    let recipient = Option::from(Address::from_raw_address_bytes(out.recipient().as_ref()?))?;
    let value = NoteValue::from_raw((*out.value())?);
    let rho = Option::from(Rho::from_bytes(action.spend().nullifier()))?;
    let rseed = Option::from(RandomSeed::from_bytes(*out.rseed().as_ref()?, &rho))?;
    Option::from(Note::from_parts(recipient, value, rho, rseed, NoteVersion::V3))
}

fn open_ladder(app: &App, inst: &Installment) -> Result<InstallmentLadder> {
    let sealed = inst.sealed.as_ref().context("package shredded")?;
    let beacon = inst.beacon.as_ref().context("package not opened yet")?;
    let plain = cadence_seal::open(sealed, &app.identity, &app.chain, beacon).map_err(|e| anyhow!("{e:?}"))?;
    Ok(serde_json::from_slice(&plain)?)
}

/// The note installment `k` spends: the funding note for 1, else the previous
/// installment's change.
fn input_note(app: &App, sub: &Subscription, k: u32, fvk: &FullViewingKey) -> Result<Note> {
    if k == 1 {
        let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
        let f = pocket.funding.context("pocket not funded")?;
        let bytes = hex::decode(&f.tx_hex)?;
        let tx = Transaction::read(
            &bytes[..],
            BranchId::for_height(&app.cfg.network, BlockHeight::from_u32(f.mined_height)),
        )?;
        let ivk = fvk.to_ivk(Scope::External);
        return tx
            .ironwood_bundle()
            .context("funding has no Ironwood bundle")?
            .decrypt_outputs_with_keys(core::slice::from_ref(&ivk))
            .into_iter()
            .map(|(_, _, note, _, _)| note)
            .next()
            .context("funding pays nothing to the pocket");
    }
    let prev = open_ladder(app, installment(sub, k - 1)?)?;
    let pczt = Pczt::parse(&hex::decode(&prev.rungs.first().context("empty ladder")?.pczt)?)
        .map_err(|e| anyhow!("{e:?}"))?;
    let change = fvk.address_at(0u32, Scope::Internal);
    pczt.ironwood()
        .actions()
        .iter()
        .filter_map(note_from_output)
        .find(|n| n.recipient() == change)
        .context("installment has no change output")
}

/// Rebuild an installment paying one zat more and re-use the payer's signature.
async fn tamper_amount(app: &App, sub: &Subscription, k: u32) -> Result<Json<Value>> {
    let inst = installment(sub, k)?;
    if !matches!(&inst.state[..], "due" | "broadcast" | "mined") {
        bail!("installment {k} has not opened yet");
    }
    let ladder = open_ladder(app, inst)?;
    let rung = ladder.rungs.first().context("empty ladder")?;
    let signed = Pczt::parse(&hex::decode(&rung.pczt)?).map_err(|e| anyhow!("{e:?}"))?;
    let sig = signed
        .ironwood()
        .actions()
        .iter()
        .find(|a| a.spend().witness().is_none())
        .and_then(|a| *a.spend().spend_auth_sig())
        .context("rung carries no spend authorization")?;

    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let fvk = pocket_fvk(app, &pocket.ufvk)?;
    let note = input_note(app, sub, k, &fvk)?;
    let offer = app.store.lock().unwrap().offer(&sub.offer_id)?.context("offer gone")?;
    let merchant = match zcash_keys::address::Address::decode(&app.cfg.network, &offer.merchant_ua) {
        Some(zcash_keys::address::Address::Unified(ua)) => *ua.orchard().context("no Orchard receiver")?,
        _ => bail!("bad merchant address"),
    };

    let target = BlockHeight::from_u32(rung.target_height);
    let fee_rule = FeeRule::standard();
    let more = Zatoshis::from_u64(inst.amount_zat + 1).map_err(|_| anyhow!("amount"))?;
    let mut b = DeferredPcztBuilder::new::<Infallible>(app.cfg.network, target, BundlePadding::DEFAULT, BundlePadding::DEFAULT)
        .map_err(|e| anyhow!("{e:?}"))?;
    b.add_ironwood_spend::<Infallible>(fvk.clone(), note).map_err(|e| anyhow!("{e:?}"))?;
    b.add_ironwood_output::<Infallible>(None, merchant, more, MemoBytes::empty())
        .map_err(|e| anyhow!("{e:?}"))?;
    let fee = b.get_fee(&fee_rule).map_err(|e| anyhow!("{e:?}"))?;
    let change = (Zatoshis::from_u64(note.value().inner()).map_err(|_| anyhow!("value"))? - more)
        .and_then(|v| v - fee)
        .context("note too small")?;
    if !change.is_zero() {
        b.add_ironwood_output::<Infallible>(None, fvk.address_at(0u32, Scope::Internal), change, MemoBytes::empty())
            .map_err(|e| anyhow!("{e:?}"))?;
    }
    let mut rng = wallet::OsRng::default();
    let res = b.build_for_pczt(&mut rng, &fee_rule).map_err(|e| anyhow!("{e:?}"))?;
    let spend_index = res.ironwood_meta.spend_action_index(0).context("no spend")?;
    let pczt = Creator::build_from_parts(res.pczt_parts).context("creator")?;
    let pczt = IoFinalizer::new(pczt).finalize_io(&mut rng).map_err(|e| anyhow!("{e:?}"))?;
    let mut signer = Signer::new(pczt).map_err(|e| anyhow!("{e:?}"))?;

    let mut log = vec![
        format!("runner: rebuilt installment {k} paying {} zats instead of {}", inst.amount_zat + 1, inst.amount_zat),
        "runner: attaching the payer's spend authorization from the sealed package".to_string(),
    ];
    match signer.apply_ironwood_signature(spend_index, redpallas::Signature::<redpallas::SpendAuth>::from(sig)) {
        Err(e) => {
            log.push(format!("pczt signer: {e:?}"));
            Ok(verdict("tamper_amount", k, "rejected", Some("signature"), log))
        }
        Ok(()) => bail!("a tampered installment verified, which must never happen"),
    }
}

/// Broadcast the newest installment the runner already released a second time.
async fn rebroadcast(app: &App, sub: &Subscription, kind: &str) -> Result<Json<Value>> {
    let inst = sub
        .installments
        .iter()
        .rev()
        .find(|i| i.state == "mined" && i.txid.is_some())
        .context("no installment has been released yet")?;
    let txid = inst.txid.as_deref().unwrap_or_default();
    let mut client = app.sync_client.clone();
    let (bytes, _) = lwd::raw_transaction(&mut client, &parse_txid(txid)?).await?;
    let mut log = vec![format!(
        "runner: rebroadcasting paid installment {} ({}…), whose pocket note is already spent",
        inst.k,
        &txid[..16]
    )];
    let mut broadcaster = app.broadcast_client.clone();
    match lwd::send(&mut broadcaster, bytes).await {
        Err(e) => {
            log.push(format!("{e:#}"));
            Ok(verdict(kind, inst.k, "rejected", Some("double-spend"), log))
        }
        Ok(()) => bail!("the network accepted a spent note, which must never happen"),
    }
}

/// Installment `k` of a cancelled subscription: the first one the cancel voided, whose
/// package is still kept (`refund.rs`). Only it spends the note the cancel spent.
fn voided(sub: &Subscription, k: u32) -> Result<&Installment> {
    if sub.status != "cancelled" {
        bail!("the subscription is {}; cancel it first", sub.status);
    }
    let first = sub
        .installments
        .iter()
        .find(|i| i.state == "cancelled")
        .context("the cancel voided no installment")?;
    if first.k != k {
        bail!("installment {} is the first the cancel voided, and the only one whose note exists", first.k);
    }
    if first.sealed.is_none() {
        bail!(
            "installment {k}'s package is deleted: a cancel's voided packages are kept for {} min",
            refund::VOIDED_KEEP_SECS / 60
        );
    }
    Ok(first)
}

/// Seconds until `inst`'s drand round, if it has not passed.
fn opens_in(app: &App, inst: &Installment, now: u64) -> Option<u64> {
    (cadence_seal::round_at(&app.chain, now) < inst.release_round)
        .then(|| cadence_seal::time_of(&app.chain, inst.release_round).saturating_sub(now).max(1))
}

/// Release the first installment a cancel voided, as the scheduler would have: open
/// its package now that its round has passed, take the rung for the next block, prove
/// it against a fresh anchor and broadcast it. Its note is already spent by the cancel.
async fn charge_after_cancel(app: &App, sub: &Subscription, k: u32) -> Result<Json<Value>> {
    let inst = voided(sub, k)?;
    let beacon = match &inst.beacon {
        Some(beacon) => beacon.clone(),
        None => fetch_beacon(app, inst.release_round).await?,
    };
    let ladder = open_ladder(app, &Installment { beacon: Some(beacon), ..inst.clone() })?;
    let mut log = vec![
        format!("runner: the payer cancelled; installment {k}'s package was kept for this attempt"),
        format!("runner: drand round {} passed; opened installment {k}", inst.release_round),
    ];
    let nf = parse_nullifier(&ladder.spends_nullifier)?;
    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let account = parse_account(&pocket.account)?;

    let mut client = app.sync_client.clone();
    let tip = lwd::tip(&mut client).await?;
    let target = tip + 1;
    let anchor_height = target - wallet::ANCHOR_CONFIRMATIONS;
    let rung = ladder
        .rungs
        .iter()
        .find(|r| r.target_height == u32::from(target))
        .with_context(|| {
            let heights = ladder.rungs.iter().map(|r| r.target_height);
            format!(
                "installment {k}'s rungs cover blocks {}-{}, not the next block, {target}",
                heights.clone().min().unwrap_or(0),
                heights.max().unwrap_or(0)
            )
        })?;
    let pczt = Pczt::parse(&hex::decode(&rung.pczt)?).map_err(|e| anyhow!("{e:?}"))?;
    let (anchor, witness) = {
        let mut db = app.wallet.lock().await;
        if db.block_fully_scanned()?.is_none_or(|b| b.block_height() < anchor_height) {
            wallet::sync(&mut client, &app.cfg.network, &mut db).await?;
        }
        let position = refund::note_position(&mut db, account, &nf)?.context("the wallet no longer has the pocket's note")?;
        wallet::anchor_and_witness(&mut db, position, anchor_height)?
    };
    wallet::check_anchor(&mut client, &anchor, anchor_height).await?;
    log.push(format!(
        "runner: proving the rung for block {target}; it spends note {}…, which the cancel spent",
        &ladder.spends_nullifier[..16]
    ));
    let tx = tokio::task::spawn_blocking(move || wallet::complete(pczt, anchor, witness)).await??;
    let mut bytes = vec![];
    tx.write(&mut bytes)?;
    log.push(format!("runner: broadcasting installment {k} ({}…)", &tx.txid().to_string()[..16]));
    let mut broadcaster = app.broadcast_client.clone();
    match lwd::send(&mut broadcaster, bytes).await {
        Err(e) => {
            log.push(format!("{e:#}"));
            Ok(verdict("charge_after_cancel", k, "rejected", Some("node"), log))
        }
        Ok(()) => bail!("the network accepted a charge after the cancel, which must never happen"),
    }
}

/// Move one installment of the subscription's own schedule a year later, and put
/// that copy through the check every upload passes (`POST /api/subscriptions`).
fn stretch_schedule(app: &App, sub: &Subscription) -> Result<Json<Value>> {
    const YEAR_SECS: u64 = 365 * 24 * 60 * 60;
    let (offer, funded) = {
        let store = app.store.lock().unwrap();
        let offer = store.offer(&sub.offer_id)?.context("offer gone")?;
        let pocket = store.pocket_for_subscription(&sub.subscription_id)?;
        (offer, pocket.funding.map(|f| f.value_zat))
    };
    let mut rounds: Vec<(u32, u64)> = sub.installments.iter().map(|i| (i.k, i.release_round)).collect();
    // Checked as of the upload, which this schedule passed.
    let uploaded = sub.created_at;
    check_schedule(&app.chain, &offer, funded, &rounds, uploaded)
        .map_err(|e| anyhow!("this subscription's own schedule does not pass the check: {e}"))?;
    let k: u32 = if rounds.len() >= 2 { 2 } else { 1 };
    let moved = &mut rounds[k as usize - 1].1;
    *moved += YEAR_SECS.div_ceil(app.chain.period);
    let at = cadence_seal::time_of(&app.chain, *moved);
    let mut log = vec![if k == 1 {
        format!(
            "runner: copying the schedule with installment 1 sealed for {}, a year later; \
             the offer says every {} s from subscribing",
            utc(at),
            offer.period_secs
        )
    } else {
        let first = cadence_seal::time_of(&app.chain, rounds[0].1);
        format!(
            "runner: copying the schedule with installment 2 sealed for {}, {} days after #1; \
             the offer says every {} s",
            utc(at),
            (at - first) / 86_400,
            offer.period_secs
        )
    }];
    log.push("runner: checking the copy as POST /api/subscriptions checks every upload".into());
    match check_schedule(&app.chain, &offer, funded, &rounds, uploaded) {
        Err(e) => {
            log.push(format!("schedule check: {e}"));
            Ok(verdict("stretch_schedule", k, "rejected", Some("schedule"), log))
        }
        Ok(()) => bail!("a stretched schedule passed the check, which must never happen"),
    }
}

/// A UNIX time as `2027-10-26 14:03 UTC`.
fn utc(unix: u64) -> String {
    // Howard Hinnant's days-to-civil conversion, for days since 1970-01-01.
    let z = (unix / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let secs = unix % 86_400;
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", secs / 3_600, secs % 3_600 / 60)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
    };
    use serde_json::{json, Value};

    use super::utc;
    use crate::{
        api::{
            router,
            tests::{offer, prepaid, send, signed_schedule, subscribable, subscribed, test_app, upload},
        },
        refund::{expire, VOIDED_KEEP_SECS},
        service::{finish, now},
    };

    fn cheat(subscription_id: &Value, kind: &str) -> Request<Body> {
        cheat_k(subscription_id, kind, 1)
    }

    fn cheat_k(subscription_id: &Value, kind: &str, k: u32) -> Request<Body> {
        let body = json!({ "subscription_id": subscription_id, "kind": kind, "k": k });
        Request::post("/api/sandbox/cheat")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn a_sandbox_cancel_keeps_the_voided_packages_for_an_hour() {
        let app = test_app(true, None);
        let api = router(app.clone(), None, vec![]);
        let id = subscribed(&app, &api, now(), None).await.unwrap();
        let sub_id = json!(id);
        let subscription = || app.store.lock().unwrap().subscription(&id).unwrap().unwrap();

        // Nothing to charge before the payer cancels.
        let (status, _, verdict) = send(&api, cheat(&sub_id, "charge_after_cancel")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(verdict["outcome"], "not_applicable");
        assert_eq!(verdict["log"][0], "the subscription is active; cancel it first");

        // Installment 1 is paid; the payer cancels before installment 2.
        app.store.lock().unwrap().set_mined(&id, 1, 100).unwrap();
        let sub = subscription();
        finish(&app, &sub, "cancelled", Some(&sub.installments[1])).await.unwrap();
        let sub = subscription();
        assert!(sub.installments[0].sealed.is_none(), "a paid installment's package goes at once");
        assert_eq!(sub.installments[1].state, "cancelled");
        assert!(sub.installments[1].sealed.is_some());
        assert!(sub.keep_until.unwrap().abs_diff(now() + VOIDED_KEEP_SECS) < 5);
        assert!(!sub.refundable);

        // Installment 2 releases about 660 s after signing, so its round is still ahead.
        let (status, _, body) = send(&api, cheat_k(&sub_id, "charge_after_cancel", 2)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        let error = body["error"].as_str().unwrap();
        let secs: u64 = error
            .strip_prefix("installment 2 opens in ")
            .and_then(|e| e.strip_suffix(" s"))
            .and_then(|n| n.parse().ok())
            .unwrap_or_else(|| panic!("{error}"));
        assert!((600..=670).contains(&secs), "{error}");
        let (_, _, verdict) = send(&api, cheat_k(&sub_id, "charge_after_cancel", 1)).await;
        assert_eq!(verdict["outcome"], "not_applicable");
        assert_eq!(
            verdict["log"][0],
            "installment 2 is the first the cancel voided, and the only one whose note exists"
        );

        // After the hour the package is gone, as for every other subscription.
        expire(&app, now() + VOIDED_KEEP_SECS - 10).await.unwrap();
        assert!(subscription().installments[1].sealed.is_some());
        expire(&app, now() + VOIDED_KEEP_SECS).await.unwrap();
        assert!(subscription().installments.iter().all(|i| i.sealed.is_none()));
        let (status, _, verdict) = send(&api, cheat_k(&sub_id, "charge_after_cancel", 2)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(verdict["outcome"], "not_applicable");
        assert_eq!(
            verdict["log"][0],
            "installment 2's package is deleted: a cancel's voided packages are kept for 60 min"
        );
    }

    #[tokio::test]
    async fn only_the_sandbox_keeps_a_cancels_packages() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let id = subscribed(&app, &api, now(), None).await.unwrap();
        let sub = app.store.lock().unwrap().subscription(&id).unwrap().unwrap();
        finish(&app, &sub, "cancelled", Some(&sub.installments[0])).await.unwrap();
        let sub = app.store.lock().unwrap().subscription(&id).unwrap().unwrap();
        assert!(sub.installments.iter().all(|i| i.sealed.is_none()));
        assert_eq!(sub.keep_until, None);
        // And the cheat is the sandbox's alone.
        let (status, _, _) = send(&api, cheat(&json!(id), "charge_after_cancel")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn stretched_schedule_is_refused_by_the_upload_check() {
        for count in [3, 1] {
            let app = test_app(true, None);
            let api = router(app.clone(), None, vec![]);
            let o = offer(count, 90);
            let (offer_id, pocket_id) = subscribable(&app, count, 90, Some(prepaid(&o)));
            let rounds = signed_schedule(&app.chain, &o, now(), 60);
            let (status, _, sub) = send(&api, upload(&app, &offer_id, &pocket_id, &rounds)).await;
            assert_eq!(status, StatusCode::CREATED, "{sub}");

            let (status, _, verdict) = send(&api, cheat(&sub["subscription_id"], "stretch_schedule")).await;
            assert_eq!(status, StatusCode::OK);
            let k = if count == 1 { 1 } else { 2 };
            assert_eq!(verdict["outcome"], "rejected", "{verdict}");
            assert_eq!(verdict["stage"], "schedule");
            assert_eq!(verdict["k"], k);
            let log: Vec<&str> = verdict["log"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
            assert!(log[0].starts_with(&format!("runner: copying the schedule with installment {k} sealed for ")), "{log:?}");
            if count > 1 {
                assert!(log[0].contains(", 365 days after #1; the offer says every 90 s"), "{log:?}");
            }
            let last = log.last().unwrap();
            assert!(last.starts_with(&format!("schedule check: installment {k} releases ")), "{log:?}");
        }
    }

    #[tokio::test]
    async fn rebroadcast_keeps_its_old_name() {
        let app = test_app(true, None);
        let api = router(app.clone(), None, vec![]);
        let o = offer(2, 90);
        let (offer_id, pocket_id) = subscribable(&app, 2, 90, Some(prepaid(&o)));
        let rounds = signed_schedule(&app.chain, &o, now(), 60);
        let (_, _, sub) = send(&api, upload(&app, &offer_id, &pocket_id, &rounds)).await;
        // Nothing is mined yet, so neither name has anything to rebroadcast.
        for kind in ["rebroadcast", "replay_after_cancel"] {
            let (status, _, verdict) = send(&api, cheat(&sub["subscription_id"], kind)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(verdict["kind"], kind);
            assert_eq!(verdict["outcome"], "not_applicable");
            assert_eq!(verdict["log"][0], "no installment has been released yet");
        }
        let (status, _, _) = send(&api, cheat(&sub["subscription_id"], "replay")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn utc_dates() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc(951_782_400), "2000-02-29 00:00 UTC");
        assert_eq!(utc(1_700_000_000), "2023-11-14 22:13 UTC");
        assert_eq!(utc(1_792_677_856), "2026-10-22 14:04 UTC");
    }
}
