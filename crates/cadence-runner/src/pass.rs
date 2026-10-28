//! Access passes (`docs/api.md`, "Passes"): the runner's signed statement that a
//! subscription is paid up until `valid_until`. A merchant's site checks one with the
//! runner's pass key (`GET /api/passes/key`), or asks `POST /api/passes/verify`. A
//! pass names the subscription, which the merchant knows already, and never the payer.

use std::{fs, io::Write, path::Path};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::store::Subscription;

/// What a pass says, signed byte for byte as serialized here.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Payload {
    pub v: u32,
    /// The runner's network, `main` or `test`.
    pub iss: String,
    pub offer_id: String,
    pub sub: String,
    /// Installments mined.
    pub paid: u32,
    pub valid_until: u64,
    pub iat: u64,
}

/// Where the pass key lives: next to the runner's age identity.
pub fn key_path(identity: &Path) -> std::path::PathBuf {
    identity.with_file_name("pass-key.txt")
}

/// The runner's pass key, made the first time: a hex Ed25519 seed that only the
/// runner's user can read.
pub fn load_or_create(path: &Path) -> Result<SigningKey> {
    if !path.exists() {
        let mut seed = [0u8; 32];
        rand::fill(&mut seed);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        writeln!(options.open(path).with_context(|| format!("creating {}", path.display()))?, "{}", hex::encode(seed))?;
    }
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let seed: [u8; 32] = hex::decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow!("{}: not a hex pass key", path.display()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Until when a pass for `sub` holds: half a period past the release of its first
/// installment not yet mined, or, once all are mined, past the last one's release
/// plus a period. During a trial nothing is mined, so this is installment 1's
/// release plus the grace.
pub fn valid_until(sub: &Subscription, period_secs: u64) -> Option<u64> {
    let paid_until = match sub.installments.iter().find(|i| i.state != "mined") {
        Some(next) => next.release_at,
        None => sub.installments.last()?.release_at.saturating_add(period_secs),
    };
    Some(paid_until.saturating_add(period_secs / 2))
}

/// `<b64url(payload)>.<b64url(signature)>`.
pub fn issue(key: &SigningKey, payload: &Payload) -> Result<String> {
    let bytes = serde_json::to_vec(payload)?;
    let sig = key.sign(&bytes);
    Ok(format!("{}.{}", URL_SAFE_NO_PAD.encode(&bytes), URL_SAFE_NO_PAD.encode(sig.to_bytes())))
}

/// Why a pass is not valid, with what it says when its signature checks.
#[derive(Debug, PartialEq)]
pub enum Invalid {
    Malformed,
    BadSignature,
    Expired(Payload),
}

impl Invalid {
    pub fn reason(&self) -> &'static str {
        match self {
            Invalid::Malformed => "malformed",
            Invalid::BadSignature => "bad signature",
            Invalid::Expired(_) => "expired",
        }
    }
}

/// A pass is valid when `key` signed it and `now` is at most its `valid_until`.
pub fn check(key: &VerifyingKey, pass: &str, now: u64) -> Result<Payload, Invalid> {
    let (payload, sig) = pass.split_once('.').ok_or(Invalid::Malformed)?;
    let payload = URL_SAFE_NO_PAD.decode(payload).map_err(|_| Invalid::Malformed)?;
    let sig: [u8; 64] = URL_SAFE_NO_PAD
        .decode(sig)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(Invalid::Malformed)?;
    key.verify_strict(&payload, &Signature::from_bytes(&sig)).map_err(|_| Invalid::BadSignature)?;
    let payload: Payload = serde_json::from_slice(&payload).map_err(|_| Invalid::Malformed)?;
    if payload.v != 1 {
        return Err(Invalid::Malformed);
    }
    if now > payload.valid_until {
        return Err(Invalid::Expired(payload));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Installment;

    fn sub(states: &[&str], period: u64) -> Subscription {
        let installments = states
            .iter()
            .enumerate()
            .map(|(i, state)| Installment {
                k: i as u32 + 1,
                amount_zat: 20_000,
                release_round: 0,
                release_at: 1_000_000 + i as u64 * period,
                state: state.to_string(),
                txid: None,
                target_height: None,
                expiry_height: None,
                mined_height: (*state == "mined").then_some(10 + i as u32),
                sealed: None,
                beacon: None,
            })
            .collect();
        Subscription {
            subscription_id: "sub_test".into(),
            offer_id: "off_test".into(),
            pocket_id: "pkt_test".into(),
            status: "active".into(),
            created_at: 0,
            funding: None,
            installments,
            refundable: false,
            refund: None,
            payer_auth_key: None,
            keep_until: None,
        }
    }

    #[test]
    fn valid_until_is_half_a_period_past_what_is_paid_for() {
        // Nothing mined yet (a trial, or installment 1 not yet released).
        assert_eq!(valid_until(&sub(&["sealed", "sealed", "sealed"], 600), 600), Some(1_000_300));
        // Paid through 1: until #2 is due, plus the grace.
        assert_eq!(valid_until(&sub(&["mined", "due", "sealed"], 600), 600), Some(1_000_900));
        // Paid through all: the last period runs out.
        assert_eq!(valid_until(&sub(&["mined", "mined", "mined"], 600), 600), Some(1_001_200 + 600 + 300));
        assert_eq!(valid_until(&sub(&[], 600), 600), None);
    }

    #[test]
    fn passes_check_their_signature_and_time() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let payload = Payload {
            v: 1,
            iss: "test".into(),
            offer_id: "off_x".into(),
            sub: "sub_x".into(),
            paid: 1,
            valid_until: 2_000,
            iat: 1_000,
        };
        let pass = issue(&key, &payload).unwrap();
        let (encoded, _) = pass.split_once('.').unwrap();
        assert_eq!(
            String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap(),
            r#"{"v":1,"iss":"test","offer_id":"off_x","sub":"sub_x","paid":1,"valid_until":2000,"iat":1000}"#
        );
        let public = key.verifying_key();
        assert_eq!(check(&public, &pass, 2_000).as_ref(), Ok(&payload));
        match check(&public, &pass, 2_001) {
            Err(Invalid::Expired(p)) => assert_eq!(p, payload),
            other => panic!("{other:?}"),
        }
        let other = SigningKey::from_bytes(&[4; 32]).verifying_key();
        assert_eq!(check(&other, &pass, 1_500), Err(Invalid::BadSignature));
        // The same signature over a longer pass.
        let (_, sig) = pass.split_once('.').unwrap();
        let longer = Payload { valid_until: 9_999, ..payload };
        let forged = format!("{}.{sig}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&longer).unwrap()));
        assert_eq!(check(&public, &forged, 1_500), Err(Invalid::BadSignature));
        for junk in ["", "abc", "abc.def", &format!("{encoded}.")] {
            assert_eq!(check(&public, junk, 1_500), Err(Invalid::Malformed), "{junk}");
        }
    }

    #[test]
    fn the_pass_key_is_made_once_and_kept_private() {
        let dir = std::env::temp_dir().join(format!("cadence-pass-key-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = key_path(&dir.join("identity.txt"));
        assert_eq!(path, dir.join("pass-key.txt"));
        let _ = fs::remove_file(&path);
        let made = load_or_create(&path).unwrap();
        assert_eq!(load_or_create(&path).unwrap().to_bytes(), made.to_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
