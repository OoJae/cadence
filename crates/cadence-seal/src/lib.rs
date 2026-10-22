//! Sealing Cadence installment packages.
//!
//! A payer pre-signs a schedule of installments. Each installment's package (a
//! JSON ladder of signed PCZTs) is uploaded to the merchant's runner long
//! before it is due. [`seal`] wraps the package so that:
//!
//! 1. **Only the runner can ever read it.** The inner layer is age X25519
//!    encryption to the runner's recipient.
//! 2. **Nobody can read it before its drand round, not even the runner.** The
//!    outer layer is tlock time-lock encryption to a drand quicknet round.
//! 3. **Its size says nothing about the ladder.** The result is padded to a
//!    fixed bucket ([`BUCKETS`]), and the padding sits under both layers.
//!
//! The layering is `tlock(age_x25519(frame(zstd(plaintext))))`.
//!
//! # Trust model
//!
//! - **Confidentiality from third parties rests on age alone.** The inner layer
//!   is age, so a total break of tlock or drand (for example, a threshold of
//!   League of Entropy nodes colluding to sign rounds early) lets the *runner*
//!   open a package early. It never lets anyone else read it. Once a round
//!   passes, anyone holding the package can strip the time lock, but sees only
//!   an age ciphertext of fixed size.
//! - **Not-before against the runner rests on tlock and drand.** Opening needs
//!   the BLS threshold signature on round `r`, which does not exist until the
//!   drand network publishes it. This assumes fewer than a threshold of drand
//!   nodes collude and that BLS12-381 pairings stay secure.
//! - **Integrity, not authenticity.** Both layers are authenticated encryption
//!   (age's header MAC and ChaCha20-Poly1305 STREAM), so a modified package
//!   fails to open. But age is anonymous public-key encryption: anyone who knows
//!   the runner's recipient can seal a package to it. A successful [`open`]
//!   proves nothing about who sealed it. The runner must check the PCZT
//!   signatures inside.
//! - **Metadata in the clear.** The outer header names the drand chain and
//!   round, so whoever stores or relays a package learns when it opens. That is
//!   needed so the runner knows when to fetch the beacon ([`header_round`]).
//!   The runner's recipient is not revealed. The size reveals only the bucket.
//! - **Liveness rests on drand.** If drand stops, packages stay locked. That
//!   fails safe: the payer can always cancel by spending the note.
//! - **Compression before encryption** is safe here. There is no oracle that
//!   mixes attacker-chosen bytes with secrets, and bucket padding hides the
//!   compressed length.
//! - **Beacons are verified.** [`open`] and `fetch_signature` check the BLS
//!   signature against the chain key before use ([`verify_beacon`]), so a
//!   lying relay produces a clean error.
//!
//! # tlock 0.0.10 caveats
//!
//! - Its decryption *panics* (`assert_eq!` in `ibe::decrypt`), rather than
//!   returning an error, when the signature is wrong or the stanza is
//!   inconsistent. Verifying the beacon first removes the first case. The
//!   second needs a crafted package, which anyone can make, so [`open`] runs the
//!   time-lock layer under `catch_unwind`. That needs `panic = "unwind"`.
//! - Its age recipient discards tlock errors and would emit an unopenable
//!   stanza for a bad public key. [`seal`] runs a tlock encryption up front to
//!   reject such keys.
//!
//! # Features
//!
//! - `fetch` (default): blocking `fetch_signature` over HTTPS with ureq and
//!   rustls (ring, no OpenSSL). Unavailable on wasm32. Use [`beacon_url`] and
//!   [`parse_beacon_json`] with the host's HTTP client instead.
//! - `zstd-native` (default): compress with the C zstd at level 10. Without it,
//!   the pure-Rust ruzstd encoder is used at its fastest level, roughly zstd
//!   level 1. Decompression always uses ruzstd. A wasm32 payer builds with
//!   `default-features = false`.

mod drand;
mod seal;

#[cfg(feature = "fetch")]
pub use drand::fetch_signature;
pub use drand::{
    beacon_url, first_round_at_or_after, parse_beacon_json, round_at, time_of, verify_beacon,
    DrandChain, DEFAULT_RELAY, QUICKNET_GENESIS_TIME, QUICKNET_HASH, QUICKNET_PERIOD,
    QUICKNET_PUBLIC_KEY,
};
pub use seal::{header_round, open, read_header, seal, SealHeader, BUCKETS, MAX_PLAINTEXT_LEN};

/// Re-exported so callers use the same `age` version as `tlock_age`.
pub use age;

/// Errors from sealing, opening, and beacon retrieval.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum SealError {
    /// The plaintext exceeds [`MAX_PLAINTEXT_LEN`].
    #[error("plaintext is {len} bytes, above the {max}-byte limit")]
    PlaintextTooLarge { len: usize, max: usize },
    /// The compressed package does not fit the largest bucket.
    #[error("compressed package is {compressed_len} bytes and does not fit the largest bucket ({max_bucket} bytes)")]
    TooLargeForBuckets {
        compressed_len: usize,
        max_bucket: usize,
    },
    /// Round 0 has no beacon, so a package sealed to it could never open.
    #[error("cannot seal to round 0; drand rounds start at 1")]
    InvalidRound,
    /// The chain's public key is not a point tlock can encrypt to.
    #[error("drand chain public key is not a valid BLS12-381 point for tlock")]
    InvalidChainKey,
    /// zstd compression failed.
    #[error("compression failed: {0}")]
    Compress(#[source] std::io::Error),
    /// The decrypted frame does not hold a single valid zstd frame.
    #[error("decompression failed: {0}")]
    Decompress(String),
    /// The package would decompress past [`MAX_PLAINTEXT_LEN`].
    #[error("package decompresses past the {max}-byte limit")]
    DecompressedTooLarge { max: usize },
    /// age refused to build an encryptor.
    #[error("age encryption failed: {0}")]
    Encrypt(#[from] age::EncryptError),
    /// The package is time-locked to a different drand chain.
    #[error("package is time-locked to drand chain {found}, expected {expected}")]
    ChainMismatch { expected: String, found: String },
    /// The outer tlock header is missing or malformed.
    #[error("cannot read the time-lock header: {0}")]
    Header(String),
    /// The signature is not the chain's beacon for `round`. It is for another
    /// round, or it is forged or corrupt.
    #[error("signature is not the drand beacon for round {round} on this chain")]
    InvalidBeacon { round: u64 },
    /// The beacon was valid, but the time-lock layer failed to decrypt. The
    /// package is corrupt.
    #[error("time-lock layer failed to decrypt: {0}")]
    TimeLock(#[source] tlock_age::TLockAgeError),
    /// The time-lock stanza fails tlock's consistency check, so the package
    /// is crafted or corrupt. tlock panics here, and `open` contains the panic.
    #[error("time-lock stanza is malformed (crafted or corrupt package)")]
    MalformedTimeLock,
    /// The time lock opened, but the package is not addressed to this runner.
    #[error("package is not addressed to this runner identity")]
    WrongIdentity,
    /// The runner layer is malformed or fails authentication.
    #[error("runner layer failed to decrypt: {0}")]
    RunnerLayer(String),
    /// The decrypted frame is malformed.
    #[error("malformed package frame: {0}")]
    Frame(&'static str),
    /// The sealed output missed its bucket. This is a bug, and nothing
    /// half-padded is returned.
    #[error("sealed length {actual} is not the planned bucket {expected}")]
    SizeInvariant { expected: usize, actual: usize },
    /// An I/O error while writing the age layers in memory.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    /// The beacon response is not the expected JSON.
    #[error("bad beacon response: {0}")]
    BeaconResponse(String),
    /// The relay answered with a beacon for another round.
    #[error("relay returned round {got}, requested {requested}")]
    BeaconRoundMismatch { requested: u64, got: u64 },
    /// The relay answered with an HTTP error, for example when the round is
    /// not yet published.
    #[error("drand relay returned HTTP {0}")]
    BeaconHttpStatus(u16),
    /// The relay could not be reached.
    #[error("beacon fetch failed: {0}")]
    BeaconFetch(String),
}

/// Result type for this crate.
pub type Result<T, E = SealError> = std::result::Result<T, E>;
