//! The seal format: `tlock_age(age_x25519(frame(zstd(plaintext))))`, sized to a bucket.
//!
//! ```text
//! sealed  = age file, tlock stanza (round, chain hash)           <- outer, tlock
//!             payload: age file, X25519 stanza (runner)          <- inner, runner
//!               payload: frame
//! frame   = "CDS1" || u64_le(len) || zstd[len] || 0x00 * pad
//! ```
//!
//! Each age layer writes a header whose length varies at random: age appends a
//! "grease" stanza of random size. So `seal` starts both encryptions first,
//! measures both headers, and then picks the zero padding inside the frame so
//! that the outer file lands exactly on a bucket boundary. The padding sits
//! under both layers. It is covered by the runner layer's AEAD, and `open`
//! rejects nonzero padding, so the frame has one valid encoding.

use std::cell::Cell;
use std::io::{self, Read, Write};
use std::iter;

use age::x25519;

use crate::drand::{verify_beacon, DrandChain};
use crate::{Result, SealError};

/// Sealed packages are exactly one of these sizes, in bytes: 64 KiB × 2^n,
/// from 64 KiB to 32 MiB. The size reveals only the bucket, not the length of
/// the ladder inside.
pub const BUCKETS: [usize; 10] = {
    let mut buckets = [0usize; 10];
    let mut i = 0;
    while i < buckets.len() {
        buckets[i] = (64 * 1024) << i;
        i += 1;
    }
    buckets
};

/// The largest bucket.
const MAX_BUCKET: usize = BUCKETS[BUCKETS.len() - 1];

/// Largest plaintext `seal` accepts, and largest `open` will decompress.
/// This bounds memory on the runner when a payer sends a decompression bomb.
pub const MAX_PLAINTEXT_LEN: usize = 64 * 1024 * 1024;

/// zstd level used with the `zstd-native` feature.
#[cfg(feature = "zstd-native")]
const ZSTD_LEVEL: i32 = 10;

/// Magic and format version at the start of the frame.
const FRAME_MAGIC: [u8; 4] = *b"CDS1";
/// Magic plus the u64 compressed length.
const FRAME_HEADER_LEN: usize = FRAME_MAGIC.len() + 8;

/// age STREAM: plaintext is split into 64 KiB chunks, each with a 16-byte tag.
const AGE_CHUNK_LEN: usize = 64 * 1024;
const AGE_TAG_LEN: usize = 16;

/// Seals `plaintext` so that only `runner` can read it, and only once `chain`
/// has published `round`.
///
/// Steps: compress with zstd, frame and pad, encrypt with age to `runner`
/// (binary, not armored), then time-lock with tlock to `round`. The result is
/// exactly one of [`BUCKETS`] long.
///
/// The round and chain hash sit in the clear in the outer header (see
/// [`header_round`]), so whoever stores the package learns when it opens.
/// The package carries no sender authentication: anyone who knows the runner's
/// recipient can seal to it. The runner must validate the contents itself.
pub fn seal(
    plaintext: &[u8],
    runner: &x25519::Recipient,
    chain: &DrandChain,
    round: u64,
) -> Result<Vec<u8>> {
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(SealError::PlaintextTooLarge {
            len: plaintext.len(),
            max: MAX_PLAINTEXT_LEN,
        });
    }
    if round == 0 {
        // drand never signs round 0, so nothing could ever open the package.
        return Err(SealError::InvalidRound);
    }
    check_chain_key(chain, round)?;
    let compressed = compress(plaintext)?;
    let body_len = FRAME_HEADER_LEN + compressed.len();

    // Start both encryptions. `wrap_output` writes each header and nonce
    // immediately, so their random lengths are known before any payload is
    // written. The final length check below enforces this.
    let tlock_recipient =
        tlock_age::internal::Recipient::new(&chain.hash, &chain.public_key, round);
    let outer_len = Cell::new(0);
    let mut outer =
        age::Encryptor::with_recipients(iter::once(&tlock_recipient as &dyn age::Recipient))?
            .wrap_output(TrackedVec::new(&outer_len))?;
    let outer_prefix = outer_len.get();

    let inner_len = Cell::new(0);
    let mut inner = age::Encryptor::with_recipients(iter::once(runner as &dyn age::Recipient))?
        .wrap_output(TrackedVec::new(&inner_len))?;
    let inner_prefix = inner_len.get();

    let (bucket, padding) =
        plan(body_len, outer_prefix, inner_prefix).ok_or(SealError::TooLargeForBuckets {
            compressed_len: compressed.len(),
            max_bucket: MAX_BUCKET,
        })?;

    inner.write_all(&FRAME_MAGIC)?;
    inner.write_all(&(compressed.len() as u64).to_le_bytes())?;
    inner.write_all(&compressed)?;
    io::copy(&mut io::repeat(0).take(padding as u64), &mut inner)?;
    let inner_ct = inner.finish()?.buf;

    outer.write_all(&inner_ct)?;
    let sealed = outer.finish()?.buf;

    if sealed.len() != bucket {
        return Err(SealError::SizeInvariant {
            expected: bucket,
            actual: sealed.len(),
        });
    }
    Ok(sealed)
}

/// Opens a package made by [`seal`]. Needs the runner's identity and the
/// beacon signature for the package's round (see [`header_round`] and
/// `fetch_signature`).
///
/// Errors tell the layers apart. [`SealError::InvalidBeacon`] means the
/// signature is not the beacon for the package's round: it is too early, or the
/// beacon is for another round. [`SealError::TimeLock`] and
/// [`SealError::MalformedTimeLock`] mean the time-lock layer is corrupt.
/// [`SealError::WrongIdentity`] means the package is not addressed to `runner`.
///
/// tlock 0.0.10 panics on a time-lock stanza that fails its consistency check,
/// and anyone can craft one, since anyone can seal to the runner. `open` catches
/// that panic and returns [`SealError::MalformedTimeLock`]. This relies on
/// `panic = "unwind"`, the default. With `panic = "abort"`, a crafted package
/// aborts the process.
pub fn open(
    sealed: &[u8],
    runner: &x25519::Identity,
    chain: &DrandChain,
    beacon_signature: &[u8],
) -> Result<Vec<u8>> {
    let header = read_header(sealed)?;
    if header.chain_hash != chain.hash {
        return Err(SealError::ChainMismatch {
            expected: hex::encode(chain.hash),
            found: hex::encode(header.chain_hash),
        });
    }
    // Check the signature first. tlock would panic on a wrong one.
    if !verify_beacon(chain, header.round, beacon_signature) {
        return Err(SealError::InvalidBeacon {
            round: header.round,
        });
    }

    let inner_ct = std::panic::catch_unwind(|| {
        let mut inner_ct = Vec::with_capacity(sealed.len());
        tlock_age::decrypt(&mut inner_ct, sealed, &chain.hash, beacon_signature).map(|()| inner_ct)
    })
    .map_err(|_| SealError::MalformedTimeLock)?
    .map_err(SealError::TimeLock)?;

    let decryptor = age::Decryptor::new_buffered(inner_ct.as_slice())
        .map_err(|e| SealError::RunnerLayer(e.to_string()))?;
    let mut reader = decryptor
        .decrypt(iter::once(runner as &dyn age::Identity))
        .map_err(|e| match e {
            age::DecryptError::NoMatchingKeys => SealError::WrongIdentity,
            other => SealError::RunnerLayer(other.to_string()),
        })?;
    let mut frame = Vec::with_capacity(inner_ct.len());
    reader
        .read_to_end(&mut frame)
        .map_err(|e| SealError::RunnerLayer(e.to_string()))?;

    decompress(parse_frame(&frame)?)
}

/// What the outer header says, readable without any key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SealHeader {
    /// drand round whose beacon opens the time lock.
    pub round: u64,
    /// Hash of the drand chain the package is time-locked to.
    pub chain_hash: [u8; 32],
}

/// The drand round a sealed package is time-locked to. The runner should wait
/// until [`crate::time_of`] that round, then fetch its beacon and [`open`].
pub fn header_round(sealed: &[u8]) -> Result<u64> {
    Ok(read_header(sealed)?.round)
}

/// The round and chain hash from a sealed package's outer header.
pub fn read_header(sealed: &[u8]) -> Result<SealHeader> {
    let header = tlock_age::decrypt_header(sealed).map_err(|e| SealError::Header(e.to_string()))?;
    let chain_hash = header
        .hash()
        .try_into()
        .map_err(|_| SealError::Header("chain hash is not 32 bytes".into()))?;
    Ok(SealHeader {
        round: header.round(),
        chain_hash,
    })
}

/// Rejects a chain key that tlock cannot use. `tlock_age`'s recipient drops
/// tlock errors and would emit a stanza that nothing can open, so this runs the
/// same tlock encryption once on a dummy key first.
fn check_chain_key(chain: &DrandChain, round: u64) -> Result<()> {
    tlock::encrypt(io::sink(), [0u8; 16].as_slice(), &chain.public_key, round)
        .map_err(|_| SealError::InvalidChainKey)
}

/// Picks the smallest bucket that fits a frame body of `body_len` bytes, given
/// the measured header-plus-nonce lengths of the two age layers. Returns the
/// bucket and the number of zero bytes to append to the frame body so that the
/// outer file exactly fills it.
fn plan(body_len: usize, outer_prefix: usize, inner_prefix: usize) -> Option<(usize, usize)> {
    BUCKETS.iter().find_map(|&bucket| {
        let inner_ct_len = stream_plaintext_len(bucket.checked_sub(outer_prefix)?)?;
        let frame_len = stream_plaintext_len(inner_ct_len.checked_sub(inner_prefix)?)?;
        Some((bucket, frame_len.checked_sub(body_len)?))
    })
}

/// Length of the age STREAM ciphertext for `n` plaintext bytes. The nonce is
/// not counted. The last chunk may be full; an empty payload is one empty chunk.
fn stream_ciphertext_len(n: usize) -> usize {
    let chunks = n.div_ceil(AGE_CHUNK_LEN).max(1);
    n + chunks * AGE_TAG_LEN
}

/// Inverse of [`stream_ciphertext_len`]: the plaintext length whose ciphertext
/// is exactly `ct_len` bytes. Returns `None` for the 16 lengths after each full
/// chunk, which no plaintext produces. A bucket never hits that gap unless the
/// headers are about 64 KiB long, and `plan` would then try the next bucket.
fn stream_plaintext_len(ct_len: usize) -> Option<usize> {
    let chunks = ct_len.div_ceil(AGE_CHUNK_LEN + AGE_TAG_LEN).max(1);
    let n = ct_len.checked_sub(chunks * AGE_TAG_LEN)?;
    (stream_ciphertext_len(n) == ct_len).then_some(n)
}

/// Returns the compressed body of a decrypted frame, after checking its
/// structure and that all padding is zero.
fn parse_frame(frame: &[u8]) -> Result<&[u8]> {
    let (magic, rest) = frame
        .split_first_chunk::<4>()
        .ok_or(SealError::Frame("truncated header"))?;
    if *magic != FRAME_MAGIC {
        return Err(SealError::Frame("bad magic or unsupported version"));
    }
    let (len, rest) = rest
        .split_first_chunk::<8>()
        .ok_or(SealError::Frame("truncated header"))?;
    let len = usize::try_from(u64::from_le_bytes(*len))
        .map_err(|_| SealError::Frame("length overflows usize"))?;
    if len > rest.len() {
        return Err(SealError::Frame("length exceeds frame"));
    }
    let (body, padding) = rest.split_at(len);
    if padding.iter().any(|&b| b != 0) {
        return Err(SealError::Frame("nonzero padding"));
    }
    Ok(body)
}

#[cfg(feature = "zstd-native")]
fn compress(plaintext: &[u8]) -> Result<Vec<u8>> {
    zstd::bulk::compress(plaintext, ZSTD_LEVEL).map_err(SealError::Compress)
}

/// Pure-Rust fallback. ruzstd only implements its fastest level, roughly
/// zstd level 1, so packages come out larger than with `zstd-native`.
#[cfg(not(feature = "zstd-native"))]
fn compress(plaintext: &[u8]) -> Result<Vec<u8>> {
    Ok(ruzstd::encoding::compress_to_vec(
        plaintext,
        ruzstd::encoding::CompressionLevel::Fastest,
    ))
}

/// Decompresses exactly one zstd frame, at most [`MAX_PLAINTEXT_LEN`] bytes,
/// with no trailing data. The pure-Rust decoder keeps C parsers away from
/// payer-supplied bytes on the runner.
fn decompress(compressed: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(compressed)
        .map_err(|e| SealError::Decompress(e.to_string()))?;
    let mut out = Vec::new();
    (&mut decoder)
        .take(MAX_PLAINTEXT_LEN as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| SealError::Decompress(e.to_string()))?;
    if out.len() > MAX_PLAINTEXT_LEN {
        return Err(SealError::DecompressedTooLarge {
            max: MAX_PLAINTEXT_LEN,
        });
    }
    if !decoder.get_ref().is_empty() {
        return Err(SealError::Decompress(
            "trailing data after zstd frame".into(),
        ));
    }
    Ok(out)
}

/// A `Vec` writer that reports its length through a shared cell, so the length
/// can be read while an age `StreamWriter` owns the writer.
struct TrackedVec<'a> {
    buf: Vec<u8>,
    len: &'a Cell<usize>,
}

impl<'a> TrackedVec<'a> {
    fn new(len: &'a Cell<usize>) -> Self {
        len.set(0);
        Self {
            buf: Vec::new(),
            len,
        }
    }
}

impl Write for TrackedVec<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        self.len.set(self.buf.len());
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_64k_powers_of_two() {
        assert_eq!(BUCKETS[0], 65_536);
        assert_eq!(MAX_BUCKET, 32 * 1024 * 1024);
        assert!(BUCKETS.windows(2).all(|w| w[1] == 2 * w[0]));
    }

    #[test]
    fn stream_length_inverse() {
        let full = AGE_CHUNK_LEN + AGE_TAG_LEN;
        for n in (0..4 * AGE_CHUNK_LEN).step_by(97).chain([
            0,
            1,
            AGE_CHUNK_LEN - 1,
            AGE_CHUNK_LEN,
            AGE_CHUNK_LEN + 1,
            2 * AGE_CHUNK_LEN,
        ]) {
            assert_eq!(stream_plaintext_len(stream_ciphertext_len(n)), Some(n));
        }
        assert_eq!(stream_ciphertext_len(0), AGE_TAG_LEN);
        assert_eq!(stream_ciphertext_len(AGE_CHUNK_LEN), full);
        assert_eq!(
            stream_ciphertext_len(AGE_CHUNK_LEN + 1),
            full + 1 + AGE_TAG_LEN
        );
        // The gap after a full chunk is unreachable.
        for gap in 1..=AGE_TAG_LEN {
            assert_eq!(stream_plaintext_len(full + gap), None);
        }
        assert_eq!(stream_plaintext_len(AGE_TAG_LEN - 1), None);
    }

    /// For any realistic pair of header lengths, every bucket is reachable, so
    /// a body always lands in the smallest bucket it fits.
    #[test]
    fn every_bucket_reachable_for_realistic_headers() {
        for outer in (100..2_000).step_by(7) {
            for inner in (100..2_000).step_by(11) {
                for &bucket in &BUCKETS {
                    let inner_ct = stream_plaintext_len(bucket - outer);
                    let frame = inner_ct.and_then(|c| stream_plaintext_len(c - inner));
                    assert!(
                        frame.is_some(),
                        "bucket {bucket} outer {outer} inner {inner}"
                    );
                }
            }
        }
    }

    #[test]
    fn plan_picks_smallest_fitting_bucket() {
        let (bucket, padding) = plan(10, 300, 300).expect("fits");
        assert_eq!(bucket, BUCKETS[0]);
        assert!(padding > 60_000);
        let (bucket, _) = plan(BUCKETS[0], 300, 300).expect("fits");
        assert_eq!(bucket, BUCKETS[1]);
        assert_eq!(plan(MAX_BUCKET, 300, 300), None);
    }

    #[test]
    fn frame_rejects_malformed() {
        let mut frame = FRAME_MAGIC.to_vec();
        frame.extend_from_slice(&3u64.to_le_bytes());
        frame.extend_from_slice(b"abc\0\0");
        assert_eq!(parse_frame(&frame).ok(), Some(&b"abc"[..]));

        let mut nonzero = frame.clone();
        *nonzero.last_mut().expect("nonempty") = 1;
        assert!(matches!(parse_frame(&nonzero), Err(SealError::Frame(_))));

        let mut long = frame.clone();
        long[4..12].copy_from_slice(&100u64.to_le_bytes());
        assert!(matches!(parse_frame(&long), Err(SealError::Frame(_))));

        let mut magic = frame.clone();
        magic[0] = b'X';
        assert!(matches!(parse_frame(&magic), Err(SealError::Frame(_))));

        assert!(matches!(parse_frame(&frame[..6]), Err(SealError::Frame(_))));
    }

    #[test]
    fn compression_round_trip_and_trailing_data() {
        let data = b"cadence ".repeat(1_000);
        let compressed = compress(&data).expect("compress");
        assert!(compressed.len() < data.len());
        assert_eq!(decompress(&compressed).expect("decompress"), data);

        let mut trailing = compressed.clone();
        trailing.push(0);
        assert!(matches!(
            decompress(&trailing),
            Err(SealError::Decompress(_))
        ));
    }

    #[test]
    fn invalid_chain_key_is_rejected() {
        let mut chain = DrandChain::quicknet();
        chain.public_key = vec![0u8; 96];
        let runner = x25519::Identity::generate().to_public();
        assert!(matches!(
            seal(b"x", &runner, &chain, 1),
            Err(SealError::InvalidChainKey)
        ));
    }

    #[test]
    fn round_zero_is_rejected() {
        let runner = x25519::Identity::generate().to_public();
        assert!(matches!(
            seal(b"x", &runner, &DrandChain::quicknet(), 0),
            Err(SealError::InvalidRound)
        ));
    }
}
