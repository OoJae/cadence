//! `#[wasm_bindgen]` exports. Each one converts its arguments, calls the plain-Rust
//! function of the same name in the crate root, and returns its result as JSON
//! (objects), a number or a typed array. Errors are thrown as JS `Error`s.
//!
//! Secrets cross as `Uint8Array` (the 32-byte pocket seed) or hex inside strings
//! (notes), never as JS numbers. Amounts and unix times are JS numbers and must
//! be safe integers.

use wasm_bindgen::prelude::*;

fn js<T: serde::Serialize>(r: crate::Result<T>) -> Result<String, JsError> {
    let v = r.map_err(|e| JsError::new(&e.to_string()))?;
    serde_json::to_string(&v).map_err(|e| JsError::new(&e.to_string()))
}

fn uint(n: f64, what: &str) -> Result<u64, JsError> {
    if n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0 {
        Ok(n as u64)
    } else {
        Err(JsError::new(&format!("{what} must be a non-negative safe integer")))
    }
}

fn mandate_id(hex_id: &str) -> Result<[u8; 16], JsError> {
    hex::decode(hex_id.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| JsError::new("the mandate id is 16 bytes of hex"))
}

/// The crate version and whether this build carries the prover.
#[wasm_bindgen]
pub fn build_info() -> String {
    format!(
        "{{\"crate\":\"cadence-wasm\",\"version\":\"{}\",\"prover\":{}}}",
        env!("CARGO_PKG_VERSION"),
        cfg!(feature = "prover")
    )
}

/// `{ seed_hex, ua, ufvk }` for a fresh random pocket.
#[wasm_bindgen]
pub fn create_pocket(network: &str) -> Result<String, JsError> {
    js(crate::create_pocket(network))
}

/// `{ ua, ufvk }` for the pocket of a 32-byte `seed` the page generated.
#[wasm_bindgen]
pub fn pocket_info(network: &str, seed: &[u8]) -> Result<String, JsError> {
    js(crate::pocket_info(network, seed))
}

/// `{ note, value_zat, nullifier }`: the pocket's note in a raw funding transaction.
#[wasm_bindgen]
pub fn funding_from_tx(network: &str, seed: &[u8], tx_hex: &str, height: u32) -> Result<String, JsError> {
    js(crate::funding_from_tx(network, seed, tx_hex, height))
}

/// `{ note, value_zat, nullifier }` for a stand-in, never-mined funding note.
/// Tests and the smoke test only.
#[wasm_bindgen]
pub fn synthetic_note(network: &str, seed: &[u8], value_zat: f64) -> Result<String, JsError> {
    js(crate::synthetic_note(network, seed, uint(value_zat, "value_zat")?))
}

/// `{ k, rungs: RungPackage[], spends_nullifier, actions_digest, change: { note, value_zat, nullifier } | null }`.
///
/// `terms_json` is `{ amount_zat, count, merchant_ua, label? }`.
#[wasm_bindgen]
pub fn presign_shard(
    network: &str,
    seed: &[u8],
    input_note: &str,
    terms_json: &str,
    k: u32,
    mandate_id_hex: &str,
    heights: &[u32],
) -> Result<String, JsError> {
    let terms: crate::ShardTerms =
        serde_json::from_str(terms_json).map_err(|e| JsError::new(&format!("bad terms JSON: {e}")))?;
    js(crate::presign_shard(network, seed, input_note, &terms, k, &mandate_id(mandate_id_hex)?, heights))
}

/// `{ sealed, sealed_bytes, plaintext_bytes, round }`, `sealed` being standard base64.
#[wasm_bindgen]
pub fn seal_installment(ladder_json: &str, runner_age_recipient: &str, round: f64) -> Result<String, JsError> {
    js(crate::seal_installment(ladder_json, runner_age_recipient, uint(round, "round")?))
}

/// The drand quicknet round to time-lock to for "not before `unix_secs`".
#[wasm_bindgen]
pub fn round_for(unix_secs: f64) -> Result<f64, JsError> {
    Ok(crate::round_for(uint(unix_secs, "unix_secs")?) as f64)
}

/// Candidate target heights for an installment releasable at `at`.
#[wasm_bindgen]
pub fn window(network: &str, tip: u32, now: f64, at: f64) -> Result<Vec<u32>, JsError> {
    crate::window(network, tip, uint(now, "now")?, uint(at, "at")?).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn installment_fee() -> f64 {
    crate::installment_fee() as f64
}

#[wasm_bindgen]
pub fn funding_total(amount_zat: f64, count: u32) -> Result<f64, JsError> {
    crate::funding_total(uint(amount_zat, "amount_zat")?, count)
        .map(|v| v as f64)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// `{ pczt, refunded_zat, fee_zat, target_height, expiry_height, spends_nullifier }`.
#[wasm_bindgen]
pub fn build_cancel(network: &str, seed: &[u8], note: &str, refund_ua: &str, target_height: u32) -> Result<String, JsError> {
    js(crate::build_cancel(network, seed, note, refund_ua, target_height))
}

/// The recovery kit `plain_json`, encrypted to `passphrase` (age scrypt). Slow by
/// design (seconds): call it from a worker.
#[wasm_bindgen]
pub fn seal_kit(plain_json: &str, passphrase: &str) -> Result<Vec<u8>, JsError> {
    crate::seal_kit(plain_json, passphrase).map_err(|e| JsError::new(&e.to_string()))
}

/// The JSON inside a kit sealed by `seal_kit`. Slow by design: call it from a worker.
#[wasm_bindgen]
pub fn open_kit(bytes: &[u8], passphrase: &str) -> Result<String, JsError> {
    crate::open_kit(bytes, passphrase).map_err(|e| JsError::new(&e.to_string()))
}

/// Builds the proving and verifying keys now; returns the milliseconds it took.
#[cfg(feature = "prover")]
#[wasm_bindgen]
pub fn prover_warm_up() -> f64 {
    let t = js_sys_now();
    crate::prove::warm_up();
    js_sys_now() - t
}

/// `{ tx_hex, txid }`: installs the anchor and witness, proves and extracts.
#[cfg(feature = "prover")]
#[wasm_bindgen]
pub fn complete_and_prove(pczt_hex: &str, anchor_hex: &str, position: u32, auth_path: Vec<String>) -> Result<String, JsError> {
    js(crate::prove::complete_and_prove(pczt_hex, anchor_hex, position, &auth_path))
}

#[cfg(feature = "prover")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn js_sys_now() -> f64;
}

/// Current wasm linear memory, in bytes (it only grows, so this is the peak).
#[wasm_bindgen]
pub fn memory_bytes() -> f64 {
    (core::arch::wasm32::memory_size(0) * 65536) as f64
}
