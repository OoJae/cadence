//! Native helper for web/scripts/wasm-smoke.mjs, which plays the runner for the
//! browser signer's smoke test. Each subcommand prints one JSON object.
//!
//! ```text
//! smoke_fixture age-identity
//! smoke_fixture fund <network> <ufvk> <value_zat> <height>
//! smoke_fixture open <age_identity> <sealed_base64_file>
//! smoke_fixture inspect <network> <height> <tx_hex_file>
//! ```
//!
//! `fund` mints a real, fully proven and verified transaction paying `value_zat`
//! to the pocket behind `ufvk`. It spends a stand-in faucet note in a one-leaf
//! tree, so it is internally valid but was never on any chain; the browser
//! decrypts it exactly as it would a mined funding transaction, and the one-leaf
//! witness lets the browser prove a real cancel against it.
//!
//! `open` opens a package the browser sealed to quicknet round 33,000,000 (whose
//! beacon is public) and checks every rung's spend authorization signatures.
//!
//! Run with `--features prover` in release.

use std::{fs, process::exit};

use base64::Engine as _;
use cadence_core::{build_rung, package::InstallmentLadder, Installment, Pocket};
use cadence_seal::{
    age::{secrecy::ExposeSecret, x25519},
    DrandChain,
};
use cadence_wasm::{network, note, prove::complete_and_prove, synthetic_note};
use incrementalmerkletree::{Hashable, Level};
use orchard::{
    keys::Scope,
    note::ExtractedNoteCommitment,
    primitives::redpallas::{Signature, SpendAuth, VerificationKey},
    tree::{MerkleHashOrchard, MerklePath},
};
use pczt::{roles::signer::Signer, Pczt};
use serde_json::json;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

/// Quicknet round with a public beacon (cadence-seal's tests use it too).
const OPEN_ROUND: u64 = 33_000_000;
const OPEN_ROUND_SIG: &str =
    "a6d9f863b58d8f1ea7b6fd426feef2b43b22c912b89dce0bdd787ed2b04c703954aced716aba98ff2b4a22a83e48dd35";
const FAUCET_SEED: [u8; 32] = [0xfa; 32];

type R<T> = Result<T, String>;

fn one_leaf(cmx: ExtractedNoteCommitment) -> ([MerkleHashOrchard; 32], orchard::Anchor) {
    let siblings: [MerkleHashOrchard; 32] =
        core::array::from_fn(|i| MerkleHashOrchard::empty_root(Level::from(i as u8)));
    let anchor = MerklePath::from_parts(0, siblings).root(cmx);
    (siblings, anchor)
}

fn fund(net: &str, ufvk: &str, value: u64, height: u32) -> R<serde_json::Value> {
    let params = network(net).map_err(|e| e.to_string())?;
    let ufvk = UnifiedFullViewingKey::decode(&params, ufvk).map_err(|e| format!("{e:?}"))?;
    let fvk = ufvk.orchard().ok_or("the UFVK has no Orchard key")?.clone();
    let to = fvk.address_at(0u32, Scope::External);

    let faucet = Pocket::from_seed(&FAUCET_SEED, params.network_type().coin_type());
    let fee = cadence_wasm::installment_fee();
    let input = synthetic_note(net, &FAUCET_SEED, value + fee + 100_000).map_err(|e| e.to_string())?;
    let input_note = note::decode_hex(&input.note).map_err(|e| e.to_string())?;
    let inst = Installment {
        input: input_note,
        amount: Zatoshis::from_u64(value).map_err(|_| "bad value")?,
        merchant: to,
        memo: MemoBytes::empty(),
    };
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    let rung = build_rung(&params, BlockHeight::from_u32(height), &faucet, &inst, seed).map_err(|e| format!("{e:?}"))?;
    let pczt = hex::encode(rung.pczt.serialize().map_err(|e| format!("{e:?}"))?);
    let (siblings, anchor) = one_leaf(ExtractedNoteCommitment::from(input_note.commitment()));
    let path: Vec<String> = siblings.iter().map(|h| hex::encode(h.to_bytes())).collect();
    let tx = complete_and_prove(&pczt, &hex::encode(anchor.to_bytes()), 0, &path).map_err(|e| e.to_string())?;

    // What the pocket will see, and the one-leaf witness for its note.
    let bytes = hex::decode(&tx.tx_hex).map_err(|e| e.to_string())?;
    let parsed = Transaction::read(&bytes[..], BranchId::for_height(&params, BlockHeight::from_u32(height)))
        .map_err(|e| e.to_string())?;
    let bundle = parsed.ironwood_bundle().ok_or("no Ironwood bundle")?;
    let (_, _, pocket_note, _, _) = bundle
        .decrypt_outputs_with_keys(&[fvk.to_ivk(Scope::External)])
        .into_iter()
        .find(|(_, _, n, _, _)| n.recipient() == to)
        .ok_or("the transaction pays nothing to the pocket")?;
    let (siblings, anchor) = one_leaf(ExtractedNoteCommitment::from(pocket_note.commitment()));
    Ok(json!({
        "txid": tx.txid,
        "tx_hex": tx.tx_hex,
        "value_zat": pocket_note.value().inner(),
        "nullifier": hex::encode(pocket_note.nullifier(&fvk).to_bytes()),
        "witness": {
            "position": 0,
            "anchor": hex::encode(anchor.to_bytes()),
            "auth_path": siblings.iter().map(|h| hex::encode(h.to_bytes())).collect::<Vec<_>>(),
        },
    }))
}

fn open(identity: &str, sealed_file: &str) -> R<serde_json::Value> {
    let id: x25519::Identity = identity.trim().parse().map_err(|e: &str| e.to_string())?;
    let b64 = fs::read_to_string(sealed_file).map_err(|e| e.to_string())?;
    let sealed = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    let round = cadence_seal::header_round(&sealed).map_err(|e| e.to_string())?;
    if round != OPEN_ROUND {
        return Err(format!("sealed to round {round}; only {OPEN_ROUND} has a known beacon here"));
    }
    let plain = cadence_seal::open(&sealed, &id, &DrandChain::quicknet(), &hex::decode(OPEN_ROUND_SIG).unwrap())
        .map_err(|e| e.to_string())?;
    let ladder: InstallmentLadder = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    let mut sighashes = std::collections::BTreeSet::new();
    for r in &ladder.rungs {
        let p = Pczt::parse(&hex::decode(&r.pczt).map_err(|e| e.to_string())?).map_err(|e| format!("{e:?}"))?;
        let sighash = Signer::new(p.clone()).map_err(|e| format!("{e:?}"))?.shielded_sighash();
        for a in p.ironwood().actions() {
            let sig = a.spend().spend_auth_sig().ok_or("an unsigned action")?;
            let rk = VerificationKey::<SpendAuth>::try_from(*a.spend().rk()).map_err(|e| format!("{e:?}"))?;
            rk.verify(&sighash, &Signature::<SpendAuth>::from(sig))
                .map_err(|_| format!("bad signature in the rung at {}", r.target_height))?;
        }
        sighashes.insert(sighash);
    }
    Ok(json!({
        "round": round,
        "sealed_bytes": sealed.len(),
        "plaintext_bytes": plain.len(),
        "k": ladder.k,
        "amount_zat": ladder.amount_zat,
        "spends_nullifier": ladder.spends_nullifier,
        "rungs": ladder.rungs.len(),
        "first_height": ladder.rungs.first().map(|r| r.target_height),
        "last_height": ladder.rungs.last().map(|r| r.target_height),
        "distinct_sighashes": sighashes.len(),
        "all_signed": true,
    }))
}

fn inspect(net: &str, height: u32, tx_file: &str) -> R<serde_json::Value> {
    let params = network(net).map_err(|e| e.to_string())?;
    let hex_tx = fs::read_to_string(tx_file).map_err(|e| e.to_string())?;
    let bytes = hex::decode(hex_tx.trim()).map_err(|e| e.to_string())?;
    let tx = Transaction::read(&bytes[..], BranchId::for_height(&params, BlockHeight::from_u32(height)))
        .map_err(|e| e.to_string())?;
    let b = tx.ironwood_bundle();
    Ok(json!({
        "txid": tx.txid().to_string(),
        "version": format!("{:?}", tx.version()),
        "expiry_height": u32::from(tx.expiry_height()),
        "transparent": tx.transparent_bundle().is_some(),
        "sapling": tx.sapling_bundle().is_some(),
        "orchard": tx.orchard_bundle().is_some(),
        "ironwood_actions": b.map(|b| b.actions().len()),
        "ironwood_value_balance": b.map(|b| i64::from(*b.value_balance())),
        "ironwood_proof_bytes": b.map(|b| b.authorization().proof().as_ref().len()),
    }))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    let out = match a(0) {
        "age-identity" => {
            let id = x25519::Identity::generate();
            Ok(json!({ "identity": id.to_string().expose_secret(), "recipient": id.to_public().to_string() }))
        }
        "fund" => a(3)
            .parse()
            .map_err(|_| "value_zat".to_string())
            .and_then(|v| fund(a(1), a(2), v, a(4).parse().map_err(|_| "height")?)),
        "open" => open(a(1), a(2)),
        "inspect" => inspect(a(1), a(2).parse().unwrap_or(0), a(3)),
        _ => Err("usage: smoke_fixture age-identity | fund <net> <ufvk> <zat> <height> | open <identity> <file> | inspect <net> <height> <file>".into()),
    };
    match out {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("smoke_fixture: {e}");
            exit(1);
        }
    }
}
