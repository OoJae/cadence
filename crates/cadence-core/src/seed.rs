//! Builder randomness for rungs.
//!
//! Every rung of an installment must consume identical randomness (so `rcv`,
//! `alpha`, `rseed`, the dummy note and the action order match), yet nothing the
//! runner receives may let it reproduce that randomness. The seed is therefore a
//! keyed PRF over a secret that only the payer app holds.

use crate::Pocket;

/// The app-only PRF key for a pocket, derived from its spending key.
pub fn app_secret(pocket: &Pocket) -> [u8; 32] {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .key(pocket.sk_bytes())
        .personal(b"Cadence_AppSecrt")
        .hash(b"rung-prf");
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    out
}

/// The builder RNG seed for installment `k`, retry `attempt`, of mandate `mandate_id`.
pub fn rung_seed(app_secret: &[u8; 32], mandate_id: &[u8; 16], k: u32, attempt: u32) -> [u8; 32] {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .key(app_secret)
        .personal(b"Cadence_RungSeed")
        .to_state()
        .update(mandate_id)
        .update(&k.to_le_bytes())
        .update(&attempt.to_le_bytes())
        .finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(h.as_bytes());
    out
}
