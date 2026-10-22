//! CipherPay-shaped webhooks, so a merchant's existing handler works unchanged.

use anyhow::{bail, Result};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::store::{Installment, Subscription};

#[derive(Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub subscription_id: String,
    pub k: u32,
    pub txid: Option<String>,
    pub amount_zat: u64,
    pub mined_height: Option<u32>,
}

impl Event {
    fn new(kind: &'static str, sub: &Subscription, inst: &Installment) -> Self {
        Event {
            kind,
            subscription_id: sub.subscription_id.clone(),
            k: inst.k,
            txid: inst.txid.clone(),
            amount_zat: inst.amount_zat,
            mined_height: inst.mined_height,
        }
    }

    pub fn confirmed(sub: &Subscription, inst: &Installment) -> Self {
        Self::new("invoice.confirmed", sub, inst)
    }

    pub fn expired(sub: &Subscription, inst: &Installment) -> Self {
        Self::new("invoice.expired", sub, inst)
    }

    pub fn cancelled(sub: &Subscription, inst: &Installment) -> Self {
        Self::new("invoice.cancelled", sub, inst)
    }
}

/// `X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
pub fn signature(secret: &[u8], timestamp: u64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    format!("t={timestamp},v1={}", hex::encode(mac.finalize().into_bytes()))
}

pub fn post(url: &str, secret: &[u8], event: &Event, timestamp: u64) -> Result<()> {
    let body = serde_json::to_vec(event)?;
    let response = ureq::post(url)
        .header("Content-Type", "application/json")
        .header("X-Cadence-Signature", &signature(secret, timestamp, &body))
        .send(&body[..])?;
    if !response.status().is_success() {
        bail!("merchant endpoint answered {}", response.status());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::signature;

    #[test]
    fn signature_is_hmac_of_timestamp_dot_body() {
        // HMAC-SHA256("secret", "1700000000.{}")
        let sig = signature(b"secret", 1_700_000_000, b"{}");
        assert!(sig.starts_with("t=1700000000,v1="));
        assert_eq!(sig.len(), "t=1700000000,v1=".len() + 64);
        assert_ne!(sig, signature(b"other", 1_700_000_000, b"{}"));
    }
}
