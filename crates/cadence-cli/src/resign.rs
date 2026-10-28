//! Re-signing a live subscription's remaining installments.
//!
//! Every installment is signed when the payer subscribes, so a rule change after
//! that, such as a new fee, can void the ones not yet released. A re-sign signs them
//! again under today's rules, from the pocket's live note and for the drand rounds
//! they are already sealed to, and replaces their packages on the runner with a
//! request signed by the payer's key. Nothing is spent and nothing is funded.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use cadence_chain::lwd;
use cadence_core::{
    mandate::{self, Terms},
    Pocket,
};
use cadence_seal::{age::x25519, DrandChain};
use orchard::Note;
use serde::Deserialize;
use serde_json::{json, Value};
use zcash_protocol::{
    consensus::{BlockHeight, Network, NetworkConstants, Parameters},
    value::Zatoshis,
};

use crate::{
    http::Http,
    payer_auth,
    subscribe::{hex16, network, orchard_receiver, parse_txid, unix_now, zec},
};

/// What a re-sign needs from the cancel key the web app saves, or from the CLI's
/// own subscription file: both carry these fields.
#[derive(Deserialize)]
struct Key {
    network: String,
    seed_hex: String,
    runner: String,
    offer_id: String,
    pocket_id: String,
    subscription_id: Option<String>,
    mandate_id: String,
    #[serde(default)]
    label: String,
    amount_zat: u64,
    count: u32,
    period_secs: u64,
    merchant_ua: String,
}

/// `GET /api/subscriptions/{id}`.
#[derive(Deserialize)]
struct SubView {
    subscription_id: String,
    offer_id: String,
    pocket_id: String,
    status: String,
    funding: Option<FundingView>,
    installments: Vec<InstallmentView>,
}

#[derive(Deserialize)]
struct FundingView {
    txid: String,
}

#[derive(Deserialize)]
struct InstallmentView {
    k: u32,
    amount_zat: u64,
    release_round: u64,
    state: String,
    txid: Option<String>,
}

/// `GET /api/offers/{id}`.
#[derive(Deserialize)]
struct OfferView {
    amount_zat: u64,
    count: u32,
    merchant_ua: String,
    runner_age_recipient: String,
}

/// `GET /api/pockets/{id}`.
#[derive(Deserialize)]
struct PocketView {
    #[serde(default)]
    syncing: bool,
    notes: Vec<NoteView>,
}

#[derive(Deserialize)]
struct NoteView {
    nullifier: String,
}

/// The subscription as the runner and an independent lightwalletd server see it now.
struct Live {
    sub: SubView,
    offer: OfferView,
    /// The pocket's live note: the funding note, or the change of the last mined installment.
    current: Note,
    tip: BlockHeight,
}

/// Re-signed packages, sealed and checked.
struct Plan {
    subscription_id: String,
    /// `(k, release_round, sealed)`, as the runner stores them.
    packages: Vec<(u32, u64, Vec<u8>)>,
    /// The nullifier of the note each installment spends.
    spends: Vec<String>,
}

/// Re-signs the installments of the subscription in the cancel key at `path` that are
/// still sealed, and replaces their packages on its runner. A dry run builds, seals
/// and checks everything the same way, and uploads nothing.
pub async fn resign(http: &Http, path: &Path, dry_run: bool, mut client: lwd::Client) -> Result<()> {
    let key: Key = serde_json::from_slice(&crate::keyfile::read(path)?)?;
    let params = network(&key.network)?;
    let seed: [u8; 32] = hex::decode(&key.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("bad seed"))?;
    let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
    let runner = key.runner.trim_end_matches('/').to_string();

    let status = http.get(&format!("{runner}/api/status")).await?;
    let takes_resigns = status["features"].as_array().is_some_and(|f| f.iter().any(|f| f == "resign"));
    match (takes_resigns, dry_run) {
        (true, _) => {}
        (false, true) => println!("note: {runner} does not list the \"resign\" feature, so only a dry run works there"),
        (false, false) => bail!("{runner} does not take re-signs: its /api/status lists no \"resign\" feature"),
    }
    let live = read_live(http, &mut client, &params, &pocket, &key, &runner).await?;
    let http = http.clone();
    tokio::task::spawn_blocking(move || {
        let plan = build(&params, &pocket, &key, &live, unix_now())?;
        deliver(&http, &runner, &seed, &plan, dry_run).map(|_| ())
    })
    .await?
}

/// Reads the subscription, its offer and the pocket's live note. The note is read
/// from the transaction that created it, from an independent server, so the runner
/// can only point at it.
async fn read_live(
    http: &Http,
    client: &mut lwd::Client,
    params: &Network,
    pocket: &Pocket,
    key: &Key,
    runner: &str,
) -> Result<Live> {
    let id = key
        .subscription_id
        .as_deref()
        .context("this subscription was never uploaded; finish it with `cadence resume` instead")?;
    let sub: SubView = serde_json::from_value(http.get(&format!("{runner}/api/subscriptions/{id}")).await?)?;
    active(&sub)?;
    let offer: OfferView = serde_json::from_value(http.get(&format!("{runner}/api/offers/{}", key.offer_id)).await?)?;
    let first = remaining(&sub)?[0].k;
    let (parent, to, what) = match first {
        1 => (
            sub.funding.as_ref().map(|f| f.txid.clone()).context("the runner shows no funding for this subscription")?,
            pocket.funding_address(),
            "the funding note".to_string(),
        ),
        k => (
            sub.installments
                .iter()
                .find(|i| i.k == k - 1)
                .and_then(|i| i.txid.clone())
                .with_context(|| format!("the runner shows no transaction for installment {}", k - 1))?,
            pocket.change_address(),
            format!("the change of installment {}", k - 1),
        ),
    };
    let (tx, _) = lwd::transaction(client, params, &parse_txid(&parent)?).await?;
    let current = mandate::pocket_outputs(&tx, pocket)
        .into_iter()
        .find(|n| n.recipient() == to)
        .with_context(|| format!("transaction {parent} leaves this pocket no note"))?;
    let nf = hex::encode(current.nullifier(pocket.fvk()).to_bytes());
    let state: PocketView = serde_json::from_value(http.get(&format!("{runner}/api/pockets/{}", key.pocket_id)).await?)?;
    if !state.notes.iter().any(|n| n.nullifier == nf) {
        if state.syncing {
            bail!("the runner is still scanning the block of installment {}; retry in a minute", first - 1);
        }
        bail!("the runner does not list {what} ({nf}) as unspent: the pocket was spent, so there is nothing to re-sign");
    }
    println!("re-signing from {what}: {} ZEC in {parent}", zec(current.value().inner()));
    let tip = lwd::tip(client).await?;
    Ok(Live { sub, offer, current, tip })
}

fn active(sub: &SubView) -> Result<()> {
    if sub.status != "active" {
        bail!("the subscription is {}; only an active one can be re-signed", sub.status);
    }
    Ok(())
}

/// The installments a re-sign replaces: every one still sealed, which is every one
/// after the last mined. One that opened but is not mined yet spends the note the
/// next would start from, so a re-sign waits until it is mined.
fn remaining(sub: &SubView) -> Result<Vec<&InstallmentView>> {
    let mut all: Vec<&InstallmentView> = sub.installments.iter().collect();
    all.sort_by_key(|i| i.k);
    if all.iter().enumerate().any(|(i, inst)| inst.k as usize != i + 1) {
        bail!("the runner numbers this subscription's installments oddly");
    }
    let first = all
        .iter()
        .position(|i| i.state == "sealed")
        .context("no installment is still sealed, so there is nothing to re-sign")?;
    if let Some(open) = all[..first].iter().find(|i| i.state != "mined") {
        bail!("installment {} is {}: wait until it is mined, then re-sign", open.k, open.state);
    }
    if let Some(odd) = all[first..].iter().find(|i| i.state != "sealed") {
        bail!("installment {} is {} although installment {} is still sealed", odd.k, odd.state, all[first].k);
    }
    Ok(all.split_off(first))
}

/// Signs the remaining installments from the live note under today's rules, checks
/// the chain they form, and seals each to the round it is already sealed to.
fn build(params: &Network, pocket: &Pocket, key: &Key, live: &Live, now: u64) -> Result<Plan> {
    let sub = &live.sub;
    if sub.pocket_id != key.pocket_id || sub.offer_id != key.offer_id {
        bail!("the runner's {} is not the subscription of this key's pocket", sub.subscription_id);
    }
    active(sub)?;
    let offer = &live.offer;
    if (offer.amount_zat, offer.count, offer.merchant_ua.as_str()) != (key.amount_zat, key.count, key.merchant_ua.as_str())
        || sub.installments.len() != key.count as usize
        || sub.installments.iter().any(|i| i.amount_zat != key.amount_zat)
    {
        bail!("the runner's offer or subscription no longer matches the terms in this key");
    }
    let sealed = remaining(sub)?;
    let chain = DrandChain::quicknet();
    let schedule: Vec<(u32, u64)> = sealed.iter().map(|i| (i.k, cadence_seal::time_of(&chain, i.release_round))).collect();
    let terms = Terms {
        amount: Zatoshis::from_u64(key.amount_zat).map_err(|_| anyhow!("bad amount"))?,
        count: key.count,
        period_secs: key.period_secs,
        // Every installment's time, as sealed: the jitter the payer drew at signing stays.
        release_times: sub.installments.iter().map(|i| cadence_seal::time_of(&chain, i.release_round)).collect(),
        merchant: orchard_receiver(params, &key.merchant_ua)?,
        label: key.label.clone(),
    };
    let recipient: x25519::Recipient = offer
        .runner_age_recipient
        .parse()
        .map_err(|e| anyhow!("bad runner recipient: {e}"))?;
    let (first, last) = (schedule[0].0, key.count);

    let presigned = mandate::presign_remaining(
        params,
        pocket,
        live.current,
        &terms,
        &schedule,
        live.tip,
        now,
        hex16(&key.mandate_id)?,
        |k, done, total| {
            if done == total {
                println!("installment {k}: {total} rungs signed");
            }
        },
    )
    .map_err(|e| match e {
        mandate::Error::Underfunded { needed, available } => anyhow!(
            "the pocket holds {} ZEC, but installments {first} to {last} need {} ZEC at today's fees: {} ZEC more. \
             A pocket takes one payment, so it cannot be topped up; cancel and subscribe again instead",
            zec(available),
            zec(needed),
            zec(needed.saturating_sub(available))
        ),
        other => anyhow!("{other:?}"),
    })?;
    if presigned.len() != sealed.len() {
        bail!("the pocket only covers {} of the {} installments left", presigned.len(), sealed.len());
    }
    mandate::check_chain(params, pocket, &live.current, &terms, &presigned)
        .map_err(|e| anyhow!("the re-signed installments do not check out: {e}"))?;

    let mut plan = Plan { subscription_id: sub.subscription_id.clone(), packages: vec![], spends: vec![] };
    for (p, inst) in presigned.iter().zip(&sealed) {
        let sealed = cadence_seal::seal(&serde_json::to_vec(&p.ladder)?, &recipient, &chain, inst.release_round)
            .map_err(|e| anyhow!("sealing installment {}: {e:?}", p.k))?;
        // What the runner checks of every package it takes.
        if cadence_seal::header_round(&sealed).map_err(|e| anyhow!("{e:?}"))? != inst.release_round {
            bail!("installment {} did not seal to round {}", p.k, inst.release_round);
        }
        let heights = p.ladder.rungs.iter().map(|r| r.target_height);
        let (lo, hi) = (heights.clone().min().unwrap_or(0), heights.max().unwrap_or(0));
        println!(
            "installment {}: round {} as before (releases at {}), {} rungs for heights {lo}..={hi}, spends {}, sealed in {} bytes",
            p.k,
            inst.release_round,
            p.release_at,
            p.ladder.rungs.len(),
            p.ladder.spends_nullifier,
            sealed.len()
        );
        plan.spends.push(p.ladder.spends_nullifier.clone());
        plan.packages.push((p.k, inst.release_round, sealed));
    }
    Ok(plan)
}

/// The path of `url`, without its origin, as the runner checks a signature against.
fn path_of(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.find('/').map_or("/", |i| &rest[i..])
}

/// Uploads the plan, signed with the payer's key, unless this is a dry run. Returns
/// the runner's answer.
fn deliver(http: &Http, runner: &str, seed: &[u8; 32], plan: &Plan, dry_run: bool) -> Result<Option<Value>> {
    let ks: Vec<String> = plan.packages.iter().map(|(k, _, _)| k.to_string()).collect();
    let id = &plan.subscription_id;
    if dry_run {
        println!("dry run: every package checks out; installments {} of {id} would be replaced. Nothing was uploaded.", ks.join(", "));
        return Ok(None);
    }
    let installments: Vec<Value> = plan
        .packages
        .iter()
        .map(|(k, round, sealed)| json!({ "k": k, "release_round": round, "sealed": STANDARD.encode(sealed) }))
        .collect();
    let body = serde_json::to_vec(&json!({ "installments": installments }))?;
    let url = format!("{runner}/api/subscriptions/{id}/resign");
    let headers = payer_auth::headers(&payer_auth::key(seed), "POST", path_of(&url), unix_now(), &body);
    let answer = http.post_bytes(&url, body, &headers).map_err(|e| {
        if e.to_string().contains("no payer_auth_key") {
            e.context("this subscription registered no payer key when it was uploaded, so it cannot be re-signed; only cancelled")
        } else {
            e
        }
    })?;
    println!("re-signed: the runner replaced installments {} of {id}", ks.join(", "));
    Ok(Some(answer))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };

    use cadence_core::{build_rung, seed, Installment};
    use cadence_seal::age::x25519::Identity;
    use ed25519_dalek::{Signature, VerifyingKey};
    use orchard::{
        note::{NoteVersion, RandomSeed, Rho},
        value::NoteValue,
    };
    use sha2::{Digest, Sha256};
    use zcash_protocol::consensus::TestNetwork;

    use super::*;

    const SEED: [u8; 32] = [42; 32];
    const MANDATE: [u8; 16] = [1; 16];
    const TIP: u32 = 4_550_000;
    const AMOUNT: u64 = 20_000;
    const ROUNDS: [u64; 2] = [25_000_000, 25_000_100];

    fn params() -> Network {
        Network::TestNetwork
    }

    fn pocket() -> Pocket {
        Pocket::from_seed(&SEED, TestNetwork.network_type().coin_type())
    }

    fn merchant_ua() -> String {
        Pocket::from_seed(&[9; 32], 1).funding_ua(&params())
    }

    /// A web app's cancel key for a plan of two installments, with the fields the CLI ignores.
    fn key() -> Key {
        let kit = json!({
            "network": "test", "seed_hex": hex::encode(SEED), "runner": "https://runner.example",
            "offer_id": "off_x", "pocket_id": "pkt_x", "subscription_id": "sub_x", "mandate_id": hex::encode(MANDATE),
            "label": "Plan (pkt_x)", "amount_zat": AMOUNT, "count": 2, "period_secs": 300, "first_release_at": 1,
            "first_in_secs": 0, "merchant_ua": merchant_ua(), "funding_tx_hex": null, "funding_height": null,
            "kind": "cadence-kit/1", "birthday_height": 1, "pocket_ua": pocket().funding_ua(&params()), "notes": [],
        });
        serde_json::from_value(kit).unwrap()
    }

    fn funding_note(pocket: &Pocket, value: u64) -> Note {
        let rho = Option::from(Rho::from_bytes(&[7u8; 32])).unwrap();
        (0u8..=255)
            .find_map(|i| {
                let rseed = Option::from(RandomSeed::from_bytes([i; 32], &rho))?;
                Option::from(Note::from_parts(pocket.funding_address(), NoteValue::from_raw(value), rho, rseed, NoteVersion::V3))
            })
            .unwrap()
    }

    /// The change C(1) that installment 1, as first signed, left once it was mined.
    fn change_of_installment_1() -> Note {
        let (pocket, key) = (pocket(), key());
        let inst = Installment {
            input: funding_note(&pocket, 60_000),
            amount: Zatoshis::const_from_u64(AMOUNT),
            merchant: orchard_receiver(&params(), &key.merchant_ua).unwrap(),
            memo: mandate::installment_memo(&key.label, 1, 2),
        };
        let s = seed::rung_seed(&seed::app_secret(&pocket), &MANDATE, 1, 0);
        build_rung(&params(), BlockHeight::from_u32(TIP - 20), &pocket, &inst, s).unwrap().change.unwrap()
    }

    fn installment(k: u32, state: &str) -> InstallmentView {
        InstallmentView {
            k,
            amount_zat: AMOUNT,
            release_round: ROUNDS[k as usize - 1],
            state: state.into(),
            txid: (state != "sealed").then(|| format!("{k:064}")),
        }
    }

    fn live(states: [&str; 2], current: Note, runner: &Identity) -> Live {
        Live {
            sub: SubView {
                subscription_id: "sub_x".into(),
                offer_id: "off_x".into(),
                pocket_id: "pkt_x".into(),
                status: "active".into(),
                funding: Some(FundingView { txid: "00".repeat(32) }),
                installments: vec![installment(1, states[0]), installment(2, states[1])],
            },
            offer: OfferView {
                amount_zat: AMOUNT,
                count: 2,
                merchant_ua: merchant_ua(),
                runner_age_recipient: runner.to_public().to_string(),
            },
            current,
            tip: BlockHeight::from_u32(TIP),
        }
    }

    /// The re-sign's own clock: an hour before installment 2's round, as sealed.
    fn now() -> u64 {
        cadence_seal::time_of(&DrandChain::quicknet(), ROUNDS[1]) - 3_600
    }

    #[test]
    fn resigns_from_the_change_of_the_last_mined_installment_for_the_same_round() {
        let runner = Identity::generate();
        let current = change_of_installment_1();
        let plan = build(&params(), &pocket(), &key(), &live(["mined", "sealed"], current, &runner), now()).unwrap();
        assert_eq!(plan.subscription_id, "sub_x");
        let [(k, round, sealed)] = &plan.packages[..] else { panic!("{} packages", plan.packages.len()) };
        assert_eq!((*k, *round), (2, ROUNDS[1]));
        assert_eq!(cadence_seal::header_round(sealed).unwrap(), ROUNDS[1]);
        assert!(cadence_seal::BUCKETS.contains(&sealed.len()));
        assert_eq!(plan.spends, [hex::encode(current.nullifier(pocket().fvk()).to_bytes())]);
    }

    #[test]
    fn a_resign_waits_for_an_installment_in_flight_and_needs_one_still_sealed() {
        let runner = Identity::generate();
        let current = change_of_installment_1();
        let err = |states, current| build(&params(), &pocket(), &key(), &live(states, current, &runner), now()).err().unwrap().to_string();
        assert_eq!(err(["broadcast", "sealed"], current), "installment 1 is broadcast: wait until it is mined, then re-sign");
        assert_eq!(err(["due", "sealed"], current), "installment 1 is due: wait until it is mined, then re-sign");
        assert_eq!(err(["mined", "broadcast"], current), "no installment is still sealed, so there is nothing to re-sign");
        let mut stopped = live(["mined", "sealed"], current, &runner);
        stopped.sub.status = "stopped".into();
        let e = build(&params(), &pocket(), &key(), &stopped, now()).err().unwrap();
        assert_eq!(e.to_string(), "the subscription is stopped; only an active one can be re-signed");
        let mut repriced = live(["mined", "sealed"], current, &runner);
        repriced.offer.amount_zat += 1;
        let e = build(&params(), &pocket(), &key(), &repriced, now()).err().unwrap();
        assert_eq!(e.to_string(), "the runner's offer or subscription no longer matches the terms in this key");
    }

    #[test]
    fn a_short_pocket_is_told_how_much_more_it_needs() {
        let runner = Identity::generate();
        let short = funding_note(&pocket(), 29_000);
        let err = build(&params(), &pocket(), &key(), &live(["sealed", "sealed"], short, &runner), now()).err().unwrap();
        assert_eq!(
            err.to_string(),
            "the pocket holds 0.00029 ZEC, but installments 1 to 2 need 0.0006 ZEC at today's fees: 0.00031 ZEC more. \
             A pocket takes one payment, so it cannot be topped up; cancel and subscribe again instead"
        );
    }

    #[test]
    fn reads_the_clis_own_subscription_file_too() {
        let file = json!({
            "network": "test", "seed_hex": hex::encode(SEED), "runner": "http://127.0.0.1:8737", "offer_id": "off_x",
            "pocket_id": "pkt_x", "subscription_id": "sub_x", "mandate_id": hex::encode(MANDATE), "amount_zat": AMOUNT,
            "count": 2, "period_secs": 300, "first_release_at": 1, "merchant_ua": merchant_ua(),
            "funding_tx_hex": null, "funding_height": null,
        });
        let key: Key = serde_json::from_value(file).unwrap();
        assert_eq!((key.label.as_str(), key.subscription_id.as_deref()), ("", Some("sub_x")));
    }

    /// A runner on this machine that answers every request with `answer` and records
    /// each as `(request line, headers, body)`.
    type Recorded = Arc<Mutex<Vec<(String, Vec<(String, String)>, Vec<u8>)>>>;

    fn stub_runner(answer: Value) -> (String, Recorded) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen: Recorded = Arc::default();
        let record = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut headers = vec![];
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    match h.trim_end().split_once(": ") {
                        Some((name, value)) => headers.push((name.to_ascii_lowercase(), value.to_string())),
                        None => break,
                    }
                }
                let len = headers.iter().find(|(n, _)| n == "content-length").map_or(0, |(_, v)| v.parse().unwrap());
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                record.lock().unwrap().push((line.trim_end().to_string(), headers, body));
                let out = answer.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len()).unwrap();
            }
        });
        (url, seen)
    }

    #[test]
    fn a_dry_run_uploads_nothing_and_an_upload_is_signed_by_the_payer() {
        let (runner, seen) = stub_runner(json!({ "subscription_id": "sub_x", "replaced": [2] }));
        let plan = Plan {
            subscription_id: "sub_x".into(),
            packages: vec![(2, ROUNDS[1], vec![1, 2, 3])],
            spends: vec!["ab".repeat(32)],
        };
        let http = Http::direct();
        assert_eq!(deliver(&http, &runner, &SEED, &plan, true).unwrap(), None);
        let answer = deliver(&http, &runner, &SEED, &plan, false).unwrap().unwrap();
        assert_eq!(answer["replaced"], json!([2]));

        // The stub answers one request at a time, so the dry run made none.
        let seen = seen.lock().unwrap();
        let [(line, headers, body)] = &seen[..] else { panic!("{} requests", seen.len()) };
        assert_eq!(line, "POST /api/subscriptions/sub_x/resign HTTP/1.1");
        let sent: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(sent, json!({ "installments": [{ "k": 2, "release_round": ROUNDS[1], "sealed": "AQID" }] }));
        let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone()).unwrap();
        let (at, sig) = (header("x-cadence-payer-timestamp"), header("x-cadence-payer-signature"));
        assert!(at.parse::<u64>().unwrap().abs_diff(unix_now()) < 5);
        let message = format!(
            "cadence-payer-v1\nPOST\n/api/subscriptions/sub_x/resign\n{at}\n{}",
            hex::encode(Sha256::digest(body))
        );
        let public: [u8; 32] = hex::decode(payer_auth::public_hex(&SEED)).unwrap().try_into().unwrap();
        let sig: [u8; 64] = hex::decode(sig).unwrap().try_into().unwrap();
        VerifyingKey::from_bytes(&public).unwrap().verify_strict(message.as_bytes(), &Signature::from_bytes(&sig)).unwrap();
    }

    #[test]
    fn signed_paths_have_no_origin() {
        assert_eq!(path_of("https://runner.example/api/subscriptions/sub_x/resign"), "/api/subscriptions/sub_x/resign");
        assert_eq!(path_of("http://127.0.0.1:8737/api/x"), "/api/x");
        assert_eq!(path_of("https://runner.example"), "/");
    }
}
