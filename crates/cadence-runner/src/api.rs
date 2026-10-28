//! The runner's HTTP API (`docs/api.md`).

use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

use anyhow::anyhow;
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
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
use cadence_core::mandate::installment_fee;
use cadence_seal::DrandChain;
use orchard::Anchor;
use serde::Deserialize;
use serde_json::{json, Value};
use zcash_client_backend::data_api::WalletRead;
use zcash_keys::address::Address;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{BlockHeight, BranchId};

use crate::{
    service::{self, now, parse_account, parse_nullifier, parse_txid, App},
    store::{Installment, Offer},
};

pub struct ApiError(pub StatusCode, pub String);

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

pub type ApiResult<T> = Result<T, ApiError>;

pub fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

pub fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "not found".into())
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0u8; 10];
    rand::fill(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

pub(crate) fn is_merchant(app: &App, headers: &HeaderMap) -> bool {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let expected = app.cfg.merchant_token.as_bytes();
    presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn require_merchant(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    if is_merchant(app, headers) {
        Ok(())
    } else {
        Err(ApiError(StatusCode::UNAUTHORIZED, "merchant token required".into()))
    }
}

/// Request bodies: a ladder of sealed packages runs to megabytes, and nothing else
/// needs more than a few kilobytes.
pub const UPLOAD_BODY_LIMIT: usize = 80 * 1024 * 1024;
pub const BODY_LIMIT: usize = 64 * 1024;

/// The API, callable from `cors_origins` as well as its own origin, and the web app
/// if `web_dir` is given.
pub fn router(app: Arc<App>, web_dir: Option<PathBuf>, cors_origins: Vec<HeaderValue>) -> Router {
    let limits = Arc::new(crate::limits::Limits::new(app.clone()));
    let api = Router::new()
        .route("/api/status", get(status))
        .route("/api/offers", post(create_offer))
        .route("/api/offers/{id}", get(get_offer))
        .route("/api/pockets", post(create_pocket))
        .route("/api/pockets/{id}", get(get_pocket))
        .route("/api/pockets/{id}/witness", get(get_witness))
        .route("/api/broadcast", post(broadcast))
        .route(
            "/api/subscriptions",
            post(create_subscription)
                .get(list_subscriptions)
                .layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route("/api/subscriptions/{id}", get(get_subscription))
        .route("/api/subscriptions/{id}/stop", post(stop_subscription))
        .route("/api/decode/{txid}", get(decode))
        .route("/api/sandbox/offer", post(crate::sandbox::offer))
        .route("/api/sandbox/fund", post(crate::sandbox::fund))
        .route("/api/sandbox/cheat", post(crate::sandbox::cheat))
        .layer(axum::middleware::from_fn_with_state(limits, crate::limits::check))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(app);
    with_headers(api, web_dir, cors_origins)
}

/// Puts the API under its CORS policy and adds the web app's files and headers.
fn with_headers(api: Router, web_dir: Option<PathBuf>, cors_origins: Vec<HeaderValue>) -> Router {
    use axum::http::{
        header::{self, HeaderName},
        Method,
    };
    use tower_http::{
        cors::{AllowOrigin, CorsLayer},
        services::{ServeDir, ServeFile},
        set_header::SetResponseHeaderLayer,
    };
    let corp = HeaderName::from_static("cross-origin-resource-policy");
    let api = if cors_origins.is_empty() {
        api
    } else {
        // A web app hosted elsewhere reads the API with fetch(): exactly these origins,
        // no credentials (the merchant token is a header, never a cookie), and a
        // resource policy that its COEP allows.
        let cors = CorsLayer::new()
            // So that the page can read how long a 429 asks it to wait.
            .expose_headers([header::RETRY_AFTER])
            .allow_origin(AllowOrigin::list(cors_origins))
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
            .max_age(Duration::from_secs(600));
        api.layer(cors)
            .layer(SetResponseHeaderLayer::overriding(corp.clone(), HeaderValue::from_static("cross-origin")))
    };
    match web_dir {
        None => api,
        Some(dir) => {
            let index = dir.join("index.html");
            let set = |name: HeaderName, value: &'static str| {
                SetResponseHeaderLayer::overriding(name, HeaderValue::from_static(value))
            };
            api.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
                .layer(set(header::CONTENT_SECURITY_POLICY, WEB_CSP))
                .layer(set(header::REFERRER_POLICY, "no-referrer"))
                .layer(set(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
                .layer(set(HeaderName::from_static("cross-origin-opener-policy"), "same-origin"))
                .layer(set(HeaderName::from_static("cross-origin-embedder-policy"), "require-corp"))
                // Unless the API already opened itself to other origins above.
                .layer(SetResponseHeaderLayer::if_not_present(corp, HeaderValue::from_static("same-origin")))
                .layer(set(
                    HeaderName::from_static("permissions-policy"),
                    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
                ))
        }
    }
}

/// The web app's policy (web/README.md), as a header so it also covers the signer's
/// workers and can forbid framing.
const WEB_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
    img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; \
    media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; \
    require-trusted-types-for 'script'; trusted-types cadence-worker; frame-ancestors 'none'";

/// The parts of contract v2 this runner implements (`features` in `GET /api/status`).
fn features(app: &App) -> Vec<&'static str> {
    let mut features = vec![];
    if app.funder.is_some() && app.cfg.network_name == "test" {
        features.push("fund_offer");
    }
    features
}

async fn status(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let t = now();
    let mut status = json!({
        "network": app.cfg.network_name,
        "tip": app.tip.load(Ordering::Relaxed),
        "drand_round": cadence_seal::round_at(&app.chain, t),
        "sandbox": app.funder.is_some() && app.cfg.network_name == "test",
        "features": features(&app),
        "scheduler": {
            "last_tick_at": app.health.last_tick_at.load(Ordering::Relaxed),
            "healthy": app.health.healthy(t),
        },
    });
    // How many customers a merchant has is the merchant's to know, as with the list;
    // the sandbox's merchant is its own demo wallet.
    if app.funder.is_some() || is_merchant(&app, &headers) {
        status["subscriptions"] = json!(app.store.lock().unwrap().count_subscriptions()?);
    }
    // The sandbox's faucet is a public demo wallet: show what it can still give away,
    // so anyone can see it is not running dry.
    if let Some(funder) = &app.funder {
        let tip = BlockHeight::from_u32(app.tip.load(Ordering::Relaxed));
        let db = app.wallet.lock().await;
        if let Ok(notes) = wallet::unspent_notes(&db, funder.account, tip + 1) {
            let balance: u64 = notes.iter().map(|n| n.note.value().inner()).sum();
            status["faucet"] = json!({ "balance_zat": balance, "notes": notes.len() });
        }
    }
    Ok(Json(status))
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
    let created = insert_offer(&app, req.name, req.amount_zat, req.period_secs, req.count, req.merchant_ua)?;
    Ok((StatusCode::CREATED, Json(created)))
}

/// Stores an offer and returns `{offer_id, share_url}`.
pub fn insert_offer(app: &App, name: String, amount_zat: u64, period_secs: u64, count: u32, merchant_ua: String) -> anyhow::Result<Value> {
    let offer = Offer {
        offer_id: random_id("off"),
        name,
        amount_zat,
        period_secs,
        count,
        merchant_ua,
        created_at: now(),
    };
    app.store.lock().unwrap().insert_offer(&offer)?;
    let view = offer_view(app, &offer);
    // The offer travels in the URL fragment, which browsers never send to a server.
    let app_url = app.cfg.app_url.as_deref().unwrap_or(&app.cfg.public_url);
    let share_url = format!(
        "{}/subscribe#offer={}",
        app_url.trim_end_matches('/'),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&view)?)
    );
    Ok(json!({ "offer_id": offer.offer_id, "share_url": share_url }))
}

async fn get_offer(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let offer = app.store.lock().unwrap().offer(&id)?.ok_or_else(not_found)?;
    Ok(Json(offer_view(&app, &offer)))
}

#[derive(Deserialize)]
struct NewPocket {
    pocket_ufvk: String,
}

/// Registered pockets that are neither funded nor forgotten yet, each an account the
/// wallet scans; past this, registration waits for some to be.
pub const MAX_PENDING_POCKETS: u64 = 1_000;

async fn create_pocket(
    State(app): State<Arc<App>>,
    Json(req): Json<NewPocket>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if app.store.lock().unwrap().count_pending_pockets()? >= MAX_PENDING_POCKETS {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "the runner is busy; try again later".into()));
    }
    let mut client = app.sync_client.clone();
    let server_tip = lwd::tip(&mut client).await?;
    let id = random_id("pkt");
    let (account, tip) = {
        let mut db = app.wallet.lock().await;
        // Adding an account rewinds the wallet to the block before its birthday, so the
        // birthday must lie past everything already scanned (and past a lagging server's
        // tip). Funding is only sent after registration, so it can't be missed.
        let tip = server_tip.max(db.chain_height()?.unwrap_or(server_tip));
        let account = wallet::import_pocket(&mut client, &mut db, &app.cfg.network, &req.pocket_ufvk, tip + 1, &id)
            .await
            .map_err(|e| bad(format!("{e:#}")))?;
        (account, tip)
    };
    app.store.lock().unwrap().insert_pocket(
        &id,
        &account.expose_uuid().to_string(),
        &req.pocket_ufvk,
        u32::from(tip) + 1,
        now(),
    )?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "pocket_id": id, "birthday_height": u32::from(tip) + 1, "tip": u32::from(tip) })),
    ))
}

async fn get_pocket(State(app): State<Arc<App>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let pocket = app.store.lock().unwrap().pocket(&id)?.ok_or_else(not_found)?;
    let tip = BlockHeight::from_u32(app.tip.load(Ordering::Relaxed));
    let account = parse_account(&pocket.account)?;
    // The pocket holds one live note. Until the wallet has scanned the block of the
    // latest mined installment, it still lists the note that installment spent.
    let settled = match &pocket.subscription_id {
        Some(sub) => app
            .store
            .lock()
            .unwrap()
            .subscription(sub)?
            .and_then(|s| s.installments.iter().filter_map(|i| i.mined_height).max()),
        None => None,
    };
    let (notes, syncing): (Vec<Value>, bool) = {
        let db = app.wallet.lock().await;
        // Until the wallet reaches that block, the change it left is not listed yet.
        let scanned = db.block_fully_scanned()?.map(|b| u32::from(b.block_height()));
        let syncing = settled.is_some_and(|h| scanned.is_none_or(|s| s < h));
        let notes = match wallet::pocket_fvk(&db, account) {
            Ok(fvk) => wallet::unspent_notes(&db, account, tip + 1)?
                .into_iter()
                .filter(|n| settled.is_none_or(|h| u32::from(n.mined) >= h))
                .map(|n| {
                    json!({
                        "nullifier": hex::encode(n.note.nullifier(&fvk).to_bytes()),
                        "value_zat": n.note.value().inner(),
                        "txid": n.txid.to_string(),
                        "mined_height": u32::from(n.mined),
                        "position": u64::from(n.position),
                    })
                })
                .collect(),
            // The pocket's account is deleted once its subscription ends.
            Err(_) => vec![],
        };
        (notes, syncing)
    };
    Ok(Json(json!({
        "pocket_id": pocket.pocket_id,
        "tip": u32::from(tip),
        "syncing": syncing,
        "birthday_height": pocket.birthday,
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

/// How much later than one period from the upload the first installment may be
/// sealed: signing takes a while, and the payer's clock may differ from ours.
pub const FIRST_RELEASE_SLACK_SECS: u64 = 600;

/// Checks an uploaded schedule, given as `(k, release_round)`, against the offer:
/// exactly `offer.count` installments numbered from 1, a pocket funded for all of
/// them and their fees, the first released within a period (plus
/// [`FIRST_RELEASE_SLACK_SECS`]) of `now`, and each later one a period after the one
/// before, give or take half a period. Otherwise a payer could hand the merchant a
/// ladder that pays a year late, or from a pocket that cannot cover it.
pub fn check_schedule(
    chain: &DrandChain,
    offer: &Offer,
    funded_zat: Option<u64>,
    rounds: &[(u32, u64)],
    now: u64,
) -> Result<(), String> {
    if rounds.len() != offer.count as usize {
        return Err(format!("expected {} installments, got {}", offer.count, rounds.len()));
    }
    if rounds.iter().enumerate().any(|(i, (k, _))| *k as usize != i + 1) {
        return Err(format!("installments must be numbered 1..={} in order", offer.count));
    }
    let need = offer
        .amount_zat
        .checked_add(u64::from(installment_fee()))
        .and_then(|per| per.checked_mul(u64::from(offer.count)))
        .ok_or("the offer's total overflows")?;
    match funded_zat {
        None => return Err("the runner has not seen the pocket's funding yet; retry once it is mined".into()),
        Some(value) if value < need => {
            return Err(format!(
                "the pocket holds {value} zats; {} installments of {} need {need} with their fees",
                offer.count, offer.amount_zat
            ))
        }
        Some(_) => {}
    }
    let times: Vec<u64> = rounds.iter().map(|(_, round)| cadence_seal::time_of(chain, *round)).collect();
    let latest_first = now.saturating_add(offer.period_secs).saturating_add(FIRST_RELEASE_SLACK_SECS);
    if let Some(&first) = times.first().filter(|t| **t > latest_first) {
        return Err(format!(
            "installment 1 releases {} s after the upload; the offer allows at most {} s",
            first - now,
            latest_first - now
        ));
    }
    let slack = offer.period_secs / 2;
    for (i, pair) in times.windows(2).enumerate() {
        let k = i + 2;
        match pair[1].checked_sub(pair[0]) {
            Some(gap) if gap.abs_diff(offer.period_secs) <= slack => {}
            Some(gap) => {
                return Err(format!(
                    "installment {k} releases {gap} s after installment {}; the offer says every {} s, give or take {slack} s",
                    k - 1,
                    offer.period_secs
                ))
            }
            None => return Err(format!("installment {k} releases before installment {}", k - 1)),
        }
    }
    Ok(())
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
    if let Some(existing) = &pocket.subscription_id {
        // A payer retrying an upload that landed after its page gave up sends the same
        // packages again: answer with the subscription they already made.
        return match app.store.lock().unwrap().subscription(existing)? {
            Some(sub) if same_packages(&sub, &req.installments) => {
                Ok((StatusCode::OK, Json(json!({ "subscription_id": sub.subscription_id, "status": sub.status }))))
            }
            _ => Err(bad("this pocket already backs a subscription; pockets are single-use")),
        };
    }
    let rounds: Vec<(u32, u64)> = req.installments.iter().map(|i| (i.k, i.release_round)).collect();
    check_schedule(&app.chain, &offer, pocket.funding.as_ref().map(|f| f.value_zat), &rounds, now())
        .map_err(bad)?;
    let mut installments = Vec::with_capacity(req.installments.len());
    for inst in &req.installments {
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

/// Whether an upload carries exactly the packages a subscription already holds.
fn same_packages(sub: &crate::store::Subscription, uploaded: &[NewInstallment]) -> bool {
    sub.installments.len() == uploaded.len()
        && sub.installments.iter().zip(uploaded).all(|(have, new)| {
            have.k == new.k
                && have.release_round == new.release_round
                && have.sealed.as_deref().is_some_and(|bytes| STANDARD.decode(&new.sealed).is_ok_and(|b| b == bytes))
        })
}

async fn list_subscriptions(State(app): State<Arc<App>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    // The testnet sandbox is a public demo whose merchant is its own wallet, so judges
    // can watch the merchant side; a real runner lists only for the merchant.
    if app.funder.is_none() {
        require_merchant(&app, &headers)?;
    }
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
    if !matches!(sub.status.as_str(), "active" | "stalled") {
        return Err(bad(format!("the subscription is already {}", sub.status)));
    }
    service::finish(&app, &sub, "stopped", None).await?;
    Ok(Json(json!({ "subscription_id": id, "status": "stopped" })))
}

/// How long a decode waits for one of the [`crate::decoder::DECODES_AT_ONCE`] turns.
const DECODE_QUEUE_SECS: u64 = 15;

async fn decode(State(app): State<Arc<App>>, Path(txid): Path<String>) -> ApiResult<Json<Value>> {
    let txid = parse_txid(&txid).map_err(|_| bad("not a txid"))?;
    // Mined shapes are kept, so visitors decoding the same txids do not each cost
    // thirteen lightwalletd lookups. Look again after waiting for a turn: a decode of
    // the same txid may have finished meanwhile.
    if let Some(shape) = app.decoder.cached(&txid) {
        return Ok(Json(shape));
    }
    let _turn = tokio::time::timeout(Duration::from_secs(DECODE_QUEUE_SECS), app.decoder.permits.acquire())
        .await
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "the decoder is busy; try again shortly".into()))??;
    if let Some(shape) = app.decoder.cached(&txid) {
        return Ok(Json(shape));
    }
    let mut client = app.decoder.client.clone();
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
    let mut shape = serde_json::to_value(cadence_decode::shape(&tx, mined, range, &[])).map_err(|e| anyhow!(e))?;
    // The nullifiers an Ironwood bundle reveals are public; a payer's cancellation
    // certificate checks that its spent note's nullifier is among them.
    if let Some(bundle) = tx.ironwood_bundle() {
        let nullifiers: Vec<String> = bundle.actions().iter().map(|a| hex::encode(a.nullifier().to_bytes())).collect();
        shape["ironwood_nullifiers"] = json!(nullifiers);
    }
    app.decoder.remember(txid, &shape, mined, app.tip.load(Ordering::Relaxed));
    Ok(Json(shape))
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::{atomic::AtomicU32, Mutex};

    use axum::{
        body::{to_bytes, Body},
        http::{header, Method, Request},
    };
    use cadence_seal::age::x25519;
    use tower::ServiceExt;
    use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
    use zcash_protocol::consensus::Network;

    use super::*;
    use crate::{
        decoder::Decoder,
        service::{Config, Funder},
        store::{Funding, Store},
    };

    pub const TOKEN: &str = "a-merchant-token-for-tests";
    const APP_ORIGIN: &str = "https://app.example";
    const NOW: u64 = 1_792_677_856;

    pub fn offer(count: u32, period_secs: u64) -> Offer {
        Offer {
            offer_id: "off_test".into(),
            name: "Test plan".into(),
            amount_zat: 20_000,
            period_secs,
            count,
            merchant_ua: String::new(),
            created_at: 0,
        }
    }

    pub fn prepaid(o: &Offer) -> u64 {
        u64::from(o.count) * (o.amount_zat + u64::from(installment_fee()))
    }

    /// What the CLI and the web app seal: installment k at the first drand round at or
    /// after `signed + lead + (k - 1) * period`.
    pub fn signed_schedule(chain: &DrandChain, o: &Offer, signed: u64, lead: u64) -> Vec<(u32, u64)> {
        (1..=o.count)
            .map(|k| {
                let at = signed + lead + u64::from(k - 1) * o.period_secs;
                (k, cadence_seal::first_round_at_or_after(chain, at))
            })
            .collect()
    }

    #[test]
    fn schedules_the_cli_and_the_web_app_sign_pass() {
        let chain = DrandChain::quicknet();
        for period in [10, 60, 90, 900, 30 * 86_400] {
            for count in [1, 2, 6, 12] {
                let o = offer(count, period);
                // The CLI's default --first-in 60 and the web's firstReleaseLead, signed
                // well before the upload, or on a clock running a few minutes fast.
                for lead in [60, period.min(60)] {
                    for signed in [NOW - 600, NOW, NOW + 300] {
                        let rounds = signed_schedule(&chain, &o, signed, lead);
                        assert_eq!(check_schedule(&chain, &o, Some(prepaid(&o)), &rounds, NOW), Ok(()));
                    }
                }
            }
        }
    }

    #[test]
    fn schedule_must_match_the_offer() {
        let chain = DrandChain::quicknet();
        let o = offer(3, 90);
        let rounds = signed_schedule(&chain, &o, NOW, 60);
        let check = |rounds: &[(u32, u64)]| check_schedule(&chain, &o, Some(prepaid(&o)), rounds, NOW);
        assert_eq!(check(&rounds), Ok(()));

        assert_eq!(check(&rounds[..2]), Err("expected 3 installments, got 2".into()));
        let renumbered = [(1, rounds[0].1), (3, rounds[1].1), (2, rounds[2].1)];
        assert_eq!(check(&renumbered), Err("installments must be numbered 1..=3 in order".into()));
        let backwards = [rounds[0], rounds[1], (3, rounds[1].1 - 1)];
        assert_eq!(check(&backwards), Err("installment 3 releases before installment 2".into()));

        // A year late, or squeezed in right after the one before.
        let mut stretched = rounds.clone();
        stretched[1].1 += 365 * 86_400 / chain.period;
        let err = check(&stretched).unwrap_err();
        assert!(err.starts_with("installment 2 releases 31536090 s after installment 1;"), "{err}");
        let mut squeezed = rounds.clone();
        squeezed[2].1 = squeezed[1].1 + 14;
        assert_eq!(
            check(&squeezed),
            Err("installment 3 releases 42 s after installment 2; the offer says every 90 s, give or take 45 s".into())
        );
        squeezed[2].1 = squeezed[1].1 + 15;
        assert_eq!(check(&squeezed), Ok(()));
    }

    #[test]
    fn first_installment_within_a_period_of_the_upload() {
        let chain = DrandChain::quicknet();
        let o = offer(2, 90);
        let check = |signed, lead| {
            check_schedule(&chain, &o, Some(prepaid(&o)), &signed_schedule(&chain, &o, signed, lead), NOW)
        };
        // Rounds are 3 s apart, so the first round at or after a time is up to 2 s later.
        assert_eq!(check(NOW, 90 + FIRST_RELEASE_SLACK_SECS - 2), Ok(()));
        let err = check(NOW, 90 + FIRST_RELEASE_SLACK_SECS + 1).unwrap_err();
        assert!(err.starts_with("installment 1 releases"), "{err}");
        assert!(err.ends_with("the offer allows at most 690 s"), "{err}");
        // An installment already due is released at once.
        assert_eq!(check(NOW - 86_400, 60), Ok(()));
    }

    #[test]
    fn pocket_must_cover_every_installment_and_fee() {
        let chain = DrandChain::quicknet();
        let o = offer(3, 90);
        let rounds = signed_schedule(&chain, &o, NOW, 60);
        let check = |funded| check_schedule(&chain, &o, funded, &rounds, NOW);
        assert_eq!(check(Some(prepaid(&o))), Ok(()));
        assert_eq!(
            check(Some(prepaid(&o) - 1)),
            Err("the pocket holds 89999 zats; 3 installments of 20000 need 90000 with their fees".into())
        );
        assert!(check(None).unwrap_err().contains("not seen the pocket's funding"));
        let huge = Offer { amount_zat: u64::MAX, ..o.clone() };
        assert_eq!(
            check_schedule(&chain, &huge, Some(u64::MAX), &rounds, NOW),
            Err("the offer's total overflows".into())
        );
    }

    /// A runner with an empty wallet and store in memory, and lightwalletd clients
    /// that never connect.
    pub fn test_app(sandbox: bool, app_url: Option<&str>) -> Arc<App> {
        let memory = std::path::Path::new(":memory:");
        let network = Network::TestNetwork;
        let mut wallet_db = wallet::open(memory, network).unwrap();
        wallet::init(&mut wallet_db).unwrap();
        let channel = tonic::transport::Endpoint::from_static("http://127.0.0.1:9").connect_lazy();
        let client = CompactTxStreamerClient::new(channel);
        let identity = x25519::Identity::generate();
        let funder = sandbox.then(|| Funder {
            pocket: cadence_core::Pocket::from_seed(&[7; 32], 1),
            account: parse_account("00000000-0000-0000-0000-000000000001").unwrap(),
            in_flight: Mutex::new(vec![]),
            funded: Mutex::new(Default::default()),
            queue: tokio::sync::Mutex::new(()),
            budget: Default::default(),
        });
        Arc::new(App {
            cfg: Config {
                network,
                network_name: "test",
                public_url: "https://runner.example".into(),
                app_url: app_url.map(String::from),
                merchant_token: TOKEN.into(),
                webhook_url: None,
                webhook_secret: None,
                drand_url: cadence_seal::DEFAULT_RELAY.into(),
                tick: Duration::from_secs(10),
                trust_forwarded: false,
            },
            funder,
            tor: None,
            wallet: tokio::sync::Mutex::new(wallet_db),
            store: Mutex::new(Store::open(memory).unwrap()),
            sync_client: client.clone(),
            broadcast_client: client.clone(),
            decoder: Decoder::new(client),
            health: Default::default(),
            recipient: identity.to_public().to_string(),
            identity,
            chain: DrandChain::quicknet(),
            tip: AtomicU32::new(0),
        })
    }

    /// A built web app of one page, shared by the tests in this process.
    fn web_dir() -> PathBuf {
        static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        DIR.get_or_init(|| {
            let dir = std::env::temp_dir().join(random_id("cadence-web-test"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();
            dir
        })
        .clone()
    }

    fn cors() -> Vec<HeaderValue> {
        vec![HeaderValue::from_static(APP_ORIGIN)]
    }

    pub async fn send(router: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Value) {
        let res = router.clone().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = to_bytes(body, 1 << 20).await.unwrap();
        (parts.status, parts.headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn get(path: &str, origin: Option<&str>, token: Option<&str>) -> Request<Body> {
        let mut req = Request::get(path);
        if let Some(o) = origin {
            req = req.header(header::ORIGIN, o);
        }
        if let Some(t) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        req.body(Body::empty()).unwrap()
    }

    fn preflight(path: &str, origin: &str) -> Request<Body> {
        Request::builder()
            .method(Method::OPTIONS)
            .uri(path)
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type,authorization")
            .body(Body::empty())
            .unwrap()
    }

    fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        headers.get(name).and_then(|v| v.to_str().ok())
    }

    fn varies_by_origin(headers: &HeaderMap) -> bool {
        headers
            .get_all(header::VARY)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|v| v.trim().eq_ignore_ascii_case("origin"))
    }

    #[tokio::test]
    async fn status_shows_the_customer_count_only_to_the_merchant() {
        let api = router(test_app(false, None), None, vec![]);
        let (status, _, body) = send(&api, get("/api/status", None, None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["network"], "test");
        assert_eq!(body["sandbox"], false);
        assert!(body.get("subscriptions").is_none(), "{body}");
        let (_, _, body) = send(&api, get("/api/status", None, Some("not-the-merchant-token"))).await;
        assert!(body.get("subscriptions").is_none(), "{body}");
        let (_, _, body) = send(&api, get("/api/status", None, Some(TOKEN))).await;
        assert_eq!(body["subscriptions"], 0);

        // The sandbox's merchant is its own demo wallet.
        let sandbox = router(test_app(true, None), None, vec![]);
        let (_, _, body) = send(&sandbox, get("/api/status", None, None)).await;
        assert_eq!(body["sandbox"], true);
        assert_eq!(body["subscriptions"], 0);
    }

    #[tokio::test]
    async fn status_reports_features_and_the_schedulers_health() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let (_, _, body) = send(&api, get("/api/status", None, None)).await;
        assert_eq!(body["features"], json!([]));
        // No tick has finished yet.
        assert_eq!(body["scheduler"], json!({ "last_tick_at": 0, "healthy": false }));

        let t = now();
        app.health.last_tick_at.store(t, Ordering::Relaxed);
        let (_, _, body) = send(&api, get("/api/status", None, None)).await;
        assert_eq!(body["scheduler"], json!({ "last_tick_at": t, "healthy": true }));
        app.health.sync_failed.store(true, Ordering::Relaxed);
        let (_, _, body) = send(&api, get("/api/status", None, None)).await;
        assert_eq!(body["scheduler"]["healthy"], false);

        // Healthy only within three minutes of the last tick, and with the sync working.
        app.health.sync_failed.store(false, Ordering::Relaxed);
        assert!(app.health.healthy(t + service::STALE_TICK_SECS - 1));
        assert!(!app.health.healthy(t + service::STALE_TICK_SECS));

        let sandbox = router(test_app(true, None), None, vec![]);
        let (_, _, body) = send(&sandbox, get("/api/status", None, None)).await;
        assert_eq!(body["features"], json!(["fund_offer"]));
    }

    #[tokio::test]
    async fn cors_preflight_answers_only_the_allowed_origin() {
        let api = router(test_app(false, None), Some(web_dir()), cors());
        let (status, headers, _) = send(&api, preflight("/api/subscriptions", APP_ORIGIN)).await;
        assert!(status.is_success(), "{status}");
        assert_eq!(header_str(&headers, "access-control-allow-origin"), Some(APP_ORIGIN));
        let methods = header_str(&headers, "access-control-allow-methods").unwrap().to_ascii_uppercase();
        for m in ["GET", "POST", "OPTIONS"] {
            assert!(methods.contains(m), "{methods}");
        }
        let allowed = header_str(&headers, "access-control-allow-headers").unwrap().to_ascii_lowercase();
        assert!(allowed.contains("content-type") && allowed.contains("authorization"), "{allowed}");
        assert!(headers.get("access-control-allow-credentials").is_none());
        assert!(varies_by_origin(&headers));
        assert_eq!(header_str(&headers, "cross-origin-resource-policy"), Some("cross-origin"));

        let (_, headers, _) = send(&api, preflight("/api/subscriptions", "https://elsewhere.example")).await;
        assert!(headers.get("access-control-allow-origin").is_none());
        assert!(varies_by_origin(&headers));
    }

    #[tokio::test]
    async fn cors_get_is_readable_only_from_the_allowed_origin() {
        let api = router(test_app(false, None), Some(web_dir()), cors());
        let (status, headers, body) = send(&api, get("/api/status", Some(APP_ORIGIN), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["network"], "test");
        assert_eq!(header_str(&headers, "access-control-allow-origin"), Some(APP_ORIGIN));
        assert!(headers.get("access-control-allow-credentials").is_none());
        assert!(varies_by_origin(&headers));
        assert_eq!(header_str(&headers, "cross-origin-resource-policy"), Some("cross-origin"));

        let (status, headers, _) = send(&api, get("/api/status", Some("https://elsewhere.example"), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers.get("access-control-allow-origin").is_none());

        // The web app's own files stay same-origin, without CORS.
        let (status, headers, _) = send(&api, get("/subscribe", Some(APP_ORIGIN), None)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers.get("access-control-allow-origin").is_none());
        assert_eq!(header_str(&headers, "cross-origin-resource-policy"), Some("same-origin"));
        assert_eq!(header_str(&headers, "cross-origin-embedder-policy"), Some("require-corp"));
    }

    #[tokio::test]
    async fn no_cors_unless_configured() {
        let api = router(test_app(false, None), Some(web_dir()), vec![]);
        let (_, headers, _) = send(&api, get("/api/status", Some(APP_ORIGIN), None)).await;
        assert!(headers.get("access-control-allow-origin").is_none());
        assert_eq!(header_str(&headers, "cross-origin-resource-policy"), Some("same-origin"));
        let (_, headers, _) = send(&api, preflight("/api/subscriptions", APP_ORIGIN)).await;
        assert!(headers.get("access-control-allow-origin").is_none());
    }

    #[tokio::test]
    async fn decoded_shapes_are_served_from_the_cache() {
        // No lightwalletd is reachable, so only the cache can answer.
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let txid = "ab".repeat(32);
        let shape = json!({ "txid": txid, "mined_height": 4_529_248 });
        let mined = Some(BlockHeight::from_u32(4_529_248));
        app.decoder.remember(parse_txid(&txid).unwrap(), &shape, mined, 4_529_300);
        let (status, _, body) = send(&api, get(&format!("/api/decode/{txid}"), None, None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, shape);
        // Anything else asks lightwalletd, over the decoder's own channel.
        let (status, _, _) = send(&api, get(&format!("/api/decode/{}", "cd".repeat(32)), None, None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(app.decoder.permits.available_permits(), crate::decoder::DECODES_AT_ONCE);
    }

    #[tokio::test]
    async fn pocket_registration_waits_while_too_many_are_unfunded() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let register = || {
            Request::post("/api/pockets")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(json!({ "pocket_ufvk": "uview-test" }).to_string()))
                .unwrap()
        };
        {
            let store = app.store.lock().unwrap();
            for n in 0..MAX_PENDING_POCKETS {
                store.insert_pocket(&format!("pkt_{n}"), "00000000-0000-0000-0000-000000000002", "uview-test", 1, now()).unwrap();
            }
        }
        let (status, _, body) = send(&api, register()).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "the runner is busy; try again later");
        // A funded pocket no longer counts; registering then goes on to lightwalletd.
        let funding = Funding { txid: "00".repeat(32), tx_hex: String::new(), mined_height: 1, value_zat: 1 };
        app.store.lock().unwrap().set_funding("pkt_0", &funding).unwrap();
        let (status, _, body) = send(&api, register()).await;
        assert_ne!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    }

    #[tokio::test]
    async fn share_links_point_at_the_app() {
        let share_url = |v: &Value| v["share_url"].as_str().unwrap().to_string();
        let app = test_app(false, None);
        let own = share_url(&insert_offer(&app, "Plan".into(), 20_000, 90, 3, String::new()).unwrap());
        assert!(own.starts_with("https://runner.example/subscribe#offer="), "{own}");
        let app = test_app(false, Some("https://app.example/"));
        let elsewhere = share_url(&insert_offer(&app, "Plan".into(), 20_000, 90, 3, String::new()).unwrap());
        assert!(elsewhere.starts_with("https://app.example/subscribe#offer="), "{elsewhere}");
        // The offer still names this runner as the API to call.
        let encoded = elsewhere.split("#offer=").nth(1).unwrap();
        let view: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        assert_eq!(view["runner_endpoint"], "https://runner.example");
    }

    /// An offer, and a pocket the runner has seen funded with `funded_zat`.
    pub fn subscribable(app: &App, count: u32, period_secs: u64, funded_zat: Option<u64>) -> (String, String) {
        let created = insert_offer(app, "Plan".into(), 20_000, period_secs, count, String::new()).unwrap();
        let offer_id = created["offer_id"].as_str().unwrap().to_string();
        let pocket_id = random_id("pkt");
        let store = app.store.lock().unwrap();
        store
            .insert_pocket(&pocket_id, "00000000-0000-0000-0000-000000000002", "uview-test", 1, now())
            .unwrap();
        if let Some(value_zat) = funded_zat {
            let funding = Funding { txid: "00".repeat(32), tx_hex: String::new(), mined_height: 1, value_zat };
            store.set_funding(&pocket_id, &funding).unwrap();
        }
        (offer_id, pocket_id)
    }

    pub fn upload(app: &App, offer_id: &str, pocket_id: &str, rounds: &[(u32, u64)]) -> Request<Body> {
        let recipient = app.identity.to_public();
        let installments: Vec<Value> = rounds
            .iter()
            .map(|(k, round)| {
                let sealed = cadence_seal::seal(b"{}", &recipient, &app.chain, *round).unwrap();
                json!({ "k": k, "release_round": round, "sealed": STANDARD.encode(sealed) })
            })
            .collect();
        let body = json!({ "offer_id": offer_id, "pocket_id": pocket_id, "installments": installments });
        Request::post("/api/subscriptions")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn upload_body(offer_id: &str, pocket_id: &str, body: &Value) -> Request<Body> {
        let mut body = body.clone();
        body["offer_id"] = json!(offer_id);
        body["pocket_id"] = json!(pocket_id);
        Request::post("/api/subscriptions")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn the_same_upload_again_returns_the_same_subscription() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let o = offer(2, 90);
        let fair = signed_schedule(&app.chain, &o, now(), 60);
        let (offer_id, pocket_id) = subscribable(&app, 2, 90, Some(prepaid(&o)));
        let first = upload(&app, &offer_id, &pocket_id, &fair);
        let bytes = axum::body::to_bytes(first.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();

        let (status, _, made) = send(&api, upload_body(&offer_id, &pocket_id, &body)).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        let (status, _, again) = send(&api, upload_body(&offer_id, &pocket_id, &body)).await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(again["subscription_id"], made["subscription_id"]);
        // Different packages for the same pocket are still refused.
        let (status, _, other) = send(&api, upload(&app, &offer_id, &pocket_id, &fair)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{other}");
        assert!(other["error"].as_str().unwrap().contains("single-use"), "{other}");
    }

    #[tokio::test]
    async fn uploads_are_checked_against_the_offer() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let o = offer(2, 90);
        let fair = signed_schedule(&app.chain, &o, now(), 60);
        let mut stretched = fair.clone();
        stretched[1].1 += 365 * 86_400 / app.chain.period;

        let (offer_id, pocket_id) = subscribable(&app, 2, 90, Some(prepaid(&o)));
        let (status, _, body) = send(&api, upload(&app, &offer_id, &pocket_id, &stretched)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().starts_with("installment 2 releases"), "{body}");
        let (status, _, body) = send(&api, upload(&app, &offer_id, &pocket_id, &fair)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");

        let (offer_id, pocket_id) = subscribable(&app, 2, 90, None);
        let (status, _, body) = send(&api, upload(&app, &offer_id, &pocket_id, &fair)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("not seen the pocket's funding"), "{body}");
    }
}

