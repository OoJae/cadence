//! Requests the payer signs (`docs/api.md`, "Payer auth").
//!
//! The payer's key is an Ed25519 key derived from the pocket seed with HKDF-SHA256
//! (salt `cadence payer auth v1`, no info), registered as `payer_auth_key` with the
//! subscription. A signed request carries `X-Cadence-Payer-Timestamp` and
//! `X-Cadence-Payer-Signature`, a signature over
//!
//! ```text
//! cadence-payer-v1\n{METHOD}\n{PATH}\n{TIMESTAMP}\n{hex sha256 of the body}
//! ```
//!
//! The runner accepts it within [`WINDOW_SECS`] of its own clock, and only once.

use std::{collections::HashMap, sync::Mutex};

use axum::http::HeaderMap;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub const TIMESTAMP_HEADER: &str = "x-cadence-payer-timestamp";
pub const SIGNATURE_HEADER: &str = "x-cadence-payer-signature";

/// How far a request's timestamp may be from the runner's clock, and so how long
/// its signature is remembered.
pub const WINDOW_SECS: u64 = 300;

/// The bytes a payer signs for one request. `path` has no origin and no query.
pub fn message(method: &str, path: &str, timestamp: &str, body: &[u8]) -> Vec<u8> {
    format!("cadence-payer-v1\n{method}\n{path}\n{timestamp}\n{}", hex::encode(Sha256::digest(body))).into_bytes()
}

/// A registered payer key: 64 hex characters, a valid Ed25519 public key.
pub fn parse_key(key_hex: &str) -> Result<VerifyingKey, String> {
    let bytes: [u8; 32] = hex::decode(key_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("payer_auth_key must be 64 hex characters")?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| "payer_auth_key is not an Ed25519 public key".into())
}

/// Signatures already accepted, each with the time its timestamp leaves the window.
#[derive(Default)]
pub struct Replays(Mutex<HashMap<[u8; 64], u64>>);

impl Replays {
    /// Records `sig` until `until`. False if it is recorded already.
    fn first_use(&self, sig: [u8; 64], until: u64, now: u64) -> bool {
        let mut seen = self.0.lock().unwrap();
        seen.retain(|_, expires| *expires >= now);
        seen.insert(sig, until).is_none()
    }
}

/// Checks a request signed with the subscription's `key` (hex), if it has one. The
/// error is the reason for a 403.
pub fn verify(
    key: Option<&str>,
    method: &str,
    path: &str,
    headers: &HeaderMap,
    body: &[u8],
    now: u64,
    replays: &Replays,
) -> Result<(), String> {
    let key = parse_key(key.ok_or("this subscription has no payer_auth_key")?)?;
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    let timestamp = header(TIMESTAMP_HEADER)
        .filter(|t| (1..=20).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit()))
        .ok_or("X-Cadence-Payer-Timestamp must be unix seconds")?;
    let at: u64 = timestamp.parse().map_err(|_| "X-Cadence-Payer-Timestamp must be unix seconds")?;
    if at.abs_diff(now) > WINDOW_SECS {
        return Err(format!(
            "the request is signed for {at}, {} s off the runner's clock; at most {WINDOW_SECS} s is allowed",
            at.abs_diff(now)
        ));
    }
    let sig: [u8; 64] = header(SIGNATURE_HEADER)
        .and_then(|s| hex::decode(s).ok())
        .and_then(|b| b.try_into().ok())
        .ok_or("X-Cadence-Payer-Signature must be 128 hex characters")?;
    // Strict, so that no second encoding of an accepted signature gets past the replay check.
    key.verify_strict(&message(method, path, timestamp, body), &Signature::from_bytes(&sig))
        .map_err(|_| "the payer signature does not verify")?;
    if !replays.first_use(sig, at + WINDOW_SECS, now) {
        return Err("this signed request was already used".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use ed25519_dalek::{Signer, SigningKey};
    use hkdf::Hkdf;
    use sha2::Sha256;

    use super::*;

    /// The payer's key, as the web app and the CLI derive it from the pocket seed.
    pub fn derive(seed: &[u8; 32]) -> SigningKey {
        let mut okm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(b"cadence payer auth v1"), seed)
            .expand(&[], &mut okm)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        SigningKey::from_bytes(&okm)
    }

    /// The two headers of a request signed with `key`.
    pub fn signed(key: &SigningKey, method: &str, path: &str, at: u64, body: &[u8]) -> HeaderMap {
        let sig = key.sign(&message(method, path, &at.to_string(), body));
        let mut headers = HeaderMap::new();
        headers.insert(TIMESTAMP_HEADER, HeaderValue::from_str(&at.to_string()).unwrap());
        headers.insert(SIGNATURE_HEADER, HeaderValue::from_str(&hex::encode(sig.to_bytes())).unwrap());
        headers
    }

    const NOW: u64 = 1_793_170_000;
    const PATH: &str = "/api/subscriptions/sub_0123456789abcdef0123/pass";

    #[test]
    fn test_vector() {
        // Shared with the web app's signer, which must reproduce it exactly. Every
        // value was also computed with Python's hmac module and `cryptography`, which
        // gives the same signature from the seed imported as PKCS#8.
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        assert_eq!(hex::encode(seed), "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        let key = derive(&seed);
        assert_eq!(hex::encode(key.to_bytes()), "000ec13173e816022d61c8cc23ad87459d0fad259093ceed0988695cfa89b440");
        assert_eq!(
            hex::encode(key.verifying_key().to_bytes()),
            "b2b73d2536181defd22ebf9b4b45a66695b3e9965f731eccc2b84f3c71a9198d"
        );
        let message = message("POST", PATH, &NOW.to_string(), b"{}");
        assert_eq!(
            String::from_utf8(message.clone()).unwrap(),
            "cadence-payer-v1\nPOST\n/api/subscriptions/sub_0123456789abcdef0123/pass\n1793170000\n\
             44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
        let sig = key.sign(&message);
        assert_eq!(
            hex::encode(sig.to_bytes()),
            "1ed2b84c4acc67a1bd3023dd80462d221286871aaa5ad0170d63c14e42ba4df1\
             6f485a8cfa3819f6f53c3282358a7c8e66d9a6886a95eca725f0c33ecb851b0a"
        );
        let headers = signed(&key, "POST", PATH, NOW, b"{}");
        let public = hex::encode(key.verifying_key().to_bytes());
        assert_eq!(verify(Some(&public), "POST", PATH, &headers, b"{}", NOW, &Replays::default()), Ok(()));
    }

    #[test]
    fn requests_are_checked() {
        let key = derive(&[7; 32]);
        let public = hex::encode(key.verifying_key().to_bytes());
        let replays = Replays::default();
        let check = |headers: &HeaderMap, body: &[u8], now| verify(Some(&public), "POST", PATH, headers, body, now, &replays);

        let headers = signed(&key, "POST", PATH, NOW, b"{}");
        // Another body, path or method than the one signed.
        assert_eq!(check(&headers, b"{ }", NOW), Err("the payer signature does not verify".into()));
        assert_eq!(
            verify(Some(&public), "POST", "/api/subscriptions/sub_other/pass", &headers, b"{}", NOW, &replays),
            Err("the payer signature does not verify".into())
        );
        assert_eq!(
            verify(Some(&public), "GET", PATH, &headers, b"{}", NOW, &replays),
            Err("the payer signature does not verify".into())
        );
        // Another key.
        let other = hex::encode(derive(&[8; 32]).verifying_key().to_bytes());
        assert_eq!(
            verify(Some(&other), "POST", PATH, &headers, b"{}", NOW, &replays),
            Err("the payer signature does not verify".into())
        );
        assert_eq!(
            verify(None, "POST", PATH, &headers, b"{}", NOW, &replays),
            Err("this subscription has no payer_auth_key".into())
        );

        // The clock window, either way.
        assert_eq!(check(&headers, b"{}", NOW + WINDOW_SECS), Ok(()));
        let early = signed(&key, "POST", PATH, NOW + WINDOW_SECS + 1, b"{}");
        let err = check(&early, b"{}", NOW).unwrap_err();
        assert!(err.ends_with("301 s off the runner's clock; at most 300 s is allowed"), "{err}");
        let late = signed(&key, "POST", PATH, NOW - WINDOW_SECS - 1, b"{}");
        assert!(check(&late, b"{}", NOW).is_err());

        let mut bad = signed(&key, "POST", PATH, NOW, b"{}");
        bad.insert(TIMESTAMP_HEADER, HeaderValue::from_static("+1793170000"));
        assert_eq!(check(&bad, b"{}", NOW), Err("X-Cadence-Payer-Timestamp must be unix seconds".into()));
        bad.insert(SIGNATURE_HEADER, HeaderValue::from_static("abcd"));
        bad.insert(TIMESTAMP_HEADER, HeaderValue::from_str(&NOW.to_string()).unwrap());
        assert_eq!(check(&bad, b"{}", NOW), Err("X-Cadence-Payer-Signature must be 128 hex characters".into()));
        assert_eq!(check(&HeaderMap::new(), b"{}", NOW), Err("X-Cadence-Payer-Timestamp must be unix seconds".into()));
    }

    #[test]
    fn a_signature_is_accepted_once_within_its_window() {
        let key = derive(&[7; 32]);
        let public = hex::encode(key.verifying_key().to_bytes());
        let replays = Replays::default();
        let check = |headers: &HeaderMap, now| verify(Some(&public), "POST", PATH, headers, b"{}", now, &replays);
        let headers = signed(&key, "POST", PATH, NOW, b"{}");
        assert_eq!(check(&headers, NOW), Ok(()));
        assert_eq!(check(&headers, NOW + 1), Err("this signed request was already used".into()));
        assert_eq!(check(&headers, NOW + WINDOW_SECS), Err("this signed request was already used".into()));
        // A fresh signature is fine, and the old one is forgotten once out of its window.
        assert_eq!(check(&signed(&key, "POST", PATH, NOW + 1, b"{}"), NOW + 1), Ok(()));
        check(&signed(&key, "POST", PATH, NOW + WINDOW_SECS + 1, b"{}"), NOW + WINDOW_SECS + 1).unwrap();
        assert_eq!(replays.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn registered_keys_are_ed25519_public_keys() {
        let public = hex::encode(derive(&[7; 32]).verifying_key().to_bytes());
        assert!(parse_key(&public).is_ok());
        assert!(parse_key(&public.to_uppercase()).is_ok());
        assert_eq!(parse_key(&public[..62]).unwrap_err(), "payer_auth_key must be 64 hex characters");
        assert_eq!(parse_key(&"zz".repeat(32)).unwrap_err(), "payer_auth_key must be 64 hex characters");
    }
}
