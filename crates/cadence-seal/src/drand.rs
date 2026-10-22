//! drand chain parameters, round arithmetic, and beacon retrieval.
//!
//! A drand beacon for round `r` is a threshold BLS signature over `r`. tlock
//! uses the chain's public key as an identity-based-encryption master key and
//! `r` as the identity, so the beacon signature for `r` is the decryption key
//! for everything time-locked to `r`. Before the League of Entropy publishes
//! round `r`, no single party holds that key.
//!
//! Beacons are public and need no authentication on the wire, because they
//! verify against the chain key ([`verify_beacon`]). A hostile relay can only
//! withhold beacons, which delays release. This crate verifies every signature
//! before use: tlock 0.0.10 panics, instead of returning an error, when asked to
//! decrypt with a wrong signature.

use ark_bls12_381::{g1, g2, Bls12_381, G1Affine, G2Affine};
use ark_ec::hashing::curve_maps::wb::WBMap;
use ark_ec::hashing::map_to_curve_hasher::MapToCurveBasedHasher;
use ark_ec::hashing::HashToCurve;
use ark_ec::pairing::Pairing;
use ark_ec::short_weierstrass::Projective;
use ark_ec::AffineRepr;
use ark_ff::field_hashers::DefaultFieldHasher;
use ark_serialize::CanonicalDeserialize;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{Result, SealError};

/// Parameters of a drand chain that a package can be time-locked to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrandChain {
    /// Chain hash: the SHA-256 of the chain info, also its HTTP API path.
    pub hash: [u8; 32],
    /// Compressed BLS12-381 group public key. For quicknet it is a 96-byte G2
    /// point, and beacon signatures are 48-byte G1 points.
    pub public_key: Vec<u8>,
    /// UNIX time, in seconds, of round 1.
    pub genesis_time: u64,
    /// Seconds between rounds.
    pub period: u64,
}

/// Chain hash of drand quicknet (`bls-unchained-g1-rfc9380`, 3 s rounds).
pub const QUICKNET_HASH: [u8; 32] =
    hex_array("52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971");

/// Group public key of drand quicknet, from
/// `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info`.
/// The tests check it against [`QUICKNET_HASH`].
pub const QUICKNET_PUBLIC_KEY: [u8; 96] = hex_array(
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c\
     8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb\
     5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
);

/// UNIX time of quicknet round 1.
pub const QUICKNET_GENESIS_TIME: u64 = 1_692_803_367;

/// Quicknet round period, in seconds.
pub const QUICKNET_PERIOD: u64 = 3;

/// Public drand HTTP relay run by the League of Entropy.
pub const DEFAULT_RELAY: &str = "https://api.drand.sh";

impl DrandChain {
    /// The drand quicknet mainnet chain.
    pub fn quicknet() -> Self {
        Self {
            hash: QUICKNET_HASH,
            public_key: QUICKNET_PUBLIC_KEY.to_vec(),
            genesis_time: QUICKNET_GENESIS_TIME,
            period: QUICKNET_PERIOD,
        }
    }
}

/// The latest round already due at `unix_secs`. This is drand's `CurrentRound`:
/// round 1 is due at genesis, and round `r` at `genesis + (r - 1) * period`.
///
/// Returns 0 before genesis, when no round exists yet. drand's Go client clamps
/// this case to 1 and the JS client throws. Also returns 0 if `period` is 0.
pub fn round_at(chain: &DrandChain, unix_secs: u64) -> u64 {
    match unix_secs.checked_sub(chain.genesis_time) {
        Some(since_genesis) => since_genesis
            .checked_div(chain.period)
            .map_or(0, |periods| periods.saturating_add(1)),
        None => 0,
    }
}

/// The UNIX time at which `round` is due. This is drand's `TimeOfRound`: round 0
/// maps to genesis. The result saturates at `u64::MAX` for absurd rounds.
pub fn time_of(chain: &DrandChain, round: u64) -> u64 {
    let periods = round.saturating_sub(1);
    chain
        .genesis_time
        .saturating_add(periods.saturating_mul(chain.period))
}

/// The first round due at or after `unix_secs`, which is the round to seal an
/// installment to so that it cannot open before `unix_secs`. Always at least 1.
/// A `period` of 0 yields 1.
pub fn first_round_at_or_after(chain: &DrandChain, unix_secs: u64) -> u64 {
    match unix_secs.checked_sub(chain.genesis_time) {
        Some(since_genesis) if since_genesis > 0 => since_genesis
            .checked_next_multiple_of(chain.period)
            .and_then(|t| t.checked_div(chain.period))
            .map_or(1, |periods| periods.saturating_add(1)),
        _ => 1,
    }
}

/// Hash-to-curve domain tags. These match tlock built with `rfc9380`, which
/// quicknet (`bls-unchained-g1-rfc9380`) requires.
const G1_DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const G2_DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_";
const G1_LEN: usize = 48;
const G2_LEN: usize = 96;

/// Whether `signature` is the drand beacon for `round` on `chain`: a BLS
/// signature under the chain key on `SHA-256(round as u64 big-endian)`. That is
/// the unchained-scheme message tlock encrypts to.
///
/// Supports both unchained layouts tlock does: public key on G2 with signature
/// on G1 (quicknet), and public key on G1 with signature on G2. Malformed input
/// gives `false`.
pub fn verify_beacon(chain: &DrandChain, round: u64, signature: &[u8]) -> bool {
    let message = Sha256::digest(round.to_be_bytes());
    let verified = match (chain.public_key.len(), signature.len()) {
        (G2_LEN, G1_LEN) => (|| {
            let public_key = G2Affine::deserialize_compressed(chain.public_key.as_slice()).ok()?;
            let signature = G1Affine::deserialize_compressed(signature).ok()?;
            let hashed = MapToCurveBasedHasher::<
                Projective<g1::Config>,
                DefaultFieldHasher<Sha256, 128>,
                WBMap<g1::Config>,
            >::new(G1_DST)
            .ok()?
            .hash(&message)
            .ok()?;
            Some(
                Bls12_381::pairing(signature, G2Affine::generator())
                    == Bls12_381::pairing(hashed, public_key),
            )
        })(),
        (G1_LEN, G2_LEN) => (|| {
            let public_key = G1Affine::deserialize_compressed(chain.public_key.as_slice()).ok()?;
            let signature = G2Affine::deserialize_compressed(signature).ok()?;
            let hashed = MapToCurveBasedHasher::<
                Projective<g2::Config>,
                DefaultFieldHasher<Sha256, 128>,
                WBMap<g2::Config>,
            >::new(G2_DST)
            .ok()?
            .hash(&message)
            .ok()?;
            Some(
                Bls12_381::pairing(G1Affine::generator(), signature)
                    == Bls12_381::pairing(public_key, hashed),
            )
        })(),
        _ => None,
    };
    verified.unwrap_or(false)
}

/// The relay URL serving the beacon for `round`: `{base_url}/{chain_hash}/public/{round}`.
pub fn beacon_url(base_url: &str, chain: &DrandChain, round: u64) -> String {
    format!(
        "{}/{}/public/{}",
        base_url.trim_end_matches('/'),
        hex::encode(chain.hash),
        round
    )
}

#[derive(Deserialize)]
struct BeaconJson {
    round: u64,
    signature: String,
}

/// Extracts and verifies the beacon signature from a drand HTTP API response.
///
/// The body is `{"round": .., "randomness": .., "signature": "<hex>"}`. The
/// response must be for `round`, and the signature must pass
/// [`verify_beacon`] for `chain`.
///
/// This is the parsing half of `fetch_signature`, for callers that bring
/// their own HTTP client (async runtimes, browsers, Tor).
pub fn parse_beacon_json(body: &[u8], chain: &DrandChain, round: u64) -> Result<Vec<u8>> {
    let beacon: BeaconJson = serde_json::from_slice(body)
        .map_err(|e| SealError::BeaconResponse(format!("invalid JSON: {e}")))?;
    if beacon.round != round {
        return Err(SealError::BeaconRoundMismatch {
            requested: round,
            got: beacon.round,
        });
    }
    let signature = hex::decode(&beacon.signature)
        .map_err(|e| SealError::BeaconResponse(format!("signature is not hex: {e}")))?;
    if !verify_beacon(chain, round, &signature) {
        return Err(SealError::InvalidBeacon { round });
    }
    Ok(signature)
}

/// Upper bound on a beacon response body. A real one is about 250 bytes.
#[cfg(feature = "fetch")]
const MAX_BEACON_RESPONSE: u64 = 16 * 1024;

/// Fetches the beacon signature for `round` from a drand HTTP relay, such as
/// [`DEFAULT_RELAY`]. This is a blocking call with a 10 s timeout. From async
/// code, run it on a blocking thread, or use [`beacon_url`] and
/// [`parse_beacon_json`] with your own client.
///
/// The relay learns which rounds you ask for, and so when packages open.
///
/// Requires the `fetch` feature, which is not available on wasm32.
#[cfg(feature = "fetch")]
pub fn fetch_signature(base_url: &str, chain: &DrandChain, round: u64) -> Result<Vec<u8>> {
    use std::time::Duration;

    let url = beacon_url(base_url, chain, round);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    let mut response = agent.get(&url).call().map_err(|e| match e {
        ureq::Error::StatusCode(status) => SealError::BeaconHttpStatus(status),
        other => SealError::BeaconFetch(other.to_string()),
    })?;
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BEACON_RESPONSE)
        .read_to_vec()
        .map_err(|e| SealError::BeaconFetch(e.to_string()))?;
    parse_beacon_json(&body, chain, round)
}

/// Decodes a hex string into a fixed-size array at compile time. Invalid input
/// is a compile error, because this is only used to initialise constants.
const fn hex_array<const N: usize>(hex: &str) -> [u8; N] {
    const fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("invalid hex digit"),
        }
    }
    let bytes = hex.as_bytes();
    assert!(bytes.len() == 2 * N, "hex length does not match array size");
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = (nibble(bytes[2 * i]) << 4) | nibble(bytes[2 * i + 1]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(genesis_time: u64, period: u64) -> DrandChain {
        DrandChain {
            hash: [0; 32],
            public_key: vec![],
            genesis_time,
            period,
        }
    }

    #[test]
    fn hex_array_decodes() {
        const A: [u8; 3] = hex_array("00aBff");
        assert_eq!(A, [0x00, 0xab, 0xff]);
    }

    #[test]
    fn rounds_before_genesis_and_degenerate_period() {
        let c = chain(100, 3);
        assert_eq!(round_at(&c, 99), 0);
        assert_eq!(first_round_at_or_after(&c, 0), 1);
        assert_eq!(time_of(&c, 0), 100);
        let zero = chain(100, 0);
        assert_eq!(round_at(&zero, 1_000), 0);
        assert_eq!(first_round_at_or_after(&zero, 1_000), 1);
    }

    #[test]
    fn first_round_at_or_after_is_the_ceiling() {
        let c = chain(100, 3);
        // Rounds are due at 100 (r1), 103 (r2), 106 (r3), ...
        assert_eq!(first_round_at_or_after(&c, 100), 1);
        assert_eq!(first_round_at_or_after(&c, 101), 2);
        assert_eq!(first_round_at_or_after(&c, 103), 2);
        assert_eq!(first_round_at_or_after(&c, 104), 3);
        for t in 100..400 {
            let r = first_round_at_or_after(&c, t);
            assert!(time_of(&c, r) >= t);
            assert!(r == 1 || time_of(&c, r - 1) < t);
        }
    }

    #[test]
    fn time_of_saturates() {
        let c = DrandChain::quicknet();
        assert_eq!(time_of(&c, u64::MAX), u64::MAX);
    }

    /// Quicknet round 1000, as in tlock's own test vectors.
    const ROUND_1000_SIG: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

    #[test]
    fn verify_beacon_accepts_only_the_right_round() {
        let c = DrandChain::quicknet();
        let sig = hex::decode(ROUND_1000_SIG).expect("hex");
        assert!(verify_beacon(&c, 1000, &sig));
        assert!(!verify_beacon(&c, 1001, &sig));
        assert!(!verify_beacon(&c, 1000, &sig[..47]));
        assert!(!verify_beacon(&c, 1000, &[0u8; 48]));
        let mut flipped = sig.clone();
        flipped[47] ^= 1;
        assert!(!verify_beacon(&c, 1000, &flipped));
    }

    #[test]
    fn parse_beacon_json_checks_round_hex_and_signature() {
        let c = DrandChain::quicknet();
        let body = format!(r#"{{"round":1000,"randomness":"00","signature":"{ROUND_1000_SIG}"}}"#);
        assert_eq!(
            parse_beacon_json(body.as_bytes(), &c, 1000).ok(),
            hex::decode(ROUND_1000_SIG).ok()
        );
        assert!(matches!(
            parse_beacon_json(body.as_bytes(), &c, 1001),
            Err(SealError::BeaconRoundMismatch {
                requested: 1001,
                got: 1000
            })
        ));
        let forged = br#"{"round":1000,"signature":"abcd"}"#;
        assert!(matches!(
            parse_beacon_json(forged, &c, 1000),
            Err(SealError::InvalidBeacon { round: 1000 })
        ));
        let bad_hex = br#"{"round":1000,"signature":"zz"}"#;
        assert!(matches!(
            parse_beacon_json(bad_hex, &c, 1000),
            Err(SealError::BeaconResponse(_))
        ));
        assert!(matches!(
            parse_beacon_json(b"not json", &c, 1000),
            Err(SealError::BeaconResponse(_))
        ));
    }

    #[test]
    fn beacon_url_shape() {
        let c = DrandChain::quicknet();
        assert_eq!(
            beacon_url("https://api.drand.sh/", &c, 42),
            "https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/42"
        );
    }
}
