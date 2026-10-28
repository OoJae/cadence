//! The runner's scheduler: open each installment when its drand round passes,
//! release it once its input is anchor-deep, and follow it until it is mined.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use cadence_chain::{
    lwd,
    wallet::{self, Db, ANCHOR_CONFIRMATIONS},
};
use cadence_core::package::{verify_rung, InstallmentLadder, RungPackage};
use cadence_seal::{age::x25519, DrandChain};
use orchard::note::Nullifier;
use pczt::Pczt;
use zcash_client_backend::data_api::{WalletRead, WalletWrite};
use zcash_client_sqlite::AccountUuid;
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::{
    decoder::Decoder,
    refund,
    store::{Funding, Installment, Pocket, Store, Subscription},
    webhook::{self, Event},
};

pub struct Config {
    pub network: Network,
    pub network_name: &'static str,
    pub public_url: String,
    /// Where the web app is hosted when this runner does not serve it.
    pub app_url: Option<String>,
    pub merchant_token: String,
    pub webhook_url: Option<String>,
    pub webhook_secret: Option<String>,
    pub drand_url: String,
    pub tick: Duration,
    /// Take each client's address from the first `X-Forwarded-For` hop, for the rate
    /// limits: only behind a proxy that sets it (`CADENCE_TRUST_FORWARDED`).
    pub trust_forwarded: bool,
}

/// The testnet sandbox's own (custodial, disclosed) wallet that funds judges' pockets.
pub struct Funder {
    pub pocket: cadence_core::Pocket,
    pub account: AccountUuid,
    /// Notes spent by payments that are not mined yet.
    pub in_flight: Mutex<Vec<Nullifier>>,
    /// Pockets already funded, so each gets one payment.
    pub funded: Mutex<std::collections::HashSet<String>>,
    /// One payment at a time.
    pub queue: tokio::sync::Mutex<()>,
    /// Fundings in the last hour, against the faucet's hourly limits.
    pub budget: Mutex<crate::sandbox::Budget>,
}

pub struct App {
    pub cfg: Config,
    pub funder: Option<Funder>,
    /// Fetches drand beacons over Tor, so the relay learns neither the runner's
    /// address nor, from it, the release schedule. `None` with `--drand-direct`.
    pub tor: Option<zcash_client_backend::tor::Client>,
    pub wallet: tokio::sync::Mutex<Db>,
    pub store: Mutex<Store>,
    pub sync_client: lwd::Client,
    pub broadcast_client: lwd::Client,
    /// `GET /api/decode`'s own connection, cache and cap, so visitors never queue
    /// behind the scheduler.
    pub decoder: Decoder,
    pub health: Health,
    pub identity: x25519::Identity,
    pub recipient: String,
    pub chain: DrandChain,
    pub tip: AtomicU32,
    /// Signs access passes (`pass.rs`).
    pub pass_key: ed25519_dalek::SigningKey,
    /// Payer signatures already accepted (`payer_auth.rs`).
    pub payer_replays: crate::payer_auth::Replays,
}

impl App {
    /// The testnet sandbox: a public demo with its own faucet wallet.
    pub fn sandbox(&self) -> bool {
        self.funder.is_some() && self.cfg.network_name == "test"
    }
}

/// The scheduler is unhealthy once it has not finished a tick for this long.
pub const STALE_TICK_SECS: u64 = 180;

/// What `GET /api/status` reports of the scheduler (`scheduler`).
#[derive(Default)]
pub struct Health {
    /// When the last tick finished, in UNIX seconds; 0 until the first has.
    pub last_tick_at: AtomicU64,
    /// Whether the last tick failed to reach the chain tip or to sync the wallet.
    pub sync_failed: AtomicBool,
}

impl Health {
    pub fn healthy(&self, now: u64) -> bool {
        now.saturating_sub(self.last_tick_at.load(Ordering::Relaxed)) < STALE_TICK_SECS
            && !self.sync_failed.load(Ordering::Relaxed)
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn parse_account(s: &str) -> Result<AccountUuid> {
    Ok(AccountUuid::from_uuid(s.parse::<uuid::Uuid>().context("bad account id")?))
}

pub fn parse_txid(display_hex: &str) -> Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(display_hex)?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

pub fn parse_nullifier(hex_str: &str) -> Result<Nullifier> {
    let bytes: [u8; 32] = hex::decode(hex_str)?
        .try_into()
        .map_err(|_| anyhow!("nullifier must be 32 bytes"))?;
    Option::from(Nullifier::from_bytes(&bytes)).context("invalid nullifier")
}

pub async fn run(app: Arc<App>) {
    loop {
        if let Err(e) = tick(&app).await {
            eprintln!("tick failed: {e:#}");
        }
        app.health.last_tick_at.store(now(), Ordering::Relaxed);
        tokio::time::sleep(app.cfg.tick).await;
    }
}

async fn tick(app: &App) -> Result<()> {
    if let Err(e) = refund::expire(app, now()).await {
        eprintln!("shredding kept pockets: {e:#}");
    }
    let mut client = app.sync_client.clone();
    let synced = sync_chain(app, &mut client).await;
    app.health.sync_failed.store(synced.is_err(), Ordering::Relaxed);
    let Some(tip) = synced? else { return Ok(()) };
    record_fundings(app, &mut client, tip).await?;
    forget_abandoned(app, tip).await?;
    if let Err(e) = refund::watch(app, tip, now()).await {
        eprintln!("watching kept pockets: {e:#}");
    }

    let round_now = cadence_seal::round_at(&app.chain, now());
    let subs = app.store.lock().unwrap().subscriptions(true)?;
    for sub in subs {
        if let Err(e) = advance(app, &mut client, &sub, tip, round_now).await {
            eprintln!("{}: {e:#}", sub.subscription_id);
        }
    }
    Ok(())
}

/// The chain tip, with the wallet scanned up to it. `None` while the wallet holds no
/// pocket: there is no birthday to scan from, and nothing to find.
async fn sync_chain(app: &App, client: &mut lwd::Client) -> Result<Option<BlockHeight>> {
    let tip = lwd::tip(client).await?;
    app.tip.store(u32::from(tip), Ordering::Relaxed);
    let mut db = app.wallet.lock().await;
    if db.get_account_ids()?.is_empty() {
        return Ok(None);
    }
    wallet::sync(client, &app.cfg.network, &mut db).await?;
    Ok(Some(tip))
}

/// Remembers each pocket's funding transaction the first time its note is seen.
async fn record_fundings(app: &App, client: &mut lwd::Client, tip: BlockHeight) -> Result<()> {
    let pockets = app.store.lock().unwrap().unfunded_pockets()?;
    for pocket in pockets {
        let account = parse_account(&pocket.account)?;
        let first = {
            let db = app.wallet.lock().await;
            wallet::unspent_notes(&db, account, tip + 1)?
                .into_iter()
                .min_by_key(|n| n.mined)
        };
        if let Some(note) = first {
            let (bytes, _) = lwd::raw_transaction(client, &note.txid).await?;
            let funding = Funding {
                txid: note.txid.to_string(),
                tx_hex: hex::encode(bytes),
                mined_height: u32::from(note.mined),
                value_zat: note.note.value().inner(),
            };
            println!("pocket {}: funded by {} at {}", pocket.pocket_id, funding.txid, funding.mined_height);
            app.store.lock().unwrap().set_funding(&pocket.pocket_id, &funding)?;
        }
    }
    Ok(())
}

/// How long a registered pocket may wait for its funding before it is forgotten.
pub const UNFUNDED_POCKET_SECS: u64 = 2 * 60 * 60;
/// How long a funded pocket may wait for its packages.
pub const UNSUBSCRIBED_POCKET_SECS: u64 = 7 * 24 * 60 * 60;

/// Unfunded pockets are forgotten after two hours; funded ones whose payer never
/// uploaded packages after a week. The funds stay the payer's (`cadence sweep`).
/// A pocket counts as unfunded only if `record_fundings` has recorded no funding and
/// the wallet, scanned to `tip`, holds no note for it either, so one funded but not
/// yet subscribed is kept for the week.
async fn forget_abandoned(app: &App, tip: BlockHeight) -> Result<()> {
    let t = now();
    let pockets = app.store.lock().unwrap().abandoned_pockets(
        t.saturating_sub(UNFUNDED_POCKET_SECS),
        t.saturating_sub(UNSUBSCRIBED_POCKET_SECS),
    )?;
    for pocket in pockets {
        let account = parse_account(&pocket.account)?;
        let mut db = app.wallet.lock().await;
        if pocket.funding.is_none() && !wallet::unspent_notes(&db, account, tip + 1)?.is_empty() {
            continue;
        }
        db.delete_account(account)?;
        drop(db);
        app.store.lock().unwrap().delete_pocket(&pocket.pocket_id)?;
        println!("pocket {}: abandoned; deleted", pocket.pocket_id);
    }
    Ok(())
}

async fn advance(
    app: &App,
    client: &mut lwd::Client,
    sub: &Subscription,
    tip: BlockHeight,
    round_now: u64,
) -> Result<()> {
    let Some(pos) = next_unmined(sub) else {
        return finish(app, sub, "completed", None).await;
    };
    let inst = &sub.installments[pos];
    let previous = pos.checked_sub(1).map(|p| &sub.installments[p]);
    if watches_for_cancel(inst)
        && pocket_emptied(app, sub, previous, tip).await?
        && payer_cancelled(app, client, sub, inst, previous).await?
    {
        println!("{} #{}: the pocket was emptied by the payer: cancelled", sub.subscription_id, inst.k);
        return finish(app, sub, "cancelled", Some(inst)).await;
    }
    match action(inst, round_now) {
        Action::Open => {
            let round = inst.release_round;
            let beacon = fetch_beacon(app, round).await?;
            app.store.lock().unwrap().set_beacon(&sub.subscription_id, inst.k, &beacon)?;
            println!("{} #{}: round {round} passed, package opened", sub.subscription_id, inst.k);
            // Release in this tick: waiting for the next one costs a block or more, and
            // a send mined late reads as one in the expiry its rung carries.
            let sub = app
                .store
                .lock()
                .unwrap()
                .subscription(&sub.subscription_id)?
                .context("subscription vanished")?;
            let previous = pos.checked_sub(1).map(|p| &sub.installments[p]);
            release(app, client, &sub, &sub.installments[pos], previous, tip).await
        }
        Action::Release => release(app, client, sub, inst, previous, tip).await,
        Action::Confirm => confirm(app, client, sub, inst, tip).await,
        Action::Wait => Ok(()),
    }
}

/// The installment a tick works on: the first not yet mined. `None` once all are.
fn next_unmined(sub: &Subscription) -> Option<usize> {
    sub.installments.iter().position(|i| i.state != "mined")
}

/// Whether the scheduler first checks that the payer has not emptied the pocket. A
/// missed or invalid installment waits for the payer, who may sweep instead.
fn watches_for_cancel(inst: &Installment) -> bool {
    matches!(inst.state.as_str(), "sealed" | "missed" | "invalid")
}

/// What a tick does with the installment it works on.
#[derive(Debug, PartialEq)]
enum Action {
    /// Its drand round has passed: fetch the beacon, open the package and release.
    Open,
    /// Opened: release it once its input is anchor-deep and a rung fits the tip.
    Release,
    /// Broadcast: see whether it was mined, or lapsed and must be released again.
    Confirm,
    Wait,
}

fn action(inst: &Installment, round_now: u64) -> Action {
    match inst.state.as_str() {
        "sealed" if round_now >= inst.release_round => Action::Open,
        "due" => Action::Release,
        "broadcast" => Action::Confirm,
        _ => Action::Wait,
    }
}

/// When an installment's input appeared on chain: the funding note for #1, else the
/// change of #k-1. `None` until it is mined.
fn input_height(pocket: &Pocket, previous: Option<&Installment>) -> Option<u32> {
    match previous {
        None => pocket.funding.as_ref().map(|f| f.mined_height),
        Some(p) => p.mined_height,
    }
}

/// Whether a note mined at `height` is [`ANCHOR_CONFIRMATIONS`] deep at `tip`, so that
/// the wallet's view of whether it is spent can be trusted.
fn settled(height: u32, tip: BlockHeight) -> bool {
    u32::from(tip) >= height + ANCHOR_CONFIRMATIONS
}

/// Whether a note mined at `mined` can be spent by a transaction for `target`, whose
/// anchor is [`ANCHOR_CONFIRMATIONS`] blocks behind it, as stock wallets anchor.
fn anchor_deep(mined: BlockHeight, target: BlockHeight) -> bool {
    mined <= target - ANCHOR_CONFIRMATIONS
}

/// Which rung of a ladder to release when the next block is `target`.
enum RungChoice<'a> {
    /// The rung signed for exactly `target`. Fail closed: only it carries the expiry a
    /// fresh send would carry now.
    Signed(&'a RungPackage),
    /// `target` is past every rung, so the installment can never be released.
    Missed,
    /// No rung for `target` yet: wait for the chain.
    Wait,
}

fn choose_rung(rungs: &[RungPackage], target: u32) -> RungChoice<'_> {
    if let Some(rung) = rungs.iter().find(|r| r.target_height == target) {
        return RungChoice::Signed(rung);
    }
    let last = rungs.iter().map(|r| r.target_height).max().unwrap_or(0);
    if target > last {
        RungChoice::Missed
    } else {
        RungChoice::Wait
    }
}

/// A pocket holds exactly one live note between installments. If it holds none once
/// the previous installment (or the funding) is anchor-deep, the payer has spent it:
/// the remaining installments can never become valid, so the merchant learns now
/// rather than when the next one falls due.
async fn pocket_emptied(app: &App, sub: &Subscription, previous: Option<&Installment>, tip: BlockHeight) -> Result<bool> {
    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let Some(h) = input_height(&pocket, previous) else { return Ok(false) };
    if !settled(h, tip) {
        return Ok(false);
    }
    let account = parse_account(&pocket.account)?;
    let db = app.wallet.lock().await;
    Ok(wallet::unspent_notes(&db, account, tip + 1)?.is_empty())
}

/// The wallet sees no live note. Before calling that a cancel, rule out the two ways
/// it happens without the payer: our own broadcast of this installment was mined but
/// not yet recorded, or a reorg took out the transaction that created the input.
async fn payer_cancelled(
    app: &App,
    client: &mut lwd::Client,
    sub: &Subscription,
    inst: &Installment,
    previous: Option<&Installment>,
) -> Result<bool> {
    if let Some(txid) = inst.txid.as_deref() {
        if let Ok((_, Some(height))) = lwd::raw_transaction(client, &parse_txid(txid)?).await {
            println!("{} #{}: our broadcast {txid} was mined at {height}", sub.subscription_id, inst.k);
            record_mined(app, sub, inst, u32::from(height)).await?;
            return Ok(false);
        }
    }
    let parent = match previous {
        None => {
            let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
            pocket.funding.map(|f| f.txid)
        }
        Some(p) => p.txid.clone(),
    };
    let Some(parent) = parent else { return Ok(false) };
    Ok(matches!(lwd::raw_transaction(client, &parse_txid(&parent)?).await, Ok((_, Some(_)))))
}

/// The drand signature for `round`, verified against the chain's public key.
pub async fn fetch_beacon(app: &App, round: u64) -> Result<Vec<u8>> {
    match &app.tor {
        Some(tor) => {
            use zcash_client_backend::tor::http::Retry;
            let url = cadence_seal::beacon_url(&app.cfg.drand_url, &app.chain, round);
            let response = tor
                .http_get_json::<serde_json::Value>(
                    url.parse()?,
                    |req| req,
                    2,
                    |res| res.is_err().then_some(Retry::Isolated),
                )
                .await
                .map_err(|e| anyhow!("drand round {round} over Tor: {e:?}"))?;
            let body = serde_json::to_vec(response.body())?;
            cadence_seal::parse_beacon_json(&body, &app.chain, round)
                .map_err(|e| anyhow!("drand round {round}: {e:?}"))
        }
        None => {
            let chain = app.chain.clone();
            let url = app.cfg.drand_url.clone();
            tokio::task::spawn_blocking(move || cadence_seal::fetch_signature(&url, &chain, round))
                .await?
                .map_err(|e| anyhow!("drand round {round}: {e:?}"))
        }
    }
}

async fn release(
    app: &App,
    client: &mut lwd::Client,
    sub: &Subscription,
    inst: &Installment,
    previous: Option<&Installment>,
    tip: BlockHeight,
) -> Result<()> {
    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let account = parse_account(&pocket.account)?;
    let sealed = inst.sealed.as_ref().context("package already shredded")?;
    let beacon = inst.beacon.as_ref().context("no beacon recorded")?;
    // Opening is deterministic once the beacon is verified, so a failure is final.
    let plain = match cadence_seal::open(sealed, &app.identity, &app.chain, beacon) {
        Ok(plain) => plain,
        Err(e) => return reject(app, sub, inst, &format!("the package does not open: {e:?}")),
    };
    let ladder: InstallmentLadder = match serde_json::from_slice(&plain) {
        Ok(ladder) => ladder,
        Err(e) => return reject(app, sub, inst, &format!("the package is malformed: {e}")),
    };
    if ladder.k != inst.k || ladder.amount_zat != inst.amount_zat {
        return reject(app, sub, inst, "the package is for a different installment or amount");
    }
    let nf = parse_nullifier(&ladder.spends_nullifier)?;

    let input_height = input_height(&pocket, previous);
    // Target the block after the tip as it is now, not as it was when this tick
    // began: the sync, the beacon fetch and earlier subscriptions take seconds over
    // Tor. If the chain moved, catch the wallet up so the anchor below is scanned.
    let fresh = lwd::tip(client).await?;
    let tip = if fresh > tip {
        let mut db = app.wallet.lock().await;
        wallet::sync(client, &app.cfg.network, &mut db).await?;
        app.tip.store(u32::from(fresh), Ordering::Relaxed);
        fresh
    } else {
        tip
    };
    let target = tip + 1;
    let anchor_height = target - ANCHOR_CONFIRMATIONS;

    let mut db = app.wallet.lock().await;
    let fvk = wallet::pocket_fvk(&db, account)?;
    let Some(input) = wallet::find_unspent(&db, account, &fvk, &nf, target)? else {
        if let Some(h) = input_height {
            if settled(h, tip) {
                drop(db);
                if payer_cancelled(app, client, sub, inst, previous).await? {
                    println!("{} #{}: input spent by the payer: cancelled", sub.subscription_id, inst.k);
                    return finish(app, sub, "cancelled", Some(inst)).await;
                }
            }
        }
        return Ok(());
    };
    if !anchor_deep(input.mined, target) {
        return Ok(());
    }

    let rung = match choose_rung(&ladder.rungs, u32::from(target)) {
        RungChoice::Signed(rung) => rung,
        RungChoice::Missed => {
            drop(db);
            println!("{} #{}: no rung for target {target}: missed", sub.subscription_id, inst.k);
            app.store
                .lock()
                .unwrap()
                .stall(&sub.subscription_id, inst.k, "missed", now() + refund::REFUND_KEEP_SECS)?;
            send_webhook(app, Event::expired(sub, inst));
            return Ok(());
        }
        RungChoice::Wait => return Ok(()),
    };

    // Broadcast only what the payer agreed to: the offer's merchant and amount, down
    // to the note commitment, with the expiry a fresh send would carry now.
    let pczt = Pczt::parse(&hex::decode(&rung.pczt)?).map_err(|e| anyhow!("{e:?}"))?;
    let merchant_ua = app
        .store
        .lock()
        .unwrap()
        .offer(&sub.offer_id)?
        .context("unknown offer")?
        .merchant_ua;
    let merchant = orchard_receiver(&app.cfg.network, &merchant_ua)?;
    if let Err(why) = verify_rung(&app.cfg.network, &pczt, &merchant, inst.amount_zat, target) {
        drop(db);
        return reject(app, sub, inst, &why);
    }

    let (anchor, witness) = wallet::anchor_and_witness(&mut db, input.position, anchor_height)?;
    drop(db);
    wallet::check_anchor(client, &anchor, anchor_height).await?;
    let tx = tokio::task::spawn_blocking(move || wallet::complete(pczt, anchor, witness)).await??;
    let mut broadcaster = app.broadcast_client.clone();
    let txid = wallet::broadcast(&mut broadcaster, &tx).await?;
    println!(
        "{} #{}: broadcast {txid} for target {target} (anchor {anchor_height})",
        sub.subscription_id, inst.k
    );
    app.store.lock().unwrap().set_broadcast(
        &sub.subscription_id,
        inst.k,
        &txid.to_string(),
        u32::from(target),
        rung.expiry_height,
    )?;
    Ok(())
}

async fn confirm(
    app: &App,
    client: &mut lwd::Client,
    sub: &Subscription,
    inst: &Installment,
    tip: BlockHeight,
) -> Result<()> {
    let txid = parse_txid(inst.txid.as_deref().context("broadcast without txid")?)?;
    if let Ok((_, Some(height))) = lwd::raw_transaction(client, &txid).await {
        println!("{} #{}: mined at {height}", sub.subscription_id, inst.k);
        record_mined(app, sub, inst, u32::from(height)).await?;
    } else if lapsed(&app.cfg.network, inst, tip) {
        app.store.lock().unwrap().set_state(&sub.subscription_id, inst.k, "due")?;
    }
    Ok(())
}

/// Whether an unmined broadcast can never be mined: expired, or signed for a branch
/// an upgrade has since replaced. It is then released again with the rung for the new tip.
fn lapsed(network: &Network, inst: &Installment, tip: BlockHeight) -> bool {
    inst.expiry_height.is_some_and(|e| u32::from(tip) > e) || branch_passed(network, inst, tip)
}

/// Whether a network upgrade has activated since the broadcast rung's target, so
/// that it can never be mined although its expiry has not passed.
fn branch_passed(network: &Network, inst: &Installment, tip: BlockHeight) -> bool {
    use zcash_protocol::consensus::BranchId;
    inst.target_height.is_some_and(|t| {
        BranchId::for_height(network, BlockHeight::from_u32(t)) != BranchId::for_height(network, tip + 1)
    })
}

async fn record_mined(app: &App, sub: &Subscription, inst: &Installment, height: u32) -> Result<()> {
    app.store.lock().unwrap().set_mined(&sub.subscription_id, inst.k, height)?;
    let mut mined = inst.clone();
    mined.mined_height = Some(height);
    send_webhook(app, Event::confirmed(sub, &mined));
    if inst.k as usize == sub.installments.len() {
        finish(app, sub, "completed", None).await?;
    }
    Ok(())
}

/// Refuses an installment whose package is not what the payer agreed to. Nothing is
/// broadcast; the merchant hears `invoice.expired`, and the payer can cancel or sweep
/// and subscribe again (there is no re-signing flow).
fn reject(app: &App, sub: &Subscription, inst: &Installment, why: &str) -> Result<()> {
    eprintln!("{} #{}: refusing the package: {why}", sub.subscription_id, inst.k);
    app.store
        .lock()
        .unwrap()
        .stall(&sub.subscription_id, inst.k, "invalid", now() + refund::REFUND_KEEP_SECS)?;
    send_webhook(app, Event::expired(sub, inst));
    Ok(())
}

pub fn orchard_receiver(params: &Network, ua: &str) -> Result<orchard::Address> {
    match zcash_keys::address::Address::decode(params, ua) {
        Some(zcash_keys::address::Address::Unified(ua)) => {
            ua.orchard().copied().context("address has no Orchard receiver")
        }
        _ => Err(anyhow!("expected a unified address with an Orchard receiver")),
    }
}

/// Ends a subscription and shreds everything that could still open: sealed
/// packages, beacons, and the pocket's account in the wallet. A stop keeps the
/// account for the payer's refund, and a sandbox cancel keeps it with the packages
/// it voided, for a while (`refund.rs`).
pub async fn finish(app: &App, sub: &Subscription, status: &str, at: Option<&Installment>) -> Result<()> {
    let t = now();
    let keep = match status {
        "stopped" => Some(t + refund::REFUND_KEEP_SECS),
        "cancelled" if app.sandbox() => Some(t + refund::VOIDED_KEEP_SECS),
        _ => None,
    };
    // A stalled pocket emptied by the payer is their refund after the miss: read
    // what spent it before the account goes.
    let refund = match (status, sub.status.as_str()) {
        ("cancelled", "stalled") => refund::refund_of(app, sub).await.unwrap_or_else(|e| {
            eprintln!("{}: finding the refund: {e:#}", sub.subscription_id);
            None
        }),
        _ => None,
    };
    let pocket = {
        let store = app.store.lock().unwrap();
        store.set_status(&sub.subscription_id, status)?;
        if status != "completed" {
            store.close_remaining(&sub.subscription_id, "cancelled")?;
        }
        if let Some(refund) = &refund {
            store.set_refund(&sub.subscription_id, refund)?;
        }
        match keep {
            Some(until) => {
                if status == "cancelled" {
                    store.shred_but_voided(&sub.subscription_id)?;
                } else {
                    store.shred(&sub.subscription_id)?;
                }
                store.keep_until(&sub.subscription_id, until)?;
            }
            None => {
                store.shred(&sub.subscription_id)?;
                store.set_released(&sub.subscription_id, t)?;
            }
        }
        store.pocket_for_subscription(&sub.subscription_id)?
    };
    if keep.is_none() {
        let account = parse_account(&pocket.account)?;
        app.wallet.lock().await.delete_account(account)?;
    }
    if status == "cancelled" {
        if let Some(inst) = at {
            send_webhook(app, Event::cancelled(sub, inst));
        }
    }
    match (keep, status) {
        (None, _) => println!("{}: {status}; pocket data deleted", sub.subscription_id),
        (Some(_), "cancelled") => println!("{}: cancelled; voided packages and pocket kept for an hour", sub.subscription_id),
        (Some(_), _) => println!("{}: {status}; packages deleted, pocket kept for the refund", sub.subscription_id),
    }
    Ok(())
}

/// Hands the event to its own task, which retries it (`webhook::deliver`); the tick
/// goes on at once, and no lock is held while the merchant answers.
pub(crate) fn send_webhook(app: &App, event: Event) {
    if let (Some(url), Some(secret)) = (app.cfg.webhook_url.clone(), app.cfg.webhook_secret.clone()) {
        tokio::spawn(webhook::deliver(url, secret, event));
    }
}

#[cfg(test)]
mod scheduler_tests;
