//! Can the browser prove an Ironwood spend (what a cancel needs)?
//!
//! We take a real signed rung, install a self-consistent anchor + witness for a
//! single-leaf tree (the input note at position 0, every sibling the empty
//! subtree root), prove with pczt's Prover exactly as cadence-runner does, then
//! extract (which batch-verifies proof + spend-auth + binding signatures).
//! The anchor is not an on-chain root, but the proving work is identical to a
//! real 2-action Ironwood spend.

use cadence_core::{build_rung, package::redact_for_runner, seed};
use incrementalmerkletree::{Hashable, Level};
use orchard::{
    circuit::{OrchardCircuitVersion, ProvingKey, VerifyingKey},
    note::ExtractedNoteCommitment,
    tree::{MerkleHashOrchard, MerklePath},
};
use pczt::{
    roles::{prover::Prover, tx_extractor::TransactionExtractor, updater::Updater},
    Pczt,
};
use rand::{rngs::ChaCha20Rng, SeedableRng};
use zcash_protocol::consensus::BlockHeight;

use crate::{fixture, now_ms, BASE_HEIGHT};

#[derive(Debug, Default)]
pub struct ProveReport {
    pub pk_build_ms: f64,
    pub vk_build_ms: f64,
    pub build_rung_ms: f64,
    pub prove_ms: f64,
    pub extract_verify_ms: f64,
    pub tx_bytes: usize,
    pub txid: String,
}

impl ProveReport {
    pub fn to_json(&self) -> String {
        format!(
            concat!(
                "{{\"pk_build_ms\":{:.1},\"vk_build_ms\":{:.1},\"build_rung_ms\":{:.1},",
                "\"prove_ms\":{:.1},\"extract_verify_ms\":{:.1},\"tx_bytes\":{},\"txid\":\"{}\"}}"
            ),
            self.pk_build_ms,
            self.vk_build_ms,
            self.build_rung_ms,
            self.prove_ms,
            self.extract_verify_ms,
            self.tx_bytes,
            self.txid
        )
    }
}

pub fn run_prove() -> Result<ProveReport, String> {
    let mut rep = ProveReport::default();

    let t = now_ms();
    let pk = ProvingKey::build(OrchardCircuitVersion::PostNu6_3);
    rep.pk_build_ms = now_ms() - t;

    let t = now_ms();
    let vk = VerifyingKey::build(OrchardCircuitVersion::PostNu6_3);
    rep.vk_build_ms = now_ms() - t;

    let (params, pocket, inst) = fixture();
    let s = seed::rung_seed(&seed::app_secret(&pocket), &[1u8; 16], 1, 0);
    let t = now_ms();
    let rung = build_rung(&params, BlockHeight::from_u32(BASE_HEIGHT), &pocket, &inst, s)
        .map_err(|e| format!("build_rung: {e:?}"))?;
    // Round-trip through the runner wire format.
    let bytes = redact_for_runner(rung.pczt).serialize().map_err(|e| format!("{e:?}"))?;
    let pczt = Pczt::parse(&bytes).map_err(|e| format!("parse: {e:?}"))?;
    rep.build_rung_ms = now_ms() - t;

    // Single-leaf tree: input note at position 0, all siblings empty.
    let auth_path: [MerkleHashOrchard; 32] =
        core::array::from_fn(|i| MerkleHashOrchard::empty_root(Level::from(i as u8)));
    let witness = MerklePath::from_parts(0, auth_path);
    let cmx = ExtractedNoteCommitment::from(inst.input.commitment());
    let anchor = witness.root(cmx);

    let pczt = Updater::new(pczt)
        .set_ironwood_anchor(anchor)
        .map_err(|e| format!("set anchor: {e:?}"))?
        .set_ironwood_spend_witnesses([(rung.spend_action, witness)])
        .map_err(|e| format!("set witness: {e:?}"))?
        .finish();

    let mut rng = ChaCha20Rng::from_rng(&mut rand::rng());
    let t = now_ms();
    let pczt = Prover::new(pczt)
        .create_ironwood_proof(&mut rng, &pk)
        .map_err(|e| format!("prove: {e:?}"))?
        .finish();
    rep.prove_ms = now_ms() - t;

    let t = now_ms();
    let tx = TransactionExtractor::new(pczt)
        .with_orchard(&vk)
        .extract(&mut rng)
        .map_err(|e| format!("extract/verify: {e:?}"))?;
    rep.extract_verify_ms = now_ms() - t;

    let mut out = vec![];
    tx.write(&mut out).map_err(|e| e.to_string())?;
    rep.tx_bytes = out.len();
    rep.txid = tx.txid().to_string();
    Ok(rep)
}
