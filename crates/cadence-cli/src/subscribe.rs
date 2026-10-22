//! The payer's side of a live subscription: subscribe to a runner's offer, and cancel.

use std::{fs, path::Path, thread, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_chain::{lwd, wallet};
use cadence_core::{
    build_rung,
    mandate::{self, installment_fee, Terms},
    seed, Installment, Pocket,
};
use cadence_seal::{age::x25519, DrandChain};
use orchard::{
    tree::{MerkleHashOrchard, MerklePath},
    Anchor, Note,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zcash_keys::address::Address;
use zcash_protocol::{
    consensus::{BlockHeight, Network, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

#[derive(Deserialize)]
struct OfferView {
    offer_id: String,
    name: String,
    amount_zat: u64,
    period_secs: u64,
    count: u32,
    merchant_ua: String,
    runner_age_recipient: String,
    network: String,
}

/// Everything the payer must keep to cancel later. Dev builds store it unencrypted.
#[derive(Serialize, Deserialize)]
pub struct SubscriptionFile {
    network: String,
    seed_hex: String,
    runner: String,
    offer_id: String,
    pocket_id: String,
    subscription_id: Option<String>,
    mandate_id: String,
    tag: String,
    amount_zat: u64,
    count: u32,
    period_secs: u64,
    first_release_at: u64,
    /// Seconds from signing until installment 1 becomes releasable.
    #[serde(default)]
    first_in_secs: u64,
    merchant_ua: String,
    funding_tx_hex: Option<String>,
    funding_height: Option<u32>,
}

fn http() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into()
}

fn read(mut response: ureq::http::Response<ureq::Body>) -> Result<Value> {
    let status = response.status();
    let body = response.body_mut().read_to_string()?;
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::String(body));
    if !status.is_success() {
        bail!("runner answered {status}: {value}");
    }
    Ok(value)
}

fn get_json(url: &str) -> Result<Value> {
    read(http().get(url).call()?)
}

fn post_json(url: &str, body: &Value) -> Result<Value> {
    let bytes = serde_json::to_vec(body)?;
    read(
        http()
            .post(url)
            .header("Content-Type", "application/json")
            .send(&bytes[..])?,
    )
}

fn network(name: &str) -> Result<Network> {
    match name {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => bail!("unknown network {other}"),
    }
}

fn orchard_receiver(params: &Network, ua: &str) -> Result<orchard::Address> {
    match Address::decode(params, ua) {
        Some(Address::Unified(ua)) => ua.orchard().copied().context("address has no Orchard receiver"),
        _ => bail!("expected a unified address with an Orchard receiver"),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn zec(zats: u64) -> String {
    let s = format!("{}.{:08}", zats / 100_000_000, zats % 100_000_000);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn hex16(s: &str) -> Result<[u8; 16]> {
    hex::decode(s)?.try_into().map_err(|_| anyhow!("expected 16 bytes"))
}

fn save(path: &Path, file: &SubscriptionFile) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_vec_pretty(file)?)?;
    Ok(())
}

fn terms(params: &Network, f: &SubscriptionFile) -> Result<Terms> {
    Ok(Terms {
        amount: Zatoshis::from_u64(f.amount_zat).map_err(|_| anyhow!("bad amount"))?,
        count: f.count,
        period_secs: f.period_secs,
        first_release_at: f.first_release_at,
        merchant: orchard_receiver(params, &f.merchant_ua)?,
        tag: hex16(&f.tag)?,
    })
}

/// Subscribes to `offer_id` at `runner`: pocket, funding, ladders, sealing, upload.
pub fn subscribe(runner: &str, offer_id: &str, out: &Path, first_in: u64, sandbox_fund: bool) -> Result<()> {
    if out.exists() {
        bail!("{} already exists", out.display());
    }
    let runner = runner.trim_end_matches('/');
    let offer: OfferView = serde_json::from_value(get_json(&format!("{runner}/api/offers/{offer_id}"))?)?;
    let params = network(&offer.network)?;
    orchard_receiver(&params, &offer.merchant_ua)?;
    offer
        .runner_age_recipient
        .parse::<x25519::Recipient>()
        .map_err(|e| anyhow!("bad runner recipient: {e}"))?;

    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let ufvk = pocket
        .ufvk()
        .encode(&params)
        .map_err(|e| anyhow!("encoding UFVK: {e:?}"))?;
    let reg = post_json(&format!("{runner}/api/pockets"), &json!({ "pocket_ufvk": ufvk }))?;
    let pocket_id = reg["pocket_id"].as_str().context("no pocket_id")?.to_string();

    let mut tag = [0u8; 16];
    rand::fill(&mut tag);
    let mut mandate_id = [0u8; 16];
    rand::fill(&mut mandate_id);
    let file = SubscriptionFile {
        network: offer.network.clone(),
        seed_hex: hex::encode(seed),
        runner: runner.into(),
        offer_id: offer.offer_id.clone(),
        pocket_id: pocket_id.clone(),
        subscription_id: None,
        mandate_id: hex::encode(mandate_id),
        tag: hex::encode(tag),
        amount_zat: offer.amount_zat,
        count: offer.count,
        period_secs: offer.period_secs,
        first_release_at: 0,
        first_in_secs: first_in,
        merchant_ua: offer.merchant_ua.clone(),
        funding_tx_hex: None,
        funding_height: None,
    };
    save(out, &file)?;
    if sandbox_fund {
        let total = mandate::funding_total(&terms(&params, &file)?).context("amount overflow")?;
        let paid = post_json(
            &format!("{runner}/api/sandbox/fund"),
            &json!({ "pocket_id": pocket_id, "amount_zat": u64::from(total) }),
        )?;
        println!("sandbox wallet funded the pocket in {}", paid["txid"].as_str().unwrap_or("?"));
    }
    resume(out)
}

/// Continues a subscription from its file: wait for funding, pre-sign, seal, upload.
/// Safe to re-run after an interruption before the upload.
pub fn resume(out: &Path) -> Result<()> {
    let mut file: SubscriptionFile = serde_json::from_slice(&fs::read(out)?)?;
    if file.subscription_id.is_some() {
        bail!("this subscription was already uploaded");
    }
    let params = network(&file.network)?;
    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad seed"))?;
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let runner = file.runner.clone();
    let offer: OfferView = serde_json::from_value(get_json(&format!("{runner}/api/offers/{}", file.offer_id))?)?;
    let recipient: x25519::Recipient = offer
        .runner_age_recipient
        .parse()
        .map_err(|e| anyhow!("bad runner recipient: {e}"))?;
    let mandate_id = hex16(&file.mandate_id)?;
    let pocket_id = file.pocket_id.clone();

    let total = mandate::funding_total(&terms(&params, &file)?).context("amount overflow")?;
    println!("{}: {} x {} ZEC", offer.name, offer.count, zec(offer.amount_zat));
    println!("fund the pocket once, from an Ironwood (shielded) balance:");
    println!("  zcash:{}?amount={}", pocket.funding_ua(&params), zec(total.into()));

    let pocket_url = format!("{runner}/api/pockets/{pocket_id}");
    let (funding, tip) = loop {
        match get_json(&pocket_url) {
            Ok(p) => {
                if let Some(f) = p.get("funding").filter(|f| !f.is_null()) {
                    break (f.clone(), p["tip"].as_u64().unwrap_or(0) as u32);
                }
            }
            Err(e) => eprintln!("runner unreachable, retrying: {e:#}"),
        }
        thread::sleep(Duration::from_secs(10));
    };
    let tx_hex = funding["tx_hex"].as_str().context("no tx_hex")?.to_string();
    let height = funding["mined_height"].as_u64().context("no mined_height")? as u32;
    let note = mandate::decrypt_funding(&params, &hex::decode(&tx_hex)?, BlockHeight::from_u32(height), &pocket)
        .map_err(|e| anyhow!("{e:?}"))?;
    println!("funded: {} zats at height {height}", note.value().inner());

    let now = unix_now();
    file.first_release_at = now + file.first_in_secs;
    file.funding_tx_hex = Some(tx_hex);
    file.funding_height = Some(height);
    save(out, &file)?;

    let terms = terms(&params, &file)?;
    let presigned = mandate::presign(
        &params,
        &pocket,
        note,
        &terms,
        BlockHeight::from_u32(tip.max(height)),
        now,
        mandate_id,
        |k, done, total| {
            if done == total {
                println!("installment {k}: {total} rungs signed");
            }
        },
    )
    .map_err(|e| anyhow!("{e:?}"))?;
    if presigned.len() != offer.count as usize {
        bail!("the pocket only covers {} installments", presigned.len());
    }

    let chain = DrandChain::quicknet();
    let mut installments = vec![];
    for p in &presigned {
        let round = cadence_seal::first_round_at_or_after(&chain, p.release_at);
        let sealed = cadence_seal::seal(&serde_json::to_vec(&p.ladder)?, &recipient, &chain, round)
            .map_err(|e| anyhow!("sealing installment {}: {e:?}", p.k))?;
        println!("installment {}: sealed to drand round {round} ({} bytes)", p.k, sealed.len());
        installments.push(json!({ "k": p.k, "release_round": round, "sealed": STANDARD.encode(sealed) }));
    }
    let sub = post_json(
        &format!("{runner}/api/subscriptions"),
        &json!({ "offer_id": offer.offer_id, "pocket_id": pocket_id, "installments": installments }),
    )?;
    file.subscription_id = sub["subscription_id"].as_str().map(String::from);
    save(out, &file)?;
    println!("subscription {}: active. You can close this now.", file.subscription_id.as_deref().unwrap_or("?"));
    Ok(())
}

/// Every note the pocket can hold: the funding note, then each installment's change.
fn pocket_notes(params: &Network, pocket: &Pocket, f: &SubscriptionFile) -> Result<Vec<Note>> {
    let tx_hex = f.funding_tx_hex.as_deref().context("the pocket was never funded")?;
    let height = BlockHeight::from_u32(f.funding_height.context("no funding height")?);
    let funding = mandate::decrypt_funding(params, &hex::decode(tx_hex)?, height, pocket)
        .map_err(|e| anyhow!("{e:?}"))?;
    let terms = terms(params, f)?;
    let secret = seed::app_secret(pocket);
    let mandate_id = hex16(&f.mandate_id)?;
    let mut notes = vec![funding];
    let mut input = funding;
    for k in 1..f.count {
        let mut memo = [0u8; 20];
        memo[..16].copy_from_slice(&terms.tag);
        memo[16..].copy_from_slice(&k.to_le_bytes());
        let inst = Installment {
            input,
            amount: terms.amount,
            merchant: terms.merchant,
            memo: MemoBytes::from_bytes(&memo)?,
        };
        // Change does not depend on the target height, so any valid height will do.
        let rung = build_rung(params, height + 1, pocket, &inst, seed::rung_seed(&secret, &mandate_id, k, 0))
            .map_err(|e| anyhow!("{e:?}"))?;
        match rung.change {
            Some(c) => {
                notes.push(c);
                input = c;
            }
            None => break,
        }
    }
    Ok(notes)
}

/// Spends the pocket's live note to `refund_ua`, so no later installment can be valid.
pub async fn cancel(path: &Path, refund_ua: &str, mut client: lwd::Client) -> Result<()> {
    let file: SubscriptionFile = serde_json::from_slice(&fs::read(path)?)?;
    let params = network(&file.network)?;
    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad seed"))?;
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let refund = orchard_receiver(&params, refund_ua)?;

    let state = get_json(&format!("{}/api/pockets/{}", file.runner, file.pocket_id))?;
    let live = state["notes"]
        .as_array()
        .and_then(|n| n.first())
        .context("the pocket holds no unspent note (completed, or already cancelled)")?;
    let nf_hex = live["nullifier"].as_str().context("no nullifier")?;
    let note = pocket_notes(&params, &pocket, &file)?
        .into_iter()
        .find(|n| hex::encode(n.nullifier(pocket.fvk()).to_bytes()) == nf_hex)
        .context("the runner reports a note this pocket never created")?;

    let w = get_json(&format!(
        "{}/api/pockets/{}/witness?nullifier={nf_hex}",
        file.runner, file.pocket_id
    ))?;
    let target = BlockHeight::from_u32(w["target_height"].as_u64().context("no target")? as u32);
    let anchor_height = BlockHeight::from_u32(w["anchor_height"].as_u64().context("no anchor height")? as u32);
    let anchor_bytes: [u8; 32] = hex::decode(w["anchor"].as_str().context("no anchor")?)?
        .try_into()
        .map_err(|_| anyhow!("bad anchor"))?;
    let anchor = Option::<Anchor>::from(Anchor::from_bytes(anchor_bytes)).context("bad anchor")?;
    let path: Vec<MerkleHashOrchard> = w["auth_path"]
        .as_array()
        .context("no auth path")?
        .iter()
        .map(|h| {
            let b: [u8; 32] = hex::decode(h.as_str().unwrap_or(""))?
                .try_into()
                .map_err(|_| anyhow!("bad path element"))?;
            Option::from(MerkleHashOrchard::from_bytes(&b)).context("bad path element")
        })
        .collect::<Result<_>>()?;
    let witness = MerklePath::from_parts(
        w["position"].as_u64().context("no position")? as u32,
        path.try_into().map_err(|_| anyhow!("auth path must have 32 elements"))?,
    );
    // Trust the runner for nothing: the anchor must match an independent server.
    wallet::check_anchor(&mut client, &anchor, anchor_height).await?;

    let value = note.value().inner();
    let amount = Zatoshis::from_u64(value.saturating_sub(installment_fee().into()))
        .map_err(|_| anyhow!("note too small to refund"))?;
    let mut fresh = [0u8; 32];
    rand::fill(&mut fresh);
    let inst = Installment {
        input: note,
        amount,
        merchant: refund,
        memo: MemoBytes::empty(),
    };
    let rung = build_rung(&params, target, &pocket, &inst, fresh).map_err(|e| anyhow!("{e:?}"))?;
    let tx = tokio::task::spawn_blocking(move || wallet::complete(rung.pczt, anchor, witness)).await??;
    let txid = wallet::broadcast(&mut client, &tx).await?;
    println!("cancelled: {} zats returned to your address in {txid}", u64::from(amount));
    Ok(())
}

/// Sends `amount` from a pocket whose notes a local wallet DB tracks (the dev and
/// sandbox funder). Change returns to the pocket; every output uses Discard.
pub async fn send(
    pocket_path: &Path,
    wallet_db: &Path,
    to: &str,
    amount: u64,
    mut client: lwd::Client,
) -> Result<()> {
    #[derive(Deserialize)]
    struct DevPocket {
        network: String,
        seed_hex: String,
    }
    let file: DevPocket = serde_json::from_slice(&fs::read(pocket_path)?)?;
    let params = network(&file.network)?;
    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad seed"))?;
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let recipient = orchard_receiver(&params, to)?;

    let mut db = wallet::open(wallet_db, params)?;
    wallet::sync(&mut client, &params, &mut db).await?;
    use zcash_client_backend::data_api::WalletRead;
    let account = *db.get_account_ids()?.first().context("the wallet tracks no pocket")?;
    let amount_z = Zatoshis::from_u64(amount).map_err(|_| anyhow!("bad amount"))?;
    let mut broadcaster = client.clone();
    let (txid, _) = wallet::pay(&mut client, &mut broadcaster, &mut db, &params, account, &pocket, recipient, amount_z, &[]).await?;
    println!("sent {amount} zats in {txid}");
    Ok(())
}
