//! The Cadence payer signer for the browser.
//!
//! This crate is the boundary between `web/` and the signing engine
//! (`cadence-core`) and sealing (`cadence-seal`). Every function here is plain Rust,
//! so `cargo test -p cadence-wasm` exercises exactly what the browser runs; the
//! `#[wasm_bindgen]` exports in [`bindings`] only convert arguments and results
//! (JSON strings, `Uint8Array`s, numbers).
//!
//! The functions are stateless. The page keeps the pocket seed and the notes, and
//! sends them with every call, so any Web Worker in a pool can serve any call:
//!
//! - [`presign_shard`] signs one installment at a subset of its candidate heights.
//!   Every rung of installment `k` uses the same builder seed
//!   (`seed::rung_seed(app_secret(pocket), mandate_id, k, 0)`) and the same input
//!   note, so shards signed in different workers carry byte-identical actions and
//!   agree on the change note `C(k)` that installment `k + 1` spends.
//! - [`seal_installment`] seals one installment's ladder to the runner and its
//!   drand round.
//! - [`build_cancel`] signs the payer's cancel: the pocket's live note, less the
//!   fee, back to the payer's own wallet.
//! - With the `prover` feature, `prove::complete_and_prove` installs the anchor
//!   and witness, proves and extracts the cancel transaction.

use core::fmt;
use std::str::FromStr;

use base64::Engine as _;
use cadence_core::{
    build_rung, mandate,
    package::{redact_for_runner, InstallmentLadder, RungPackage},
    seed, ActionFingerprint, Installment, Pocket,
};
use cadence_seal::{age, DrandChain};
use orchard::{
    note::{Note, RandomSeed, Rho},
    value::NoteValue,
    NoteVersion,
};
use serde::{Deserialize, Serialize};
use zcash_keys::address::Address;
use zcash_protocol::{
    consensus::{BlockHeight, Network, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

pub mod note;
#[cfg(feature = "prover")]
pub mod prove;

#[cfg(target_arch = "wasm32")]
mod bindings;

// ---------------------------------------------------------------- errors

#[derive(Debug)]
pub enum Error {
    Network(String),
    Seed,
    Note(String),
    Address(String),
    Input(String),
    Rung(String),
    Mandate(String),
    Seal(String),
    Prove(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Network(n) => write!(f, "unknown network {n:?} (expected \"main\" or \"test\")"),
            Error::Seed => write!(f, "a pocket seed is 32 bytes"),
            Error::Note(why) => write!(f, "bad note: {why}"),
            Error::Address(why) => write!(f, "{why}"),
            Error::Input(why) => write!(f, "{why}"),
            Error::Rung(why) => write!(f, "signing failed: {why}"),
            Error::Mandate(why) => write!(f, "{why}"),
            Error::Seal(why) => write!(f, "sealing failed: {why}"),
            Error::Prove(why) => write!(f, "proving failed: {why}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T, E = Error> = core::result::Result<T, E>;

// ---------------------------------------------------------------- shared helpers

pub fn network(name: &str) -> Result<Network> {
    match name {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => Err(Error::Network(other.to_string())),
    }
}

fn seed32(seed: &[u8]) -> Result<[u8; 32]> {
    seed.try_into().map_err(|_| Error::Seed)
}

pub fn pocket(params: &Network, seed: &[u8]) -> Result<Pocket> {
    Ok(Pocket::from_seed(&seed32(seed)?, params.network_type().coin_type()))
}

fn hex_array<const N: usize>(text: &str, what: &str) -> Result<[u8; N]> {
    hex::decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::Input(format!("{what} must be {N} bytes of hex")))
}

/// The Orchard receiver of a unified address on `params`.
pub fn orchard_receiver(params: &Network, ua: &str, what: &str) -> Result<orchard::Address> {
    match Address::decode(params, ua.trim()) {
        Some(Address::Unified(ua)) => ua
            .orchard()
            .copied()
            .ok_or_else(|| Error::Address(format!("the {what} address has no Orchard receiver"))),
        Some(_) => Err(Error::Address(format!(
            "the {what} address must be a unified address with an Orchard receiver"
        ))),
        None => Err(Error::Address(format!("the {what} address is not valid on this network"))),
    }
}

/// Refuses a note that does not belong to this pocket (wrong seed or network).
fn own_note(pocket: &Pocket, note: &Note) -> Result<()> {
    let r = note.recipient();
    if r == pocket.funding_address() || r == pocket.change_address() {
        Ok(())
    } else {
        Err(Error::Note("this note was not sent to this pocket".into()))
    }
}

fn nullifier_hex(pocket: &Pocket, note: &Note) -> String {
    hex::encode(note.nullifier(pocket.fvk()).to_bytes())
}

/// BLAKE2b-256 over every action's public contents. Rungs (and shards) of one
/// installment must agree on it; the page compares it across workers.
pub fn actions_digest(actions: &[ActionFingerprint]) -> String {
    let mut st = blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"Cadence_Actions_")
        .to_state();
    for a in actions {
        st.update(&a.cv_net)
            .update(&a.nf)
            .update(&a.rk)
            .update(&a.cmx)
            .update(&a.epk)
            .update(&(a.enc_ciphertext.len() as u64).to_le_bytes())
            .update(&a.enc_ciphertext)
            .update(&a.out_ciphertext);
    }
    hex::encode(st.finalize().as_bytes())
}

// ---------------------------------------------------------------- pockets

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PocketOut {
    /// Only set by [`create_pocket`]. The page keeps it in memory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_hex: Option<String>,
    /// Orchard-only unified address the payer funds.
    pub ua: String,
    /// Orchard-only UFVK the runner imports as a view-only account.
    pub ufvk: String,
}

/// The public face of the pocket for `seed`: its funding UA and its UFVK.
pub fn pocket_info(network_name: &str, seed: &[u8]) -> Result<PocketOut> {
    let params = network(network_name)?;
    let pocket = pocket(&params, seed)?;
    let ufvk = pocket
        .ufvk()
        .encode(&params)
        .map_err(|e| Error::Input(format!("encoding the UFVK: {e:?}")))?;
    Ok(PocketOut { seed_hex: None, ua: pocket.funding_ua(&params), ufvk })
}

/// A fresh single-use pocket: a new random seed, at cadence-core's fixed non-zero
/// ZIP 32 account.
pub fn create_pocket(network_name: &str) -> Result<PocketOut> {
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    let mut out = pocket_info(network_name, &seed)?;
    out.seed_hex = Some(hex::encode(seed));
    Ok(out)
}

// ---------------------------------------------------------------- funding

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct NoteOut {
    /// The note in the [`note`] encoding.
    pub note: String,
    pub value_zat: u64,
    /// The note's nullifier, hex of its 32 bytes (as the runner reports notes).
    pub nullifier: String,
}

fn note_out(pocket: &Pocket, note: &Note) -> NoteOut {
    NoteOut { note: note::encode_hex(note), value_zat: note.value().inner(), nullifier: nullifier_hex(pocket, note) }
}

/// Finds the pocket's funding note in the raw transaction the runner relays.
pub fn funding_from_tx(network_name: &str, seed: &[u8], tx_hex: &str, height: u32) -> Result<NoteOut> {
    let params = network(network_name)?;
    let pocket = pocket(&params, seed)?;
    let tx = hex::decode(tx_hex.trim()).map_err(|_| Error::Input("the funding transaction is not hex".into()))?;
    let note = mandate::decrypt_funding(&params, &tx, BlockHeight::from_u32(height), &pocket).map_err(|e| match e {
        mandate::Error::NoFundingNote => Error::Mandate("the funding transaction pays no Ironwood note to this pocket".into()),
        other => Error::Mandate(format!("reading the funding transaction: {other:?}")),
    })?;
    Ok(note_out(&pocket, &note))
}

/// A stand-in funding note of `value_zat` to the pocket, for tests and the
/// in-browser smoke test only. It was never mined, so nothing it signs can be
/// proven or broadcast; it only lets the signer run without a chain.
pub fn synthetic_note(network_name: &str, seed: &[u8], value_zat: u64) -> Result<NoteOut> {
    let params = network(network_name)?;
    let pocket = pocket(&params, seed)?;
    let rho = Option::<Rho>::from(Rho::from_bytes(&[7u8; 32])).expect("canonical field element");
    let note = (0u8..=255)
        .find_map(|i| {
            let rseed = Option::<RandomSeed>::from(RandomSeed::from_bytes([i; 32], &rho))?;
            Option::<Note>::from(Note::from_parts(
                pocket.funding_address(),
                NoteValue::from_raw(value_zat),
                rho,
                rseed,
                NoteVersion::V3,
            ))
        })
        .expect("some rseed yields a valid note");
    Ok(note_out(&pocket, &note))
}

// ---------------------------------------------------------------- schedule

/// ZIP 317 fee of one installment (and of the cancel), in zatoshis.
pub fn installment_fee() -> u64 {
    mandate::installment_fee().into()
}

/// The single payment that funds `count` installments of `amount_zat`, fees included.
pub fn funding_total(amount_zat: u64, count: u32) -> Result<u64> {
    let amount = Zatoshis::from_u64(amount_zat).map_err(|_| Error::Input("invalid amount".into()))?;
    let per = (amount + mandate::installment_fee()).ok_or_else(|| Error::Input("amount overflows".into()))?;
    let total = (per * u64::from(count)).ok_or_else(|| Error::Input("total overflows".into()))?;
    Ok(total.into())
}

/// Candidate target heights for an installment releasable at unix time `at`, from
/// the tip seen at `now` (`cadence_core::mandate::window`).
pub fn window(network_name: &str, tip: u32, now: u64, at: u64) -> Result<Vec<u32>> {
    let params = network(network_name)?;
    Ok(mandate::window(&params, BlockHeight::from_u32(tip), now, at)
        .into_iter()
        .map(u32::from)
        .collect())
}

/// The drand quicknet round to time-lock to so a package cannot open before `unix_secs`.
pub fn round_for(unix_secs: u64) -> u64 {
    cadence_seal::first_round_at_or_after(&DrandChain::quicknet(), unix_secs)
}

// ---------------------------------------------------------------- presign

/// What the merchant's offer fixes for every installment.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ShardTerms {
    pub amount_zat: u64,
    pub count: u32,
    pub merchant_ua: String,
    /// 16 bytes of hex: the opaque tag in each installment's memo (`tag || k`).
    /// Defaults to the mandate id, as the CLI does.
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ShardOut {
    pub k: u32,
    /// One per requested height, in the order given.
    pub rungs: Vec<RungPackage>,
    /// Nullifier of the note this installment spends.
    pub spends_nullifier: String,
    /// [`actions_digest`] of the installment's actions, identical for every rung.
    pub actions_digest: String,
    /// The change note `C(k)`, which installment `k + 1` spends. `None` only for
    /// the final installment when it empties the pocket.
    pub change: Option<NoteOut>,
}

impl fmt::Debug for ShardOut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ShardOut")
            .field("k", &self.k)
            .field("rungs", &self.rungs.iter().map(|r| r.target_height).collect::<Vec<_>>())
            .field("spends_nullifier", &self.spends_nullifier)
            .field("actions_digest", &self.actions_digest)
            .field("change_value_zat", &self.change.as_ref().map(|c| c.value_zat))
            .finish()
    }
}

/// The memo of installment `k`: `tag || k (u32 LE)`, as `mandate::presign` writes it.
fn installment_memo(tag: &[u8; 16], k: u32) -> MemoBytes {
    let mut memo = [0u8; 20];
    memo[..16].copy_from_slice(tag);
    memo[16..].copy_from_slice(&k.to_le_bytes());
    MemoBytes::from_bytes(&memo).expect("20 bytes fit a memo")
}

/// Signs installment `k` of mandate `mandate_id`, spending `input_note`, once per
/// height in `heights`.
///
/// This is the body of `cadence_core::mandate::presign` for one installment,
/// restricted to some of its heights, so a page can spread one installment's
/// window over several workers. Each rung is redacted for the runner and
/// serialized exactly as `mandate::presign` does it.
pub fn presign_shard(
    network_name: &str,
    seed: &[u8],
    input_note: &str,
    terms: &ShardTerms,
    k: u32,
    mandate_id: &[u8; 16],
    heights: &[u32],
) -> Result<ShardOut> {
    let params = network(network_name)?;
    let pocket = pocket(&params, seed)?;
    let input = note::decode_hex(input_note)?;
    own_note(&pocket, &input)?;
    if k == 0 || k > terms.count {
        return Err(Error::Input(format!("installment {k} is outside 1..={}", terms.count)));
    }
    if heights.is_empty() {
        return Err(Error::Input("no heights to sign".into()));
    }
    let merchant = orchard_receiver(&params, &terms.merchant_ua, "merchant")?;
    let amount = Zatoshis::from_u64(terms.amount_zat).map_err(|_| Error::Input("invalid amount".into()))?;
    if amount.is_zero() {
        return Err(Error::Input("an installment pays a positive amount".into()));
    }
    let tag = match &terms.tag {
        Some(t) => hex_array::<16>(t, "the memo tag")?,
        None => *mandate_id,
    };
    let inst = Installment { input, amount, merchant, memo: installment_memo(&tag, k) };
    let rung_seed = seed::rung_seed(&seed::app_secret(&pocket), mandate_id, k, 0);

    let mut rungs = Vec::with_capacity(heights.len());
    let mut first: Option<(Vec<ActionFingerprint>, Option<Note>)> = None;
    let mut spends_nullifier = [0u8; 32];
    for &h in heights {
        let rung = build_rung(&params, BlockHeight::from_u32(h), &pocket, &inst, rung_seed)
            .map_err(|e| Error::Rung(format!("installment {k} at height {h}: {e:?}")))?;
        if rung.fee != mandate::installment_fee() {
            return Err(Error::Rung(format!("installment {k} at height {h}: unexpected fee {:?}", rung.fee)));
        }
        spends_nullifier = rung.actions[rung.spend_action].nf;
        match &first {
            None => first = Some((rung.actions.clone(), rung.change)),
            Some((actions, change)) => {
                let same_change = match (change, &rung.change) {
                    (None, None) => true,
                    (Some(a), Some(b)) => note::encode(a) == note::encode(b),
                    _ => false,
                };
                if *actions != rung.actions || !same_change {
                    return Err(Error::Rung(format!(
                        "installment {k}: the rung at height {h} differs from the first; refusing a ladder whose rungs disagree"
                    )));
                }
            }
        }
        let bytes = redact_for_runner(rung.pczt)
            .serialize()
            .map_err(|e| Error::Rung(format!("encoding the PCZT: {e:?}")))?;
        rungs.push(RungPackage { target_height: h, expiry_height: rung.expiry_height.into(), pczt: hex::encode(bytes) });
    }
    let (actions, change) = first.expect("at least one height");
    if change.is_none() && k < terms.count {
        return Err(Error::Mandate(format!(
            "the pocket is exhausted after installment {k} of {}",
            terms.count
        )));
    }
    Ok(ShardOut {
        k,
        rungs,
        spends_nullifier: hex::encode(spends_nullifier),
        actions_digest: actions_digest(&actions),
        change: change.map(|c| note_out(&pocket, &c)),
    })
}

// ---------------------------------------------------------------- seal

#[derive(Serialize, Deserialize, Debug)]
pub struct SealOut {
    /// Standard base64 of `tlock(age(zstd(ladder_k)))`, as `POST /api/subscriptions` takes it.
    pub sealed: String,
    /// Length of the sealed package: always one of `cadence_seal::BUCKETS`.
    pub sealed_bytes: usize,
    /// Length of the JSON ladder inside.
    pub plaintext_bytes: usize,
    pub round: u64,
}

/// Seals one installment's ladder (`cadence_core::package::InstallmentLadder` JSON)
/// to the runner's age recipient, time-locked to drand quicknet `round`.
///
/// The ladder is parsed and re-serialized, so the plaintext is canonical and a
/// malformed ladder never gets sealed.
pub fn seal_installment(ladder_json: &str, runner_age_recipient: &str, round: u64) -> Result<SealOut> {
    let ladder: InstallmentLadder =
        serde_json::from_str(ladder_json).map_err(|e| Error::Input(format!("bad ladder JSON: {e}")))?;
    if ladder.k == 0 || ladder.rungs.is_empty() {
        return Err(Error::Input("a ladder has k >= 1 and at least one rung".into()));
    }
    hex_array::<32>(&ladder.spends_nullifier, "spends_nullifier")?;
    if ladder.rungs.windows(2).any(|w| w[0].target_height >= w[1].target_height) {
        return Err(Error::Input("rungs must be in strictly increasing height order".into()));
    }
    if ladder.rungs.iter().any(|r| r.pczt.is_empty() || r.pczt.len() % 2 != 0 || !r.pczt.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(Error::Input("every rung carries a hex PCZT".into()));
    }
    let recipient = age::x25519::Recipient::from_str(runner_age_recipient.trim())
        .map_err(|e| Error::Input(format!("bad runner age recipient: {e}")))?;
    let plaintext = serde_json::to_vec(&ladder).map_err(|e| Error::Seal(e.to_string()))?;
    let sealed = cadence_seal::seal(&plaintext, &recipient, &DrandChain::quicknet(), round)
        .map_err(|e| Error::Seal(e.to_string()))?;
    Ok(SealOut {
        sealed: base64::engine::general_purpose::STANDARD.encode(&sealed),
        sealed_bytes: sealed.len(),
        plaintext_bytes: plaintext.len(),
        round,
    })
}

// ---------------------------------------------------------------- cancel

#[derive(Serialize, Deserialize, Debug)]
pub struct CancelOut {
    /// The signed, unproven cancel PCZT (hex). Its anchor and witness are deferred.
    pub pczt: String,
    pub refunded_zat: u64,
    pub fee_zat: u64,
    pub target_height: u32,
    pub expiry_height: u32,
    /// The pocket note it spends.
    pub spends_nullifier: String,
}

/// Signs the payer's cancel: the pocket's live `note`, less the fee, to the
/// Orchard receiver of `refund_ua`, with an empty memo and no outgoing viewing
/// key (OvkPolicy::Discard). Once it is mined, every later installment spends a
/// note that no longer exists.
///
/// This is `build_rung` with the refund address as merchant and a fresh random
/// builder seed. Spending the whole note leaves no change, so the transaction is
/// a standard two-action Ironwood send.
pub fn build_cancel(
    network_name: &str,
    seed: &[u8],
    note_hex: &str,
    refund_ua: &str,
    target_height: u32,
) -> Result<CancelOut> {
    let params = network(network_name)?;
    let pocket = pocket(&params, seed)?;
    let input = note::decode_hex(note_hex)?;
    own_note(&pocket, &input)?;
    let refund = orchard_receiver(&params, refund_ua, "refund")?;
    if refund == pocket.funding_address() || refund == pocket.change_address() {
        return Err(Error::Address("refund to an address of your own wallet, not to the pocket".into()));
    }
    let fee = installment_fee();
    let value = input.value().inner();
    if value <= fee {
        return Err(Error::Mandate("nothing is left in the pocket to refund".into()));
    }
    let amount = Zatoshis::from_u64(value - fee).map_err(|_| Error::Input("invalid amount".into()))?;
    let mut builder_seed = [0u8; 32];
    rand::fill(&mut builder_seed);
    let inst = Installment { input, amount, merchant: refund, memo: MemoBytes::empty() };
    let rung = build_rung(&params, BlockHeight::from_u32(target_height), &pocket, &inst, builder_seed)
        .map_err(|e| Error::Rung(format!("cancel at height {target_height}: {e:?}")))?;
    if rung.change.is_some() || u64::from(rung.fee) != fee {
        return Err(Error::Rung("the cancel must spend the whole note at the standard fee".into()));
    }
    let spends_nullifier = hex::encode(rung.actions[rung.spend_action].nf);
    let bytes = rung.pczt.serialize().map_err(|e| Error::Rung(format!("encoding the PCZT: {e:?}")))?;
    Ok(CancelOut {
        pczt: hex::encode(bytes),
        refunded_zat: value - fee,
        fee_zat: fee,
        target_height,
        expiry_height: rung.expiry_height.into(),
        spends_nullifier,
    })
}
