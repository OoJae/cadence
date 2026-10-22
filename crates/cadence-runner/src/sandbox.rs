//! Testnet-only endpoints for the judge sandbox: an offer anyone can subscribe to,
//! a funded pocket, and the runner *genuinely attempting* the three things it must
//! not be able to do. Each cheat returns the real error from the component that
//! stops it.

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
    api::{bad, insert_offer, not_found, ApiError, ApiResult},
    service::{fetch_beacon, now, parse_txid, App, Funder},
    store::{Installment, Subscription},
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
    let merchant = funder.pocket.funding_ua(&app.cfg.network);
    let created = insert_offer(&app, "Sandbox standing order".into(), req.amount_zat, req.period_secs, req.count, merchant)?;
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
        "replay_after_cancel" => replay(&app, &sub).await,
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

/// Re-broadcast an installment the runner already released.
async fn replay(app: &App, sub: &Subscription) -> Result<Json<Value>> {
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
        "runner: broadcasting installment {} again ({}…), whose pocket note is already spent",
        inst.k,
        &txid[..16]
    )];
    let mut broadcaster = app.broadcast_client.clone();
    match lwd::send(&mut broadcaster, bytes).await {
        Err(e) => {
            log.push(format!("{e:#}"));
            Ok(verdict("replay_after_cancel", inst.k, "rejected", Some("double-spend"), log))
        }
        Ok(()) => bail!("the network accepted a spent note, which must never happen"),
    }
}
