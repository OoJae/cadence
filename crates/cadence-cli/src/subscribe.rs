//! The payer's side of a live subscription: subscribe to a runner's offer, and cancel.

use std::{fs, path::Path, thread, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_chain::{lwd, wallet};

use crate::http::Http;
use cadence_core::{
    build_rung,
    mandate::{self, Terms},
    Installment, Pocket,
};
use cadence_seal::{age::x25519, DrandChain};
use orchard::{
    tree::{MerkleHashOrchard, MerklePath},
    Anchor,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
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
    /// What the merchant's wallet shows for each installment (the memo).
    #[serde(default)]
    label: String,
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

/// Reads a subscription or pocket file. A recovery kit saved by the web app is
/// encrypted to a passphrase, taken from `CADENCE_KIT_PASSPHRASE` or asked for.
pub fn read_kit(path: &Path) -> Result<Vec<u8>> {
    static OPENED: std::sync::Mutex<Vec<(std::path::PathBuf, Vec<u8>)>> = std::sync::Mutex::new(vec![]);
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if !cadence_seal::is_sealed_kit(&bytes) {
        return Ok(bytes);
    }
    // Ask once per command, however many times the kit is read.
    let mut opened = OPENED.lock().unwrap();
    if let Some((_, plain)) = opened.iter().find(|(p, _)| p == path) {
        return Ok(plain.clone());
    }
    let passphrase = match std::env::var("CADENCE_KIT_PASSPHRASE") {
        Ok(p) => p,
        Err(_) => rpassword::prompt_password(format!("passphrase for {}: ", path.display()))?,
    };
    let plain = cadence_seal::open_kit(&bytes, &passphrase).map_err(|e| anyhow!("{e}"))?;
    opened.push((path.to_path_buf(), plain.clone()));
    Ok(plain)
}

/// The runner a subscription file belongs to.
pub fn runner_of(path: &Path) -> Result<String> {
    #[derive(Deserialize)]
    struct Runner {
        runner: String,
    }
    Ok(serde_json::from_slice::<Runner>(&read_kit(path)?)?.runner)
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

fn parse_txid(display_hex: &str) -> Result<zcash_primitives::transaction::TxId> {
    let mut bytes: [u8; 32] = hex::decode(display_hex)?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(zcash_primitives::transaction::TxId::from_bytes(bytes))
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
        label: f.label.clone(),
    })
}

/// Subscribes to `offer_id` at `runner`: pocket, funding, ladders, sealing, upload.
pub fn subscribe(http: &Http, runner: &str, offer_id: &str, out: &Path, first_in: u64, sandbox_fund: bool) -> Result<()> {
    if out.exists() {
        bail!("{} already exists", out.display());
    }
    let runner = runner.trim_end_matches('/');
    let offer: OfferView = serde_json::from_value(http.get_json(&format!("{runner}/api/offers/{offer_id}"))?)?;
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
    let reg = http.post_json(&format!("{runner}/api/pockets"), &json!({ "pocket_ufvk": ufvk }))?;
    let pocket_id = reg["pocket_id"].as_str().context("no pocket_id")?.to_string();

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
        label: format!("{} ({pocket_id})", offer.name),
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
        let paid = http.post_json(
            &format!("{runner}/api/sandbox/fund"),
            &json!({ "pocket_id": pocket_id, "amount_zat": u64::from(total) }),
        )?;
        println!("sandbox wallet funded the pocket in {}", paid["txid"].as_str().unwrap_or("?"));
    }
    resume(http, out)
}

/// Continues a subscription from its file: wait for funding, pre-sign, seal, upload.
/// Safe to re-run after an interruption before the upload.
pub fn resume(http: &Http, out: &Path) -> Result<()> {
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
    let offer: OfferView = serde_json::from_value(http.get_json(&format!("{runner}/api/offers/{}", file.offer_id))?)?;
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
        match http.get_json(&pocket_url) {
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
    let sub = http.post_json(
        &format!("{runner}/api/subscriptions"),
        &json!({ "offer_id": offer.offer_id, "pocket_id": pocket_id, "installments": installments }),
    )?;
    file.subscription_id = sub["subscription_id"].as_str().map(String::from);
    save(out, &file)?;
    println!("subscription {}: active. You can close this now.", file.subscription_id.as_deref().unwrap_or("?"));
    Ok(())
}

/// Spends the pocket's live note to `refund_ua`, so no later installment can be valid.
pub async fn cancel(http: &Http, path: &Path, refund_ua: &str, mut client: lwd::Client) -> Result<()> {
    let file: SubscriptionFile = serde_json::from_slice(&read_kit(path)?)?;
    let params = network(&file.network)?;
    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad seed"))?;
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let refund = orchard_receiver(&params, refund_ua)?;

    let state = http.get(&format!("{}/api/pockets/{}", file.runner, file.pocket_id)).await?;
    let live = state["notes"]
        .as_array()
        .and_then(|n| n.first())
        .context("the pocket holds no unspent note (completed, or already cancelled)")?;
    let nf_hex = live["nullifier"].as_str().context("no nullifier")?;
    // Read the note from the transaction that created it, from an independent server,
    // so the runner can only point at it.
    let created_in = parse_txid(live["txid"].as_str().context("no txid")?)?;
    let (tx, _) = lwd::transaction(&mut client, &params, &created_in).await?;
    let note = mandate::pocket_outputs(&tx, &pocket)
        .into_iter()
        .find(|n| hex::encode(n.nullifier(pocket.fvk()).to_bytes()) == nf_hex)
        .context("the runner reports a note this pocket never received")?;

    let w = http
        .get(&format!("{}/api/pockets/{}/witness?nullifier={nf_hex}", file.runner, file.pocket_id))
        .await?;
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
    let amount = Zatoshis::from_u64(value.saturating_sub(mandate::installment_fee_at(&params, target).into()))
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

/// Returns every note left in a pocket to `to`, each as an ordinary 2-action send.
/// It needs only the pocket's seed and a lightwalletd server, never the runner, so
/// funds stay recoverable after a stop, an overfunding, or with the runner gone.
/// On a live subscription this also cancels it.
pub async fn sweep(
    path: &Path,
    to: &str,
    from: Option<u32>,
    wallet_dir: &Path,
    mut client: lwd::Client,
) -> Result<()> {
    #[derive(Deserialize)]
    struct AnyPocket {
        network: String,
        seed_hex: String,
        funding_height: Option<u32>,
    }
    let file: AnyPocket = serde_json::from_slice(&read_kit(path)?)?;
    let params = network(&file.network)?;
    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad seed"))?;
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let recipient = orchard_receiver(&params, to)?;

    fs::create_dir_all(wallet_dir)?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("pocket");
    let db_path = wallet_dir.join(format!("{stem}.sqlite"));
    let fresh = !db_path.exists();
    let mut db = wallet::open(&db_path, params)?;
    use zcash_client_backend::data_api::WalletRead;
    if fresh {
        let birthday = from
            .or(file.funding_height)
            .context("pass --from <a height at or below the pocket's funding transaction>")?;
        wallet::init(&mut db)?;
        let ufvk = pocket.ufvk().encode(&params).map_err(|e| anyhow!("encoding UFVK: {e:?}"))?;
        wallet::import_pocket(&mut client, &mut db, &params, &ufvk, BlockHeight::from_u32(birthday), "sweep").await?;
    }
    let account = *db.get_account_ids()?.first().context("the sweep wallet tracks no pocket")?;
    println!("scanning…");
    wallet::sync(&mut client, &params, &mut db).await?;

    let tip = lwd::tip(&mut client).await?;
    let anchor_height = tip + 1 - wallet::ANCHOR_CONFIRMATIONS;
    // `pay` targets the next block too; only a sweep in the block of the fee switch
    // can disagree, and it then fails or leaves change for another sweep.
    let fee = u64::from(mandate::installment_fee_at(&params, tip + 1));
    let mut notes = wallet::unspent_notes(&db, account, tip + 1)?;
    notes.sort_by_key(|n| std::cmp::Reverse(n.note.value().inner()));
    let (ready, waiting): (Vec<_>, Vec<_>) = notes.into_iter().partition(|n| n.mined <= anchor_height);
    if ready.is_empty() && waiting.is_empty() {
        println!("the pocket is empty");
        return Ok(());
    }
    let mut spent = vec![];
    let mut broadcaster = client.clone();
    for note in &ready {
        let value = note.note.value().inner();
        let Some(amount) = value.checked_sub(fee).filter(|a| *a > 0) else {
            println!("skipping a {value}-zat note: smaller than the fee");
            continue;
        };
        let amount_z = Zatoshis::from_u64(amount).map_err(|_| anyhow!("bad amount"))?;
        let (txid, nf) = wallet::pay(
            &mut client, &mut broadcaster, &mut db, &params, account, &pocket, recipient, amount_z, &spent,
        )
        .await?;
        spent.push(nf);
        println!("returned {} ZEC in {txid}", zec(amount));
    }
    if !waiting.is_empty() {
        println!(
            "{} note(s) are less than {} blocks deep; run sweep again in a few minutes",
            waiting.len(),
            wallet::ANCHOR_CONFIRMATIONS
        );
    }
    Ok(())
}
