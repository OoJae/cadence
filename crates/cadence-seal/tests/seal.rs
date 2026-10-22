//! End-to-end tests against real drand quicknet beacons.

use cadence_seal::age::x25519;
use cadence_seal::{
    header_round, open, read_header, round_at, seal, time_of, DrandChain, SealError, BUCKETS,
    QUICKNET_GENESIS_TIME, QUICKNET_HASH, QUICKNET_PERIOD, QUICKNET_PUBLIC_KEY,
};
use sha2::{Digest, Sha256};

/// Quicknet round 33,000,000, fetched once from
/// `https://api.drand.sh/52db9b…e971/public/33000000` (drand.cloudflare.com agrees).
const ROUND: u64 = 33_000_000;
const ROUND_SIG: &str = "a6d9f863b58d8f1ea7b6fd426feef2b43b22c912b89dce0bdd787ed2b04c703954aced716aba98ff2b4a22a83e48dd35";
/// Quicknet round 33,000,001.
const NEXT_ROUND_SIG: &str = "8ffc9472ebeeb28437e15081ca6543e5edd9ac7ddd89089d9ef7bf6853db81b53271d26aaa48c9ab350f7ed31a450314";

/// Quicknet `groupHash` and `beaconID` from `/info`. With the constants we
/// hard-code, they determine the chain hash.
const QUICKNET_GROUP_HASH: &str =
    "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e";
const QUICKNET_BEACON_ID: &str = "quicknet";

fn sig(hex_sig: &str) -> Vec<u8> {
    hex::decode(hex_sig).expect("test vector is hex")
}

fn runner() -> x25519::Identity {
    x25519::Identity::generate()
}

/// A stand-in for a ladder: JSON-ish and partly incompressible, like PCZTs.
fn package(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    while out.len() < len {
        out.extend_from_slice(br#"{"rung":"#);
        for _ in 0..24 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            out.push(b"0123456789abcdef"[(x & 15) as usize]);
        }
        out.extend_from_slice(b"\"},");
    }
    out.truncate(len);
    out
}

/// drand's chain hash is SHA-256 over period (u32 BE), genesis (i64 BE), the
/// public key, the group hash, and the beacon ID if it is not "default".
#[test]
fn quicknet_public_key_matches_chain_hash() {
    let mut h = Sha256::new();
    h.update((QUICKNET_PERIOD as u32).to_be_bytes());
    h.update((QUICKNET_GENESIS_TIME as i64).to_be_bytes());
    h.update(QUICKNET_PUBLIC_KEY);
    h.update(hex::decode(QUICKNET_GROUP_HASH).expect("hex"));
    h.update(QUICKNET_BEACON_ID.as_bytes());
    assert_eq!(h.finalize().as_slice(), QUICKNET_HASH);

    let chain = DrandChain::quicknet();
    assert_eq!(chain.hash, QUICKNET_HASH);
    assert_eq!(chain.public_key, QUICKNET_PUBLIC_KEY);
    assert_eq!(chain.genesis_time, 1_692_803_367);
    assert_eq!(chain.period, 3);
}

#[test]
fn round_trip_with_real_beacon() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let plaintext = package(1_500_000);

    let sealed = seal(&plaintext, &id.to_public(), &chain, ROUND).expect("seal");
    assert!(BUCKETS.contains(&sealed.len()));
    let opened = open(&sealed, &id, &chain, &sig(ROUND_SIG)).expect("open");
    assert_eq!(opened, plaintext);
}

#[test]
fn round_trip_empty_plaintext() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let sealed = seal(b"", &id.to_public(), &chain, ROUND).expect("seal");
    assert_eq!(sealed.len(), BUCKETS[0]);
    assert_eq!(
        open(&sealed, &id, &chain, &sig(ROUND_SIG)).expect("open"),
        b""
    );
}

#[test]
fn wrong_round_signature_fails() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let sealed = seal(b"installment 1", &id.to_public(), &chain, ROUND).expect("seal");

    let err = open(&sealed, &id, &chain, &sig(NEXT_ROUND_SIG)).expect_err("must not open");
    assert!(
        matches!(err, SealError::InvalidBeacon { round: ROUND }),
        "{err}"
    );
    for junk in [&[0u8; 48][..], &[0u8; 96][..], &[][..]] {
        let err = open(&sealed, &id, &chain, junk).expect_err("must not open");
        assert!(matches!(err, SealError::InvalidBeacon { .. }), "{err}");
    }
}

/// A crafted tlock stanza makes tlock 0.0.10 panic even with the right beacon.
/// `open` must turn that into an error.
#[test]
fn crafted_time_lock_stanza_is_an_error_not_a_panic() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let sealed = seal(b"installment 1", &id.to_public(), &chain, ROUND).expect("seal");

    // The stanza body (U ‖ V ‖ W = 96 + 16 + 16 bytes) is 171 base64 chars on
    // lines of 64, 64 and 43. The third line starts inside V.
    let tag = b"-> tlock ";
    let start = sealed
        .windows(tag.len())
        .position(|w| w == tag)
        .expect("tlock stanza");
    let line_end = start
        + sealed[start..]
            .iter()
            .position(|&b| b == b'\n')
            .expect("eol");
    let third_line = line_end + 1 + 65 + 65;

    let mut crafted = sealed.clone();
    crafted[third_line] = if crafted[third_line] == b'A' {
        b'B'
    } else {
        b'A'
    };
    let err = open(&crafted, &id, &chain, &sig(ROUND_SIG)).expect_err("must not open");
    assert!(matches!(err, SealError::MalformedTimeLock), "{err}");

    // Corrupting U usually yields an invalid point, which tlock does report.
    let mut crafted = sealed.clone();
    let first_line = line_end + 1;
    crafted[first_line + 5] = if crafted[first_line + 5] == b'A' {
        b'B'
    } else {
        b'A'
    };
    assert!(open(&crafted, &id, &chain, &sig(ROUND_SIG)).is_err());
}

#[test]
fn wrong_identity_fails() {
    let chain = DrandChain::quicknet();
    let sealed = seal(b"installment 1", &runner().to_public(), &chain, ROUND).expect("seal");

    let other = x25519::Identity::generate();
    let err = open(&sealed, &other, &chain, &sig(ROUND_SIG)).expect_err("must not open");
    assert!(matches!(err, SealError::WrongIdentity), "{err}");
}

#[test]
fn wrong_chain_fails_before_decrypting() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let sealed = seal(b"installment 1", &id.to_public(), &chain, ROUND).expect("seal");

    let mut other = chain.clone();
    other.hash[0] ^= 1;
    let err = open(&sealed, &id, &other, &sig(ROUND_SIG)).expect_err("must not open");
    assert!(matches!(err, SealError::ChainMismatch { .. }), "{err}");
}

#[test]
fn tampering_is_detected() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let mut sealed = seal(b"installment 1", &id.to_public(), &chain, ROUND).expect("seal");
    let mid = sealed.len() / 2;
    sealed[mid] ^= 1;
    assert!(open(&sealed, &id, &chain, &sig(ROUND_SIG)).is_err());
}

#[test]
fn header_round_reads_the_round() {
    let chain = DrandChain::quicknet();
    let sealed = seal(b"x", &runner().to_public(), &chain, ROUND).expect("seal");
    assert_eq!(header_round(&sealed).expect("header"), ROUND);
    let header = read_header(&sealed).expect("header");
    assert_eq!(header.round, ROUND);
    assert_eq!(header.chain_hash, QUICKNET_HASH);

    let far = seal(b"x", &runner().to_public(), &chain, u64::MAX).expect("seal");
    assert_eq!(header_round(&far).expect("header"), u64::MAX);

    assert!(matches!(
        header_round(b"garbage"),
        Err(SealError::Header(_))
    ));
}

#[test]
fn sealed_size_is_a_bucket_and_hides_length() {
    let chain = DrandChain::quicknet();
    let id = runner();
    let recipient = id.to_public();

    // Different lengths in the same bucket seal to the same length, every time,
    // despite age's random-length header grease.
    let small = seal(&package(1_000), &recipient, &chain, ROUND).expect("seal");
    let larger = seal(&package(40_000), &recipient, &chain, ROUND + 7).expect("seal");
    assert_eq!(small.len(), BUCKETS[0]);
    assert_eq!(larger.len(), BUCKETS[0]);
    for _ in 0..8 {
        let again = seal(&package(1_000), &recipient, &chain, ROUND).expect("seal");
        assert_eq!(again.len(), BUCKETS[0]);
    }

    // Incompressible data that overflows 64 KiB moves to the next bucket.
    let mut noise = vec![0u8; 70_000];
    let mut x: u32 = 1;
    for b in noise.iter_mut() {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *b = (x >> 24) as u8;
    }
    let big = seal(&noise, &recipient, &chain, ROUND).expect("seal");
    assert_eq!(big.len(), BUCKETS[1]);
    let opened = open(&big, &id, &chain, &sig(ROUND_SIG)).expect("open");
    assert_eq!(opened, noise);
}

#[test]
fn round_at_and_time_of_are_consistent() {
    let chain = DrandChain::quicknet();
    assert_eq!(round_at(&chain, QUICKNET_GENESIS_TIME), 1);
    assert_eq!(time_of(&chain, 1), QUICKNET_GENESIS_TIME);
    assert_eq!(round_at(&chain, QUICKNET_GENESIS_TIME - 1), 0);
    // Round 33,000,000 was due at genesis + 32,999,999 × 3 s.
    assert_eq!(time_of(&chain, ROUND), 1_791_803_364);

    for r in [1, 2, 3, 1_000, ROUND, ROUND + 1] {
        let t = time_of(&chain, r);
        assert_eq!(round_at(&chain, t), r);
        assert_eq!(round_at(&chain, t + QUICKNET_PERIOD - 1), r);
        assert_eq!(round_at(&chain, t + QUICKNET_PERIOD), r + 1);
        assert_eq!(cadence_seal::first_round_at_or_after(&chain, t), r);
        assert_eq!(cadence_seal::first_round_at_or_after(&chain, t + 1), r + 1);
    }
    for t in QUICKNET_GENESIS_TIME..QUICKNET_GENESIS_TIME + 100 {
        let r = round_at(&chain, t);
        assert!(time_of(&chain, r) <= t && t < time_of(&chain, r + 1));
    }
}

#[cfg(feature = "fetch")]
fn get_json(path: &str) -> serde_json::Value {
    let url = format!(
        "{}/{}{path}",
        cadence_seal::DEFAULT_RELAY,
        hex::encode(QUICKNET_HASH)
    );
    let body = ureq::get(&url)
        .call()
        .expect("request")
        .body_mut()
        .read_to_string()
        .expect("body");
    serde_json::from_str(&body).expect("json")
}

/// Fetches the current round's beacon, then seals to it and opens with it.
#[cfg(feature = "fetch")]
#[test]
#[ignore = "network: queries api.drand.sh"]
fn fetch_current_round_signature() {
    use std::time::{SystemTime, UNIX_EPOCH};

    let chain = DrandChain::quicknet();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after 1970")
        .as_secs();
    // One round back, so the beacon is surely published.
    let round = round_at(&chain, now) - 1;
    let signature =
        cadence_seal::fetch_signature(cadence_seal::DEFAULT_RELAY, &chain, round).expect("fetch");
    assert_eq!(signature.len(), 48);

    let id = runner();
    let sealed = seal(b"live", &id.to_public(), &chain, round).expect("seal");
    assert_eq!(
        open(&sealed, &id, &chain, &signature).expect("open"),
        b"live"
    );

    // The relay's latest round agrees with our clock arithmetic.
    let latest = get_json("/public/latest")["round"].as_u64().expect("round");
    assert!(
        latest.abs_diff(round_at(&chain, now)) <= 2,
        "latest {latest}"
    );

    // A round far in the future is not served.
    let future =
        cadence_seal::fetch_signature(cadence_seal::DEFAULT_RELAY, &chain, round + 1_000_000);
    assert!(future.is_err());
}

/// The live `/info` matches the hard-coded quicknet constants.
#[cfg(feature = "fetch")]
#[test]
#[ignore = "network: queries api.drand.sh"]
fn live_chain_info_matches_quicknet() {
    let info = get_json("/info");
    assert_eq!(info["hash"], hex::encode(QUICKNET_HASH));
    assert_eq!(info["public_key"], hex::encode(QUICKNET_PUBLIC_KEY));
    assert_eq!(info["genesis_time"], QUICKNET_GENESIS_TIME);
    assert_eq!(info["period"], QUICKNET_PERIOD);
    assert_eq!(info["groupHash"], QUICKNET_GROUP_HASH);
    assert_eq!(info["metadata"]["beaconID"], QUICKNET_BEACON_ID);
    assert_eq!(info["schemeID"], "bls-unchained-g1-rfc9380");
}
