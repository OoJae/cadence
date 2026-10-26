//! The runner's scheduler: open each installment when its drand round passes,
//! release it once its input is anchor-deep, and follow it until it is mined.

use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use cadence_chain::{
    lwd,
    wallet::{self, Db, ANCHOR_CONFIRMATIONS},
};
use cadence_core::package::{verify_rung, InstallmentLadder};
use cadence_seal::{age::x25519, DrandChain};
use orchard::note::Nullifier;
use pczt::Pczt;
use zcash_client_backend::data_api::{WalletRead, WalletWrite};
use zcash_client_sqlite::AccountUuid;
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::{
    store::{Funding, Installment, Store, Subscription},
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
    pub identity: x25519::Identity,
    pub recipient: String,
    pub chain: DrandChain,
    pub tip: AtomicU32,
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
        tokio::time::sleep(app.cfg.tick).await;
    }
}

async fn tick(app: &App) -> Result<()> {
    let mut client = app.sync_client.clone();
    let tip = lwd::tip(&mut client).await?;
    app.tip.store(u32::from(tip), Ordering::Relaxed);
    {
        let mut db = app.wallet.lock().await;
        // With no pocket there is no birthday to scan from, and nothing to find.
        if db.get_account_ids()?.is_empty() {
            return Ok(());
        }
        wallet::sync(&mut client, &app.cfg.network, &mut db).await?;
    }
    record_fundings(app, &mut client, tip).await?;
    forget_abandoned(app).await?;

    let round_now = cadence_seal::round_at(&app.chain, now());
    let subs = app.store.lock().unwrap().subscriptions(true)?;
    for sub in subs {
        if let Err(e) = advance(app, &mut client, &sub, tip, round_now).await {
            eprintln!("{}: {e:#}", sub.subscription_id);
        }
    }
    Ok(())
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

/// Unfunded pockets are forgotten after a day; funded ones whose payer never
/// uploaded packages after a week. The funds stay the payer's (`cadence sweep`).
async fn forget_abandoned(app: &App) -> Result<()> {
    const DAY: u64 = 24 * 60 * 60;
    let t = now();
    let pockets = app.store.lock().unwrap().abandoned_pockets(t.saturating_sub(DAY), t.saturating_sub(7 * DAY))?;
    for pocket in pockets {
        app.wallet.lock().await.delete_account(parse_account(&pocket.account)?)?;
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
    let Some(pos) = sub.installments.iter().position(|i| i.state != "mined") else {
        return finish(app, sub, "completed", None).await;
    };
    let inst = &sub.installments[pos];
    let previous = pos.checked_sub(1).map(|p| &sub.installments[p]);
    // A missed or invalid installment waits for the payer, who may sweep instead.
    if matches!(inst.state.as_str(), "sealed" | "missed" | "invalid")
        && pocket_emptied(app, sub, previous, tip).await?
        && payer_cancelled(app, client, sub, inst, previous).await?
    {
        println!("{} #{}: the pocket was emptied by the payer: cancelled", sub.subscription_id, inst.k);
        return finish(app, sub, "cancelled", Some(inst)).await;
    }
    match inst.state.as_str() {
        "sealed" if round_now >= inst.release_round => {
            let round = inst.release_round;
            let beacon = fetch_beacon(app, round).await?;
            app.store.lock().unwrap().set_beacon(&sub.subscription_id, inst.k, &beacon)?;
            println!("{} #{}: round {round} passed, package opened", sub.subscription_id, inst.k);
            Ok(())
        }
        "due" => release(app, client, sub, inst, previous, tip).await,
        "broadcast" => confirm(app, client, sub, inst, tip).await,
        _ => Ok(()),
    }
}

/// A pocket holds exactly one live note between installments. If it holds none once
/// the previous installment (or the funding) is anchor-deep, the payer has spent it:
/// the remaining installments can never become valid, so the merchant learns now
/// rather than when the next one falls due.
async fn pocket_emptied(app: &App, sub: &Subscription, previous: Option<&Installment>, tip: BlockHeight) -> Result<bool> {
    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let settled_at = match previous {
        None => pocket.funding.as_ref().map(|f| f.mined_height),
        Some(p) => p.mined_height,
    };
    let Some(h) = settled_at else { return Ok(false) };
    if u32::from(tip) < h + ANCHOR_CONFIRMATIONS {
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

    // When the input appeared on chain: the funding note for #1, else the change of #k-1.
    let input_height = match previous {
        None => pocket.funding.as_ref().map(|f| f.mined_height),
        Some(p) => p.mined_height,
    };
    let target = tip + 1;
    let anchor_height = target - ANCHOR_CONFIRMATIONS;

    let mut db = app.wallet.lock().await;
    let fvk = wallet::pocket_fvk(&db, account)?;
    let Some(input) = wallet::find_unspent(&db, account, &fvk, &nf, target)? else {
        if let Some(h) = input_height {
            if u32::from(tip) >= h + ANCHOR_CONFIRMATIONS {
                drop(db);
                if payer_cancelled(app, client, sub, inst, previous).await? {
                    println!("{} #{}: input spent by the payer: cancelled", sub.subscription_id, inst.k);
                    return finish(app, sub, "cancelled", Some(inst)).await;
                }
            }
        }
        return Ok(());
    };
    if input.mined > anchor_height {
        return Ok(());
    }

    // Fail closed: only the rung signed for exactly this target carries the expiry a
    // fresh send would carry now.
    let Some(rung) = ladder.rungs.iter().find(|r| r.target_height == u32::from(target)) else {
        let last = ladder.rungs.iter().map(|r| r.target_height).max().unwrap_or(0);
        if u32::from(target) > last {
            drop(db);
            println!("{} #{}: no rung for target {target}: missed", sub.subscription_id, inst.k);
            app.store.lock().unwrap().set_state(&sub.subscription_id, inst.k, "missed")?;
            app.store.lock().unwrap().set_status(&sub.subscription_id, "stalled")?;
            send_webhook(app, Event::expired(sub, inst));
        }
        return Ok(());
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
    } else if inst.expiry_height.is_some_and(|e| u32::from(tip) > e) || branch_passed(app, inst, tip) {
        // Expired unmined, or signed for a branch an upgrade has since replaced:
        // release again with the rung for the new tip.
        app.store.lock().unwrap().set_state(&sub.subscription_id, inst.k, "due")?;
    }
    Ok(())
}

/// Whether a network upgrade has activated since the broadcast rung's target, so
/// that it can never be mined although its expiry has not passed.
fn branch_passed(app: &App, inst: &Installment, tip: BlockHeight) -> bool {
    use zcash_protocol::consensus::BranchId;
    inst.target_height.is_some_and(|t| {
        BranchId::for_height(&app.cfg.network, BlockHeight::from_u32(t))
            != BranchId::for_height(&app.cfg.network, tip + 1)
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
/// broadcast; the merchant hears `invoice.expired` and the payer must re-sign.
fn reject(app: &App, sub: &Subscription, inst: &Installment, why: &str) -> Result<()> {
    eprintln!("{} #{}: refusing the package: {why}", sub.subscription_id, inst.k);
    let store = app.store.lock().unwrap();
    store.set_state(&sub.subscription_id, inst.k, "invalid")?;
    store.set_status(&sub.subscription_id, "stalled")?;
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
/// packages, beacons, and the pocket's account in the wallet.
pub async fn finish(app: &App, sub: &Subscription, status: &str, at: Option<&Installment>) -> Result<()> {
    let pocket = {
        let store = app.store.lock().unwrap();
        store.set_status(&sub.subscription_id, status)?;
        if status != "completed" {
            store.close_remaining(&sub.subscription_id, "cancelled")?;
        }
        store.shred(&sub.subscription_id)?;
        store.pocket_for_subscription(&sub.subscription_id)?
    };
    let account = parse_account(&pocket.account)?;
    app.wallet.lock().await.delete_account(account)?;
    if status == "cancelled" {
        if let Some(inst) = at {
            send_webhook(app, Event::cancelled(sub, inst));
        }
    }
    println!("{}: {status}; pocket data deleted", sub.subscription_id);
    Ok(())
}

fn send_webhook(app: &App, event: Event) {
    if let (Some(url), Some(secret)) = (app.cfg.webhook_url.clone(), app.cfg.webhook_secret.clone()) {
        tokio::task::spawn_blocking(move || {
            if let Err(e) = webhook::post(&url, secret.as_bytes(), &event, now()) {
                eprintln!("webhook {}: {e:#}", event.kind);
            }
        });
    }
}
