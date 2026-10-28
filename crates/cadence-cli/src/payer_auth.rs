//! The payer's key for requests the runner only takes from the payer, such as a
//! re-sign (`docs/api.md`, "Payer auth"). It is an Ed25519 key derived from the
//! pocket seed with HKDF-SHA256 (salt `cadence payer auth v1`, no info), registered
//! as `payer_auth_key` at the upload, exactly as the web app derives it.

use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

pub const TIMESTAMP_HEADER: &str = "X-Cadence-Payer-Timestamp";
pub const SIGNATURE_HEADER: &str = "X-Cadence-Payer-Signature";

/// The payer's signing key for the pocket with `seed`.
pub fn key(seed: &[u8; 32]) -> SigningKey {
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"cadence payer auth v1"), seed)
        .expand(&[], &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    SigningKey::from_bytes(&okm)
}

/// The hex public key the upload registers as `payer_auth_key`.
pub fn public_hex(seed: &[u8; 32]) -> String {
    hex::encode(key(seed).verifying_key().to_bytes())
}

/// The two headers that sign `body` for `method` on `path` (no origin, no query) at
/// unix time `at`.
pub fn headers(key: &SigningKey, method: &str, path: &str, at: u64, body: &[u8]) -> [(&'static str, String); 2] {
    let message = format!("cadence-payer-v1\n{method}\n{path}\n{at}\n{}", hex::encode(Sha256::digest(body)));
    let signature = key.sign(message.as_bytes());
    [(TIMESTAMP_HEADER, at.to_string()), (SIGNATURE_HEADER, hex::encode(signature.to_bytes()))]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vector() {
        // The vector the runner and the web app's signer share (cadence-runner's payer_auth.rs).
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        assert_eq!(hex::encode(seed), "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        assert_eq!(hex::encode(key(&seed).to_bytes()), "000ec13173e816022d61c8cc23ad87459d0fad259093ceed0988695cfa89b440");
        assert_eq!(public_hex(&seed), "b2b73d2536181defd22ebf9b4b45a66695b3e9965f731eccc2b84f3c71a9198d");
        let path = "/api/subscriptions/sub_0123456789abcdef0123/pass";
        let [(t, at), (s, sig)] = headers(&key(&seed), "POST", path, 1_793_170_000, b"{}");
        assert_eq!((t, at.as_str()), (TIMESTAMP_HEADER, "1793170000"));
        assert_eq!(s, SIGNATURE_HEADER);
        assert_eq!(
            sig,
            "1ed2b84c4acc67a1bd3023dd80462d221286871aaa5ad0170d63c14e42ba4df1\
             6f485a8cfa3819f6f53c3282358a7c8e66d9a6886a95eca725f0c33ecb851b0a"
        );
    }
}
