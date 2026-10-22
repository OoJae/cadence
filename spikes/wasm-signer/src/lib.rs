//! WASM spike: can the payer-side Cadence signer (build + sign + redact +
//! serialize rungs) run in a JS engine, and how fast? Optionally, can the
//! browser also prove an Ironwood spend (needed for cancel)?
//!
//! The core logic is plain Rust so `src/bin/native.rs` runs the exact same
//! code natively for comparison; the `#[wasm_bindgen]` exports wrap it.

use cadence_core::{build_rung, package::redact_for_runner, package::RungPackage, seed, Installment, Pocket};
use orchard::{
    note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho},
    value::NoteValue,
};
use zcash_protocol::{
    consensus::{BlockHeight, MainNetwork, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

#[cfg(feature = "prove")]
pub mod prove;

/// Same base height as the S1 determinism test.
pub const BASE_HEIGHT: u32 = 3_530_000;

// ---------------------------------------------------------------- timing

#[cfg(target_arch = "wasm32")]
mod clock {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = performance, js_name = now)]
        fn perf_now() -> f64;
    }
    pub fn now_ms() -> f64 {
        perf_now()
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod clock {
    use std::{sync::OnceLock, time::Instant};
    static START: OnceLock<Instant> = OnceLock::new();
    pub fn now_ms() -> f64 {
        START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

pub use clock::now_ms;

// ---------------------------------------------------------------- fixture (S1)

/// A stand-in for the funding note F (identical to tests/s1_determinism.rs).
pub fn funding_note(pocket: &Pocket, value: u64) -> Note {
    let rho = Option::from(Rho::from_bytes(&[7u8; 32])).expect("canonical field element");
    (0u8..=255)
        .find_map(|i| {
            let rseed = Option::from(RandomSeed::from_bytes([i; 32], &rho))?;
            Option::from(Note::from_parts(
                pocket.funding_address(),
                NoteValue::from_raw(value),
                rho,
                rseed,
                NoteVersion::V3,
            ))
        })
        .expect("some rseed yields a valid note")
}

pub fn fixture() -> (MainNetwork, Pocket, Installment) {
    let params = MainNetwork;
    let pocket = Pocket::from_seed(&[42u8; 32], params.network_type().coin_type());
    let merchant =
        Pocket::from_seed(&[9u8; 32], params.network_type().coin_type()).funding_address();
    let inst = Installment {
        input: funding_note(&pocket, 100_000),
        amount: Zatoshis::const_from_u64(20_000),
        merchant,
        memo: MemoBytes::from_bytes(b"cadence:test:k=1").unwrap(),
    };
    (params, pocket, inst)
}

// ---------------------------------------------------------------- bench

#[derive(Debug, Default, Clone)]
pub struct BenchReport {
    pub n: u32,
    pub fixture_ms: f64,
    pub build_sign_ms: f64,
    pub redact_ms: f64,
    pub serialize_ms: f64,
    pub total_ms: f64,
    pub per_rung_ms: f64,
    pub pczt_bytes: usize,
    pub package_json_bytes: usize,
    /// BLAKE2b-256 over all action fingerprints of rung 0. Must match native.
    pub actions_digest: String,
    pub change_cmx: String,
    pub sighash0: String,
    pub expiry0: u32,
    pub branch0: u32,
}

impl BenchReport {
    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"n\":{},\"fixture_ms\":{:.3},\"build_sign_ms\":{:.3},\"redact_ms\":{:.3},",
                "\"serialize_ms\":{:.3},\"total_ms\":{:.3},\"per_rung_ms\":{:.3},",
                "\"pczt_bytes\":{},\"package_json_bytes\":{},\"actions_digest\":\"{}\",",
                "\"change_cmx\":\"{}\",\"sighash0\":\"{}\",\"expiry0\":{},\"branch0\":\"0x{:08x}\"}}"
            ),
            self.n,
            self.fixture_ms,
            self.build_sign_ms,
            self.redact_ms,
            self.serialize_ms,
            self.total_ms,
            self.per_rung_ms,
            self.pczt_bytes,
            self.package_json_bytes,
            self.actions_digest,
            self.change_cmx,
            self.sighash0,
            self.expiry0,
            self.branch0
        )
    }
}

fn digest_actions(actions: &[cadence_core::ActionFingerprint]) -> String {
    let mut st = blake2b_simd::Params::new().hash_length(32).to_state();
    for a in actions {
        st.update(&a.cv_net)
            .update(&a.nf)
            .update(&a.rk)
            .update(&a.cmx)
            .update(&a.epk)
            .update(&a.enc_ciphertext)
            .update(&a.out_ciphertext);
    }
    hex::encode(st.finalize().as_bytes())
}

/// Builds, signs, redacts and serializes `n` rungs of one installment at
/// consecutive target heights, asserting all share byte-identical actions and
/// the same change note.
pub fn run_bench(n: u32) -> Result<BenchReport, String> {
    if n == 0 {
        return Err("n must be > 0".into());
    }
    let t_fix = now_ms();
    let (params, pocket, inst) = fixture();
    let s = seed::rung_seed(&seed::app_secret(&pocket), &[1u8; 16], 1, 0);
    let mut rep = BenchReport { n, fixture_ms: now_ms() - t_fix, ..Default::default() };

    let mut first_actions = None;
    let mut first_change = None;
    let t_all = now_ms();
    for i in 0..n {
        let h = BlockHeight::from_u32(BASE_HEIGHT + i);
        let t0 = now_ms();
        let rung = build_rung(&params, h, &pocket, &inst, s).map_err(|e| format!("build_rung@{h}: {e:?}"))?;
        let t1 = now_ms();
        let target_height = u32::from(rung.target_height);
        let expiry_height = u32::from(rung.expiry_height);
        let redacted = redact_for_runner(rung.pczt);
        let t2 = now_ms();
        let bytes = redacted.serialize().map_err(|e| format!("serialize: {e:?}"))?;
        let pkg = RungPackage { target_height, expiry_height, pczt: hex::encode(&bytes) };
        let json = serde_json::to_string(&pkg).map_err(|e| e.to_string())?;
        let t3 = now_ms();
        rep.build_sign_ms += t1 - t0;
        rep.redact_ms += t2 - t1;
        rep.serialize_ms += t3 - t2;

        let change_cmx = rung
            .change
            .map(|c| ExtractedNoteCommitment::from(c.commitment()).to_bytes())
            .ok_or("missing change note")?;
        match (&first_actions, &first_change) {
            (None, _) => {
                rep.actions_digest = digest_actions(&rung.actions);
                rep.change_cmx = hex::encode(change_cmx);
                rep.sighash0 = hex::encode(rung.sighash);
                rep.expiry0 = expiry_height;
                rep.branch0 = u32::from(rung.branch);
                rep.pczt_bytes = bytes.len();
                rep.package_json_bytes = json.len();
                first_actions = Some(rung.actions);
                first_change = Some(change_cmx);
            }
            (Some(a0), Some(c0)) => {
                if &rung.actions != a0 {
                    return Err(format!("DETERMINISM FAILURE: actions differ at height {h}"));
                }
                if &change_cmx != c0 {
                    return Err(format!("DETERMINISM FAILURE: change differs at height {h}"));
                }
            }
            _ => unreachable!(),
        }
    }
    rep.total_ms = now_ms() - t_all;
    rep.per_rung_ms = rep.total_ms / n as f64;
    Ok(rep)
}

// ---------------------------------------------------------------- wasm exports

#[cfg(target_arch = "wasm32")]
mod exports {
    use wasm_bindgen::prelude::*;

    /// Builds `n` rungs (build + sign + redact + serialize) and returns ms per rung.
    /// Throws if any rung's actions or change note differ from rung 0.
    #[wasm_bindgen]
    pub fn bench_rungs(n: u32) -> f64 {
        match super::run_bench(n) {
            Ok(r) => r.per_rung_ms,
            Err(e) => wasm_bindgen::throw_str(&e),
        }
    }

    /// Same as `bench_rungs` but returns the full JSON report (phase split,
    /// sizes, action digest for cross-checking against native).
    #[wasm_bindgen]
    pub fn bench_rungs_report(n: u32) -> Result<String, JsError> {
        super::run_bench(n).map(|r| r.to_json()).map_err(|e| JsError::new(&e))
    }

    /// Current wasm linear memory size in bytes (memory only grows, so this is the peak).
    #[wasm_bindgen]
    pub fn wasm_memory_bytes() -> f64 {
        (core::arch::wasm32::memory_size(0) * 65536) as f64
    }

    #[cfg(feature = "prove")]
    #[wasm_bindgen]
    pub fn bench_prove() -> Result<String, JsError> {
        super::prove::run_prove().map(|r| r.to_json()).map_err(|e| JsError::new(&e))
    }
}
