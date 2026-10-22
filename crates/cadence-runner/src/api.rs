//! The runner's HTTP API (`docs/api.md`).

use std::sync::{atomic::Ordering, Arc};

use anyhow::anyhow;
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use cadence_chain::{
    lwd,
    wallet::{self, ANCHOR_CONFIRMATIONS},
};
use orchard::Anchor;
use serde::Deserialize;
use serde_json::{json, Value};
use zcash_keys::address::Address;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId};

use crate::{
    service::{self, now, parse_account, parse_nullifier, parse_txid, App},
    store::{Installment, Offer},
};

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{:#}", e.into()))
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "not found".into())
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0u8; 10];
    rand::fill(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

fn require_merchant(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let expected = app.cfg.merchant_token.as_bytes();
    let ok = presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    if ok {
        Ok(())
    } else {
        Err(ApiError(StatusCode::UNAUTHORIZED, "merchant token required".into()))
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/offers", post(create_offer))
        .route("/api/offers/{id}", get(get_offer))
        .route("/api/pockets", post(create_pocket))
        .route("/api/pockets/{id}", get(get_pocket))
        .route("/api/pockets/{id}/witness", get(get_witness))
        .route("/api/broadcast", post(broadcast))
        .route("/api/subscriptions", post(create_subscription).get(list_subscriptions))
        .route("/api/subscriptions/{id}", get(get_subscription))
        .route("/api/subscriptions/{id}/stop", post(stop_subscription))
        .route("/api/decode/{txid}", get(decode))
        .layer(DefaultBodyLimit::max(80 * 1024 * 1024))
        .with_state(app)
}

async fn status(State(app): State<Arc<App>>) -> ApiResult<Json<Value>> {
    let subscriptions = app.store.lock().unwrap().count_subscriptions()?;
    Ok(Json(json!({
        "network": app.cfg.network_name,
        "tip": app.tip.load(Ordering::Relaxed),
        "drand_round": cadence_seal::round_at(&app.chain, now()),
        "subscriptions": subscriptions,
    })))
}

fn offer_view(app: &App, o: &Offer) -> Value {
    json!({
        "offer_id": o.offer_id,
        "name": o.name,
        "amount_zat": o.amount_zat,
        "period_secs": o.period_secs,
        "count": o.count,
        "merchant_ua": o.merchant_ua,
        "runner_age_recipient": app.recipient,
        "runner_endpoint": app.cfg.public_url,
        "network": app.cfg.network_name,
        "drand_chain": hex::encode(app.chain.hash),
    })
}

#[derive(Deserialize)]
struct NewOffer {
    name: String,
    amount_zat: u64,
    period_secs: u64,
    count: u32,
    merchant_ua: String,
}

async fn create_offer(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(req): Json<NewOffer>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_merchant(&app, &headers)?;
    if !(1..=12).contains(&req.count) {
        return Err(bad("count must be between 1 and 12"));
    }
    if req.amount_zat == 0 || req.period_secs == 0 {
        return Err(bad("amount and period must be positive"));
    }
    match Address::decode(&app.cfg.network, &req.merchant_ua) {
        Some(Address::Unified(ua)) if ua.orchard().is_some() => {}
        _ => return Err(bad("merchant_ua must be a unified address with an Orchard receiver")),
    }
    let offer = Offer {
        offer_id: random_id("off"),
        name: req.name,
        amount_zat: req.amount_zat,
        period_secs: req.period_secs,
        count: req.count,
        merchant_ua: req.merchant_ua,
        created_at: now(),
    };
    app.store.lock().unwrap().insert_offer(&offer)?;
    let view = offer_view(&app, &offer);
    // The offer travels in the URL fragment, which browsers never send to a server.
    let share_url = format!(
        "{}/subscribe#offer={}",
        app.cfg.public_url.trim_end_matches('/'),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&view)?)
    );
    Ok((
        StatusCode::CREATED,
        Json(json!({ "offer_id": offer.offer_id, "share_url": share_url })),
    ))
}

async fn get_offer(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let offer = app.store.lock().unwrap().offer(&id)?.ok_or_else(not_found)?;
    Ok(Json(offer_view(&app, &offer)))
}

#[derive(Deserialize)]
struct NewPocket {
    pocket_ufvk: String,
}

async fn create_pocket(
    State(app): State<Arc<App>>,
    Json(req): Json<NewPocket>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let mut client = app.sync_client.clone();
    let tip = lwd::tip(&mut client).await?;
    let id = random_id("pkt");
    let account = {
        let mut db = app.wallet.lock().await;
        wallet::import_pocket(&mut client, &mut db, &app.cfg.network, &req.pocket_ufvk, tip, &id)
            .await
            .map_err(|e| bad(format!("{e:#}")))?
    };
    app.store.lock().unwrap().insert_pocket(
        &id,
        &account.expose_uuid().to_string(),
        &req.pocket_ufvk,
        u32::from(tip),
        now(),
    )?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "pocket_id": id, "birthday_height": u32::from(tip), "tip": u32::from(tip) })),
    ))
}

async fn get_pocket(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let pocket = app.store.lock().unwrap().pocket(&id)?.ok_or_else(not_found)?;
    let tip = BlockHeight::from_u32(app.tip.load(Ordering::Relaxed));
    let account = parse_account(&pocket.account)?;
    let notes: Vec<Value> = {
        let db = app.wallet.lock().await;
        match wallet::pocket_fvk(&db, account) {
            Ok(fvk) => wallet::unspent_notes(&db, account, tip + 1)?
                .into_iter()
                .map(|n| {
                    json!({
                        "nullifier": hex::encode(n.note.nullifier(&fvk).to_bytes()),
                        "value_zat": n.note.value().inner(),
                        "mined_height": u32::from(n.mined),
                        "position": u64::from(n.position),
                    })
                })
                .collect(),
            // The pocket's account is deleted once its subscription ends.
            Err(_) => vec![],
        }
    };
    Ok(Json(json!({
        "pocket_id": pocket.pocket_id,
        "tip": u32::from(tip),
        "funding": pocket.funding,
        "notes": notes,
    })))
}

#[derive(Deserialize)]
struct WitnessQuery {
    nullifier: String,
}

async fn get_witness(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    Query(q): Query<WitnessQuery>,
) -> ApiResult<Json<Value>> {
    let pocket = app.store.lock().unwrap().pocket(&id)?.ok_or_else(not_found)?;
    let account = parse_account(&pocket.account)?;
    let nf = parse_nullifier(&q.nullifier).map_err(|e| bad(format!("{e:#}")))?;
    let target = BlockHeight::from_u32(app.tip.load(Ordering::Relaxed)) + 1;
    let anchor_height = target - ANCHOR_CONFIRMATIONS;
    let mut db = app.wallet.lock().await;
    let fvk = wallet::pocket_fvk(&db, account)?;
    let note = wallet::find_unspent(&db, account, &fvk, &nf, target)?
        .ok_or_else(|| bad("no unspent pocket note with that nullifier"))?;
    if note.mined > anchor_height {
        return Err(bad("the note is not yet anchor-deep; retry in a few blocks"));
    }
    let (anchor, witness): (Anchor, _) = wallet::anchor_and_witness(&mut db, note.position, anchor_height)?;
    Ok(Json(json!({
        "target_height": u32::from(target),
        "anchor_height": u32::from(anchor_height),
        "anchor": hex::encode(anchor.to_bytes()),
        "position": witness.position(),
        "auth_path": witness.auth_path().iter().map(|h| hex::encode(h.to_bytes())).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct RawTx {
    tx_hex: String,
}

async fn broadcast(State(app): State<Arc<App>>, Json(req): Json<RawTx>) -> ApiResult<Json<Value>> {
    let bytes = hex::decode(&req.tx_hex).map_err(|_| bad("tx_hex is not hex"))?;
    let target = BlockHeight::from_u32(app.tip.load(Ordering::Relaxed)) + 1;
    let tx = Transaction::read(&bytes[..], BranchId::for_height(&app.cfg.network, target))
        .map_err(|e| bad(format!("not a transaction: {e}")))?;
    let mut client = app.broadcast_client.clone();
    let txid = wallet::broadcast(&mut client, &tx).await?;
    Ok(Json(json!({ "txid": txid.to_string() })))
}

#[derive(Deserialize)]
struct NewInstallment {
    k: u32,
    release_round: u64,
    sealed: String,
}

#[derive(Deserialize)]
struct NewSubscription {
    offer_id: String,
    pocket_id: String,
    installments: Vec<NewInstallment>,
}

async fn create_subscription(
    State(app): State<Arc<App>>,
    Json(req): Json<NewSubscription>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (offer, pocket) = {
        let store = app.store.lock().unwrap();
        (
            store.offer(&req.offer_id)?.ok_or_else(|| bad("unknown offer"))?,
            store.pocket(&req.pocket_id)?.ok_or_else(|| bad("unknown pocket"))?,
        )
    };
    if pocket.subscription_id.is_some() {
        return Err(bad("this pocket already backs a subscription; pockets are single-use"));
    }
    if req.installments.len() != offer.count as usize {
        return Err(bad(format!("expected {} installments", offer.count)));
    }
    let mut last_round = 0;
    let mut installments = Vec::with_capacity(req.installments.len());
    for (i, inst) in req.installments.iter().enumerate() {
        if inst.k as usize != i + 1 {
            return Err(bad("installments must be numbered 1..=count in order"));
        }
        if inst.release_round <= last_round {
            return Err(bad("release rounds must strictly increase"));
        }
        last_round = inst.release_round;
        let sealed = STANDARD.decode(&inst.sealed).map_err(|_| bad("sealed is not base64"))?;
        // The tlock header names the round the package opens at; it must be the
        // round the payer claims, or the schedule shown to the merchant is a lie.
        let round = cadence_seal::header_round(&sealed).map_err(|e| bad(format!("bad package: {e:?}")))?;
        if round != inst.release_round {
            return Err(bad(format!("installment {} is sealed to round {round}", inst.k)));
        }
        installments.push(Installment {
            k: inst.k,
            amount_zat: offer.amount_zat,
            release_round: inst.release_round,
            release_at: cadence_seal::time_of(&app.chain, inst.release_round),
            state: "sealed".into(),
            txid: None,
            target_height: None,
            expiry_height: None,
            mined_height: None,
            sealed: Some(sealed),
            beacon: None,
        });
    }
    let id = random_id("sub");
    app.store
        .lock()
        .unwrap()
        .insert_subscription(&id, &offer.offer_id, &pocket.pocket_id, now(), &installments)?;
    Ok((StatusCode::CREATED, Json(json!({ "subscription_id": id, "status": "active" }))))
}

async fn list_subscriptions(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    require_merchant(&app, &headers)?;
    let subs = app.store.lock().unwrap().subscriptions(false)?;
    Ok(Json(json!({ "subscriptions": subs })))
}

async fn get_subscription(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let sub = app.store.lock().unwrap().subscription(&id)?.ok_or_else(not_found)?;
    Ok(Json(serde_json::to_value(sub)?))
}

async fn stop_subscription(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_merchant(&app, &headers)?;
    let sub = app.store.lock().unwrap().subscription(&id)?.ok_or_else(not_found)?;
    service::finish(&app, &sub, "stopped", None).await?;
    Ok(Json(json!({ "subscription_id": id, "status": "stopped" })))
}

async fn decode(State(app): State<Arc<App>>, Path(txid): Path<String>) -> ApiResult<Json<Value>> {
    let txid = parse_txid(&txid).map_err(|_| bad("not a txid"))?;
    let mut client = app.sync_client.clone();
    let (tx, mined) = lwd::transaction(&mut client, &app.cfg.network, &txid)
        .await
        .map_err(|e| ApiError(StatusCode::NOT_FOUND, format!("{e:#}")))?;
    let mut matching = vec![];
    if let (Some(mined), Some(bundle)) = (mined, tx.ironwood_bundle()) {
        for depth in 1..=12 {
            let h = mined - depth;
            let root = lwd::tree_state(&mut client, h).await?.ironwood_tree()?.root();
            if Anchor::from(root) == *bundle.anchor() {
                matching.push(h);
            }
        }
    }
    let range = matching.iter().min().zip(matching.iter().max()).map(|(a, b)| (*a, *b));
    let shape = cadence_decode::shape(&tx, mined, range, &[]);
    Ok(Json(serde_json::to_value(shape).map_err(|e| anyhow!(e))?))
}
