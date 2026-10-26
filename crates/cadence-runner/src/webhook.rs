//! Signed webhooks to the merchant.
//!
//! Every POST carries two signatures over the same body, with the same secret:
//! Cadence's `X-Cadence-Signature`, and CipherPay's `X-CipherPay-Signature` with
//! `X-CipherPay-Timestamp` and `X-CipherPay-Delivery-Id`, computed as CipherPay
//! computes them, so CipherPay's verification code accepts these unchanged. The
//! body's `event` is CipherPay's name for each event, so a switch on it carries over
//! too. Nothing else does: the rest of the body is Cadence's, an installment is
//! `subscription_id` and `k`, and none of CipherPay's `invoice_id`, `timestamp`,
//! `price_zec`, `received_zec`, `overpaid`, `price_id` or `immediate` are sent.
//!
//! Each event is delivered in its own task: up to three attempts, each with a hard
//! timeout. There is no outbox: pending retries live in memory only, so a restart
//! drops them, and an event whose attempts all fail is dropped. The runner's store is
//! the durable record (`docs/api.md`, "Webhooks").

use std::{sync::Arc, time::Duration};

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::{
    service::now,
    store::{Installment, Subscription},
};

/// The wait before each attempt: none, then 30 s and 2 min after a failure.
pub const ATTEMPT_DELAYS: [Duration; 3] = [Duration::ZERO, Duration::from_secs(30), Duration::from_secs(120)];

/// Hard limit on one attempt, from the DNS lookup to the response status.
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
pub struct Event {
    /// Cadence's name for the event, as Cadence has always sent it.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// CipherPay's name for the same event.
    pub event: &'static str,
    /// Random, made once per event, so every retry carries the same id. It is also
    /// sent as `X-CipherPay-Delivery-Id`, which no signature covers; this copy is signed.
    pub delivery_id: String,
    pub offer_id: String,
    pub subscription_id: String,
    pub k: u32,
    pub txid: Option<String>,
    pub amount_zat: u64,
    pub mined_height: Option<u32>,
}

impl Event {
    fn new(kind: &'static str, event: &'static str, sub: &Subscription, inst: &Installment) -> Self {
        // A random (v4) UUID, as CipherPay's delivery ids are.
        let mut bytes = [0u8; 16];
        rand::fill(&mut bytes);
        Event {
            kind,
            event,
            delivery_id: uuid::Builder::from_random_bytes(bytes).into_uuid().to_string(),
            offer_id: sub.offer_id.clone(),
            subscription_id: sub.subscription_id.clone(),
            k: inst.k,
            txid: inst.txid.clone(),
            amount_zat: inst.amount_zat,
            mined_height: inst.mined_height,
        }
    }

    /// An installment was mined. CipherPay's `confirmed`: a payment confirmed in a mined block.
    pub fn confirmed(sub: &Subscription, inst: &Installment) -> Self {
        Self::new("invoice.confirmed", "confirmed", sub, inst)
    }

    /// An installment cannot be released, so nothing was paid for it. CipherPay's
    /// `expired`: an invoice that ended without payment.
    pub fn expired(sub: &Subscription, inst: &Installment) -> Self {
        Self::new("invoice.expired", "expired", sub, inst)
    }

    /// The payer spent the pocket, which ends the subscription. CipherPay's
    /// `subscription.canceled`, sent without `immediate` as for CipherPay's
    /// end-of-period cancels: the period already paid for still runs.
    pub fn cancelled(sub: &Subscription, inst: &Installment) -> Self {
        Self::new("invoice.cancelled", "subscription.canceled", sub, inst)
    }
}

/// Hex HMAC-SHA256(secret, "<timestamp>.<body>").
fn hmac_hex(secret: &[u8], timestamp: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// `X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
pub fn signature(secret: &[u8], timestamp: u64, body: &[u8]) -> String {
    format!("t={timestamp},v1={}", hmac_hex(secret, &timestamp.to_string(), body))
}

/// `X-CipherPay-Signature: <hex HMAC-SHA256(secret, "<X-CipherPay-Timestamp>.<body>")>`.
pub fn cipherpay_signature(secret: &[u8], timestamp: &str, body: &[u8]) -> String {
    hmac_hex(secret, timestamp, body)
}

/// `X-CipherPay-Timestamp`: UTC to the second, as CipherPay writes it (`2026-02-21T18:30:00Z`).
pub fn iso8601(unix: u64) -> String {
    let (days, secs) = (unix / 86_400, unix % 86_400);
    // Days since 1970-01-01 to a proleptic Gregorian date (Hinnant's `civil_from_days`).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = era * 400 + yoe + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs / 3_600,
        secs / 60 % 60,
        secs % 60
    )
}

/// One attempt: `body` is the event as serialized once, signed for `timestamp`.
pub fn post(url: &str, secret: &[u8], delivery_id: &str, body: &[u8], timestamp: u64, timeout: Duration) -> Result<()> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // Only the configured URL receives the event; a redirect is a failed attempt.
        .max_redirects(0)
        .http_status_as_error(false)
        .build();
    let at = iso8601(timestamp);
    let response = ureq::Agent::new_with_config(config)
        .post(url)
        .header("Content-Type", "application/json")
        .header("X-Cadence-Signature", &signature(secret, timestamp, body))
        .header("X-CipherPay-Signature", &cipherpay_signature(secret, &at, body))
        .header("X-CipherPay-Timestamp", &at)
        .header("X-CipherPay-Delivery-Id", delivery_id)
        .send(body)?;
    if !response.status().is_success() {
        bail!("merchant endpoint answered {}", response.status());
    }
    Ok(())
}

/// Delivers `event` and logs the outcome, never the secret or the body. It touches
/// no shared state, so the scheduler never waits on it.
pub async fn deliver(url: String, secret: String, event: Event) {
    let what = format!("{} #{}: webhook {} ({})", event.subscription_id, event.k, event.kind, event.delivery_id);
    match attempts(&ATTEMPT_DELAYS, ATTEMPT_TIMEOUT, url, secret, &event).await {
        Ok(n) => println!("{what}: delivered on attempt {n}"),
        Err(e) => eprintln!("{what}: not delivered after {} attempts: {e:#}", ATTEMPT_DELAYS.len()),
    }
}

/// Tries once per entry of `delays`, after waiting it, until the merchant answers
/// 2xx. Returns the number of the attempt that succeeded.
async fn attempts(delays: &[Duration], timeout: Duration, url: String, secret: String, event: &Event) -> Result<usize> {
    let body: Arc<[u8]> = serde_json::to_vec(event)?.into();
    let url: Arc<str> = url.into();
    let secret: Arc<str> = secret.into();
    let mut last = anyhow!("no attempt was made");
    for (i, delay) in delays.iter().enumerate() {
        if i > 0 {
            eprintln!(
                "{} #{}: webhook {} attempt {i} failed: {last:#}; retrying in {delay:?}",
                event.subscription_id, event.k, event.kind
            );
        }
        tokio::time::sleep(*delay).await;
        let (url, secret, body, id) = (url.clone(), secret.clone(), body.clone(), event.delivery_id.clone());
        let attempt =
            tokio::task::spawn_blocking(move || post(&url, secret.as_bytes(), &id, &body, now(), timeout));
        // ureq enforces `timeout` itself; this bounds the wait even if it did not.
        last = match tokio::time::timeout(timeout + Duration::from_secs(1), attempt).await {
            Ok(Ok(Ok(()))) => return Ok(i + 1),
            Ok(Ok(Err(e))) => e,
            Ok(Err(e)) => e.into(),
            Err(_) => anyhow!("no answer within {timeout:?}"),
        };
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::mpsc,
        time::{Duration, Instant},
    };

    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    use super::{attempts, cipherpay_signature, deliver, iso8601, post, signature, Event};
    use crate::store::{Installment, Subscription};

    const SECRET: &str = "whsec_test";

    fn hmac_hex(key: &[u8], message: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(message);
        hex::encode(mac.finalize().into_bytes())
    }

    fn subscription() -> (Subscription, Installment) {
        let inst = Installment {
            k: 2,
            amount_zat: 100_000,
            release_round: 1,
            release_at: 1,
            state: "mined".into(),
            txid: Some("ab".repeat(32)),
            target_height: Some(4_529_240),
            expiry_height: Some(4_529_280),
            mined_height: Some(4_529_248),
            sealed: None,
            beacon: None,
        };
        let sub = Subscription {
            subscription_id: "sub_0123456789abcdef0123".into(),
            offer_id: "off_0123456789abcdef0123".into(),
            pocket_id: "pkt_0123456789abcdef0123".into(),
            status: "active".into(),
            created_at: 1,
            funding: None,
            installments: vec![inst.clone()],
        };
        (sub, inst)
    }

    struct Received {
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    /// Answers one request per entry of `statuses` with that status, or holds the
    /// connection without answering for 0, and hands over what each request carried.
    fn server(statuses: Vec<u16>) -> (String, mpsc::Receiver<Received>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/webhook", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for status in statuses {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream);
                let mut headers = HashMap::new();
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    let Some((name, value)) = line.trim_end().split_once(": ") else { break };
                    headers.insert(name.to_ascii_lowercase(), value.to_string());
                }
                let mut body = vec![0; headers["content-length"].parse().unwrap()];
                reader.read_exact(&mut body).unwrap();
                tx.send(Received { headers, body }).unwrap();
                let mut stream = reader.into_inner();
                if status == 0 {
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
                write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
        });
        (url, rx)
    }

    #[test]
    fn signature_is_hmac_of_timestamp_dot_body() {
        // HMAC-SHA256("secret", "1700000000.{}"), computed with Python's hmac module.
        assert_eq!(
            signature(b"secret", 1_700_000_000, b"{}"),
            "t=1700000000,v1=b8569b78799ff9e3cbff0fc2d63a33a2b57f3282abd07c37ae5e8e7d79a5f163"
        );
        assert_ne!(signature(b"secret", 1_700_000_000, b"{}"), signature(b"other", 1_700_000_000, b"{}"));
    }

    #[test]
    fn cipherpay_signature_is_hmac_of_iso_timestamp_dot_raw_body() {
        // CipherPay publishes no example signature. This is the example `confirmed`
        // payload and timestamp from cipherpay.app/docs/webhooks, signed as its
        // verifiers check: hex HMAC-SHA256(secret, timestamp + "." + raw body).
        let timestamp = "2026-02-21T18:30:00Z";
        let body = br#"{"event":"confirmed","invoice_id":"a1b2c3d4-...","txid":"17d8dd4df713a677d2f6637c2b449e71...","timestamp":"2026-02-21T18:30:00Z","price_zec":0.14285714,"received_zec":0.14285714,"overpaid":false}"#;
        assert_eq!(iso8601(1_771_698_600), timestamp);
        let sig = cipherpay_signature(SECRET.as_bytes(), timestamp, body);
        // Computed with Python's hmac module.
        assert_eq!(sig, "d6d904f493594e38702621b1368c4301045ffb0342b67cf759fc633d16bd75b2");
        assert_eq!(sig, hmac_hex(SECRET.as_bytes(), &[timestamp.as_bytes(), b".", body].concat()));
    }

    #[test]
    fn iso8601_is_utc_to_the_second() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn events_carry_both_names_the_offer_and_a_fresh_delivery_id() {
        let (sub, inst) = subscription();
        let body = serde_json::to_value(Event::confirmed(&sub, &inst)).unwrap();
        assert_eq!(body["type"], "invoice.confirmed");
        assert_eq!(body["event"], "confirmed");
        assert_eq!(body["offer_id"], "off_0123456789abcdef0123");
        assert_eq!(body["subscription_id"], "sub_0123456789abcdef0123");
        assert_eq!(body["k"], 2);
        assert_eq!(body["amount_zat"], 100_000);
        assert_eq!(body["mined_height"], 4_529_248);
        let id = uuid::Uuid::parse_str(body["delivery_id"].as_str().unwrap()).unwrap();
        assert_eq!(id.get_version_num(), 4);
        assert_ne!(Event::confirmed(&sub, &inst).delivery_id, Event::confirmed(&sub, &inst).delivery_id);

        let expired = Event::expired(&sub, &inst);
        assert_eq!((expired.kind, expired.event), ("invoice.expired", "expired"));
        let cancelled = Event::cancelled(&sub, &inst);
        assert_eq!((cancelled.kind, cancelled.event), ("invoice.cancelled", "subscription.canceled"));
    }

    #[test]
    fn post_sends_both_signatures_over_the_same_body() {
        let (url, rx) = server(vec![200]);
        let (sub, inst) = subscription();
        let event = Event::confirmed(&sub, &inst);
        let body = serde_json::to_vec(&event).unwrap();
        post(&url, SECRET.as_bytes(), &event.delivery_id, &body, 1_771_698_600, Duration::from_secs(5)).unwrap();

        let got = rx.recv().unwrap();
        assert_eq!(got.body, body);
        assert_eq!(got.headers["content-type"], "application/json");
        let cadence = &got.headers["x-cadence-signature"];
        assert_eq!(
            cadence,
            &format!("t=1771698600,v1={}", hmac_hex(SECRET.as_bytes(), &[b"1771698600.", &body[..]].concat()))
        );
        let at = &got.headers["x-cipherpay-timestamp"];
        assert_eq!(at, "2026-02-21T18:30:00Z");
        assert_eq!(
            got.headers["x-cipherpay-signature"],
            hmac_hex(SECRET.as_bytes(), &[at.as_bytes(), b".", &body[..]].concat())
        );
        assert_eq!(got.headers["x-cipherpay-delivery-id"], event.delivery_id);
    }

    #[tokio::test]
    async fn retries_carry_the_same_body_and_delivery_id() {
        let (url, rx) = server(vec![500, 200]);
        let (sub, inst) = subscription();
        let event = Event::confirmed(&sub, &inst);
        let delays = [Duration::ZERO, Duration::from_millis(20), Duration::from_millis(20)];
        let n = attempts(&delays, Duration::from_secs(5), url, SECRET.into(), &event).await.unwrap();
        assert_eq!(n, 2);
        let (first, second) = (rx.recv().unwrap(), rx.recv().unwrap());
        assert_eq!(first.body, second.body);
        assert_eq!(first.headers["x-cipherpay-delivery-id"], event.delivery_id);
        assert_eq!(second.headers["x-cipherpay-delivery-id"], event.delivery_id);
    }

    #[tokio::test]
    async fn gives_up_after_the_last_attempt() {
        let (url, rx) = server(vec![503, 503, 503]);
        let (sub, inst) = subscription();
        let event = Event::expired(&sub, &inst);
        let delays = [Duration::ZERO, Duration::from_millis(20), Duration::from_millis(20)];
        let err = attempts(&delays, Duration::from_secs(5), url, SECRET.into(), &event).await.unwrap_err();
        assert!(format!("{err:#}").contains("503"), "{err:#}");
        assert_eq!(rx.try_iter().count(), 3);
    }

    #[tokio::test]
    async fn deliver_posts_once_when_the_merchant_answers() {
        let (url, rx) = server(vec![200]);
        let (sub, inst) = subscription();
        let event = Event::cancelled(&sub, &inst);
        let id = event.delivery_id.clone();
        tokio::time::timeout(Duration::from_secs(5), deliver(url, SECRET.into(), event)).await.unwrap();
        let got = rx.recv().unwrap();
        assert_eq!(got.headers["x-cipherpay-delivery-id"], id);
        let body: serde_json::Value = serde_json::from_slice(&got.body).unwrap();
        assert_eq!(body["event"], "subscription.canceled");
        assert_eq!(body["delivery_id"], id.as_str());
    }

    #[test]
    fn an_attempt_without_an_answer_times_out() {
        let (url, _rx) = server(vec![0]);
        let started = Instant::now();
        assert!(post(&url, SECRET.as_bytes(), "id", b"{}", 1, Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    /// Posts one signed sample to a running receiver, such as `scripts/webhook-echo.py`:
    ///
    /// ```sh
    /// CADENCE_WEBHOOK_SECRET=s python3 scripts/webhook-echo.py 8799 &
    /// CADENCE_WEBHOOK_SECRET=s CADENCE_WEBHOOK_ECHO=http://127.0.0.1:8799/ \
    ///   cargo test -p cadence-runner -- --ignored sample_to_a_running_receiver
    /// ```
    #[test]
    #[ignore = "needs a receiver at $CADENCE_WEBHOOK_ECHO"]
    fn sample_to_a_running_receiver() {
        let url = std::env::var("CADENCE_WEBHOOK_ECHO").unwrap();
        let secret = std::env::var("CADENCE_WEBHOOK_SECRET").unwrap();
        let (sub, inst) = subscription();
        let event = Event::confirmed(&sub, &inst);
        let body = serde_json::to_vec(&event).unwrap();
        post(&url, secret.as_bytes(), &event.delivery_id, &body, crate::service::now(), Duration::from_secs(5)).unwrap();
    }
}
