//! Completing the cancel in the browser: install the deferred Ironwood anchor and
//! the spend's witness, prove, and extract the transaction.
//!
//! This is `cadence_chain::wallet::complete` without the wallet database: the
//! runner supplies the anchor and authentication path
//! (`GET /api/pockets/:id/witness`), and the extractor verifies the proof and
//! every signature before a transaction comes out, so a wrong anchor or path is
//! an error here, not a rejected broadcast.
//!
//! Building the proving key takes seconds (about 14 s in a browser), so it is
//! built once per wasm instance and cached; [`warm_up`] builds it ahead of need.

use std::cell::OnceCell;

use orchard::{
    circuit::{OrchardCircuitVersion, ProvingKey, VerifyingKey},
    tree::{MerkleHashOrchard, MerklePath},
    Anchor,
};
use pczt::{
    roles::{prover::Prover, tx_extractor::TransactionExtractor, updater::Updater},
    Pczt,
};
use rand::{rngs::ChaCha20Rng, SeedableRng};
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Ironwood bundles prove with the post-NU6.3 circuit (as the native wallet does).
const CIRCUIT: OrchardCircuitVersion = OrchardCircuitVersion::PostNu6_3;

thread_local! {
    static KEYS: OnceCell<(ProvingKey, VerifyingKey)> = const { OnceCell::new() };
}

fn with_keys<T>(f: impl FnOnce(&ProvingKey, &VerifyingKey) -> T) -> T {
    KEYS.with(|cell| {
        let (pk, vk) = cell.get_or_init(|| (ProvingKey::build(CIRCUIT), VerifyingKey::build(CIRCUIT)));
        f(pk, vk)
    })
}

/// Builds the proving and verifying keys now, so a later proof does not wait.
pub fn warm_up() {
    with_keys(|_, _| ());
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProvedOut {
    /// The finished transaction, ready for `POST /api/broadcast`.
    pub tx_hex: String,
    pub txid: String,
}

fn hex32(text: &str, what: &str) -> Result<[u8; 32]> {
    hex::decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::Input(format!("{what} must be 32 bytes of hex")))
}

/// Completes a signed, unproven PCZT whose one real spend sits at `position` in
/// the Ironwood tree: `anchor` is the tree root it proves against and
/// `auth_path` the 32 sibling hashes from the leaf up, each as hex of its 32-byte
/// encoding.
pub fn complete_and_prove(pczt_hex: &str, anchor_hex: &str, position: u32, auth_path: &[String]) -> Result<ProvedOut> {
    let bytes = hex::decode(pczt_hex.trim()).map_err(|_| Error::Input("the PCZT is not hex".into()))?;
    let pczt = Pczt::parse(&bytes).map_err(|e| Error::Input(format!("bad PCZT: {e:?}")))?;
    let anchor = Option::<Anchor>::from(Anchor::from_bytes(hex32(anchor_hex, "the anchor")?))
        .ok_or_else(|| Error::Input("the anchor is not a valid tree root".into()))?;
    if auth_path.len() != 32 {
        return Err(Error::Input(format!("the auth path has {} hashes, not 32", auth_path.len())));
    }
    let mut path = [MerkleHashOrchard::from_bytes(&[0u8; 32]).unwrap(); 32];
    for (i, h) in auth_path.iter().enumerate() {
        path[i] = Option::from(MerkleHashOrchard::from_bytes(&hex32(h, "an auth path hash")?))
            .ok_or_else(|| Error::Input(format!("auth path hash {i} is not a field element")))?;
    }
    let witness = MerklePath::from_parts(position, path);

    // As cadence-chain's wallet: the real spend is the one action without a witness.
    let spend_action = pczt
        .ironwood()
        .actions()
        .iter()
        .position(|a| a.spend().witness().is_none())
        .ok_or_else(|| Error::Input("the PCZT has no deferred spend".into()))?;
    let pczt = Updater::new(pczt)
        .set_ironwood_anchor(anchor)
        .map_err(|e| Error::Prove(format!("setting the anchor: {e:?}")))?
        .set_ironwood_spend_witnesses([(spend_action, witness)])
        .map_err(|e| Error::Prove(format!("setting the witness: {e:?}")))?
        .finish();

    let mut rng = ChaCha20Rng::from_rng(&mut rand::rng());
    let tx = with_keys(|pk, vk| {
        let pczt = Prover::new(pczt)
            .create_ironwood_proof(&mut rng, pk)
            .map_err(|e| Error::Prove(format!("{e:?}")))?
            .finish();
        TransactionExtractor::new(pczt)
            .with_orchard(vk)
            .extract(&mut rng)
            .map_err(|e| Error::Prove(format!("the transaction does not verify: {e:?}")))
    })?;
    let mut out = Vec::new();
    tx.write(&mut out).map_err(|e| Error::Prove(format!("encoding the transaction: {e}")))?;
    Ok(ProvedOut { tx_hex: hex::encode(out), txid: tx.txid().to_string() })
}
