//! The browser signer's API, natively: sharding equivalence, note round trips,
//! sealing and the cancel.

use cadence_core::{build_rung, mandate, package::InstallmentLadder, seed, Installment, Pocket};
use cadence_seal::{age::x25519, DrandChain};
use cadence_wasm::{
    build_cancel, create_pocket, funding_total, installment_fee, note, open_kit, pocket_info, presign_shard, round_for,
    seal_installment, seal_kit, synthetic_note, window, ShardOut, ShardTerms,
};
use orchard::primitives::redpallas::{Signature, SpendAuth, VerificationKey};
use pczt::{
    roles::{redactor::Redactor, signer::Signer},
    Pczt,
};
use zcash_keys::address::Address;
use zcash_protocol::{
    consensus::{BlockHeight, Network, NetworkConstants, Parameters},
    value::Zatoshis,
};

const NET: &str = "test";
const SEED: [u8; 32] = [42u8; 32];
const MANDATE: [u8; 16] = [5u8; 16];
/// Testnet, past NU7.
const BASE: u32 = 4_529_300;
const AMOUNT: u64 = 20_000;

/// A quicknet round with a known beacon (from cadence-seal's tests).
const ROUND: u64 = 33_000_000;
const ROUND_SIG: &str = "a6d9f863b58d8f1ea7b6fd426feef2b43b22c912b89dce0bdd787ed2b04c703954aced716aba98ff2b4a22a83e48dd35";

fn params() -> Network {
    Network::TestNetwork
}

fn merchant_ua() -> String {
    pocket_info(NET, &[9u8; 32]).unwrap().ua
}

fn terms(count: u32) -> ShardTerms {
    ShardTerms { amount_zat: AMOUNT, count, merchant_ua: merchant_ua(), label: "Smoke plan (pkt_test)".into() }
}

fn heights(n: u32) -> Vec<u32> {
    (BASE..BASE + n).collect()
}

fn parse(pczt_hex: &str) -> Pczt {
    Pczt::parse(&hex::decode(pczt_hex).unwrap()).unwrap()
}

fn sighash(pczt_hex: &str) -> [u8; 32] {
    Signer::new(parse(pczt_hex)).unwrap().shielded_sighash()
}

/// The rung with every (randomized) spend authorization signature removed. What is
/// left is fully determined by the pocket, the installment, the seed and the height.
fn unsigned(pczt_hex: &str) -> Vec<u8> {
    Redactor::new(parse(pczt_hex))
        .redact_ironwood_with(|mut b| b.redact_actions(|mut a| a.clear_spend_auth_sig()))
        .finish()
        .serialize()
        .unwrap()
}

/// Every spend in the PCZT carries a valid spend authorization over its sighash.
fn assert_signed(pczt_hex: &str) {
    let p = parse(pczt_hex);
    let sighash = Signer::new(p.clone()).unwrap().shielded_sighash();
    for (i, a) in p.ironwood().actions().iter().enumerate() {
        let sig = a.spend().spend_auth_sig().unwrap_or_else(|| panic!("action {i} is unsigned"));
        let rk = VerificationKey::<SpendAuth>::try_from(*a.spend().rk()).unwrap();
        rk.verify(&sighash, &Signature::<SpendAuth>::from(sig)).unwrap_or_else(|_| panic!("action {i}: bad signature"));
    }
}

fn shard(input: &str, t: &ShardTerms, k: u32, hs: &[u32]) -> ShardOut {
    presign_shard(NET, &SEED, input, t, k, &MANDATE, hs).unwrap()
}

/// Signs `hs` in one call and in several shards of uneven size, and checks both
/// produce the same ladder.
fn assert_shards_agree(input: &str, t: &ShardTerms, k: u32, hs: &[u32]) -> ShardOut {
    let whole = shard(input, t, k, hs);
    let cuts = [0, 1, 6, hs.len() / 2 + 1, hs.len()];
    let parts: Vec<ShardOut> = cuts.windows(2).map(|w| shard(input, t, k, &hs[w[0]..w[1]])).collect();

    for p in &parts {
        assert_eq!(p.k, k);
        assert_eq!(p.spends_nullifier, whole.spends_nullifier);
        assert_eq!(p.actions_digest, whole.actions_digest);
        assert_eq!(p.change, whole.change);
    }
    let sharded: Vec<_> = parts.iter().flat_map(|p| p.rungs.iter()).collect();
    assert_eq!(sharded.len(), whole.rungs.len());
    for (a, b) in sharded.iter().zip(&whole.rungs) {
        assert_eq!(a.target_height, b.target_height);
        assert_eq!(a.expiry_height, b.expiry_height);
        assert_eq!(sighash(&a.pczt), sighash(&b.pczt), "sighash differs at {}", a.target_height);
        assert_eq!(unsigned(&a.pczt), unsigned(&b.pczt), "rung differs at {}", a.target_height);
        assert_signed(&a.pczt);
    }
    whole
}

#[test]
fn sharded_presign_equals_unsharded() {
    let count = 2;
    let total = funding_total(AMOUNT, count).unwrap();
    assert_eq!(total, 2 * (AMOUNT + installment_fee()));
    let funding = synthetic_note(NET, &SEED, total).unwrap();
    let t = terms(count);

    let k1 = assert_shards_agree(&funding.note, &t, 1, &heights(14));
    assert_eq!(k1.spends_nullifier, funding.nullifier);
    let c1 = k1.change.expect("installment 1 leaves change");
    assert_eq!(c1.value_zat, total - AMOUNT - installment_fee());

    // The final installment spends C(1) and empties the pocket.
    let k2 = assert_shards_agree(&c1.note, &t, 2, &heights(14));
    assert_eq!(k2.spends_nullifier, c1.nullifier);
    assert!(k2.change.is_none());
}

/// Each shard rung is what `cadence_core::mandate::presign` signs at that height:
/// the same seed derivation, memo (`installment_memo`), redaction and serialization.
#[test]
fn shards_match_cadence_core() {
    let params = params();
    let pocket = Pocket::from_seed(&SEED, params.network_type().coin_type());
    let count = 3;
    let funding = synthetic_note(NET, &SEED, funding_total(AMOUNT, count).unwrap()).unwrap();
    let t = terms(count);
    let k = 1;
    let hs = [BASE, BASE + 7];
    let out = shard(&funding.note, &t, k, &hs);

    let merchant = match Address::decode(&params, &t.merchant_ua) {
        Some(Address::Unified(ua)) => *ua.orchard().unwrap(),
        _ => unreachable!(),
    };
    let inst = Installment {
        input: note::decode_hex(&funding.note).unwrap(),
        amount: Zatoshis::const_from_u64(AMOUNT),
        merchant,
        memo: mandate::installment_memo(&t.label, k, count),
    };
    let s = seed::rung_seed(&seed::app_secret(&pocket), &MANDATE, k, 0);
    for (h, pkg) in hs.iter().zip(&out.rungs) {
        let rung = build_rung(&params, BlockHeight::from_u32(*h), &pocket, &inst, s).unwrap();
        let reference = hex::encode(cadence_core::package::redact_for_runner(rung.pczt).serialize().unwrap());
        assert_eq!(pkg.target_height, *h);
        assert_eq!(pkg.expiry_height, u32::from(rung.expiry_height));
        assert_eq!(sighash(&pkg.pczt), rung.sighash);
        assert_eq!(unsigned(&pkg.pczt), unsigned(&reference));
        assert_eq!(out.change.as_ref().unwrap().note, note::encode_hex(&rung.change.unwrap()));
    }
}

#[test]
fn exhausted_pocket_is_refused_before_the_last_installment() {
    // Funded for two installments, asked for three.
    let funding = synthetic_note(NET, &SEED, funding_total(AMOUNT, 2).unwrap()).unwrap();
    let t = terms(3);
    let c1 = shard(&funding.note, &t, 1, &[BASE]).change.unwrap();
    let err = presign_shard(NET, &SEED, &c1.note, &t, 2, &MANDATE, &[BASE]).unwrap_err();
    assert!(err.to_string().contains("exhausted"), "{err}");
}

#[test]
fn presign_refuses_foreign_notes_and_bad_input() {
    let other = synthetic_note(NET, &[1u8; 32], 100_000).unwrap();
    let t = terms(2);
    assert!(presign_shard(NET, &SEED, &other.note, &t, 1, &MANDATE, &[BASE]).is_err());
    let mine = synthetic_note(NET, &SEED, 100_000).unwrap();
    assert!(presign_shard(NET, &SEED, &mine.note, &t, 1, &MANDATE, &[]).is_err());
    assert!(presign_shard(NET, &SEED, &mine.note, &t, 3, &MANDATE, &[BASE]).is_err());
    assert!(presign_shard("main", &SEED, &mine.note, &t, 1, &MANDATE, &[BASE]).is_err(), "testnet merchant on mainnet");
    assert!(presign_shard(NET, &SEED[..31], &mine.note, &t, 1, &MANDATE, &[BASE]).is_err());
}

#[test]
fn note_encoding_round_trips() {
    let funding = synthetic_note(NET, &SEED, 123_456).unwrap();
    let n = note::decode_hex(&funding.note).unwrap();
    assert_eq!(note::encode_hex(&n), funding.note);
    assert_eq!(funding.note.len(), 2 * note::NOTE_LEN);
    assert_eq!(n.value().inner(), 123_456);
    assert_eq!(n.version(), orchard::NoteVersion::V3);
    let pocket = Pocket::from_seed(&SEED, params().network_type().coin_type());
    assert_eq!(n.recipient(), pocket.funding_address());
    assert_eq!(hex::encode(n.nullifier(pocket.fvk()).to_bytes()), funding.nullifier);

    // A real change note (internal receiver, rho from the spend) round-trips too.
    let t = terms(2);
    let c = shard(&synthetic_note(NET, &SEED, 60_000).unwrap().note, &t, 1, &[BASE]).change.unwrap();
    let cn = note::decode_hex(&c.note).unwrap();
    assert_eq!(note::encode_hex(&cn), c.note);
    assert_eq!(cn.recipient(), pocket.change_address());

    let mut bytes = hex::decode(&funding.note).unwrap();
    assert!(note::decode(&bytes[..115]).is_err());
    bytes[0] = 0x04;
    assert!(note::decode(&bytes).is_err(), "unknown version");
    let mut bytes = hex::decode(&funding.note).unwrap();
    bytes[52..84].copy_from_slice(&[0xff; 32]);
    assert!(note::decode(&bytes).is_err(), "non-canonical rho");
    assert!(note::decode_hex("zz").is_err());
}

#[test]
fn pockets_are_fresh_and_view_only() {
    let a = create_pocket(NET).unwrap();
    let b = create_pocket(NET).unwrap();
    assert_ne!(a.seed_hex, b.seed_hex);
    assert!(a.ua.starts_with("utest1"));
    assert!(a.ufvk.starts_with("uviewtest1"));
    let again = pocket_info(NET, &hex::decode(a.seed_hex.as_ref().unwrap()).unwrap()).unwrap();
    assert_eq!((again.ua, again.ufvk, again.seed_hex), (a.ua, a.ufvk, None));
    assert!(create_pocket("main").unwrap().ua.starts_with("u1"));
    assert!(create_pocket("regtest").is_err());
}

#[test]
fn schedule_helpers_match_the_engine() {
    let p = params();
    let w = window(NET, BASE, 1_000, 1_000 + 600).unwrap();
    let core: Vec<u32> = mandate::window(&p, BlockHeight::from_u32(BASE), 1_000, 1_600).into_iter().map(u32::from).collect();
    assert_eq!(w, core);
    assert!(w.len() > 150 && w[0] > BASE);
    // quicknet: genesis 1692803367, 3 s rounds.
    assert_eq!(round_for(1_692_803_367), 1);
    assert_eq!(round_for(1_692_803_368), 2);
    assert_eq!(round_for(1_692_803_370), 2);
    assert_eq!(round_for(1_692_803_371), 3);
    assert_eq!(installment_fee(), 10_000);
}

#[test]
fn sealed_installment_opens_to_the_same_ladder() {
    let funding = synthetic_note(NET, &SEED, funding_total(AMOUNT, 1).unwrap()).unwrap();
    let out = shard(&funding.note, &terms(1), 1, &heights(3));
    let ladder = InstallmentLadder { k: 1, amount_zat: AMOUNT, spends_nullifier: out.spends_nullifier.clone(), rungs: out.rungs };
    let json = serde_json::to_string(&ladder).unwrap();

    let id = x25519::Identity::generate();
    let recipient = id.to_public().to_string();
    let sealed = seal_installment(&json, &recipient, ROUND).unwrap();
    assert!(cadence_seal::BUCKETS.contains(&sealed.sealed_bytes));
    assert_eq!(sealed.round, ROUND);
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&sealed.sealed).unwrap();
    assert_eq!(bytes.len(), sealed.sealed_bytes);
    assert_eq!(cadence_seal::header_round(&bytes).unwrap(), ROUND);

    let opened = cadence_seal::open(&bytes, &id, &DrandChain::quicknet(), &hex::decode(ROUND_SIG).unwrap()).unwrap();
    assert_eq!(opened.len(), sealed.plaintext_bytes);
    let back: InstallmentLadder = serde_json::from_slice(&opened).unwrap();
    assert_eq!(serde_json::to_string(&back).unwrap(), json);

    // Malformed ladders and recipients are refused before sealing.
    assert!(seal_installment("{}", &recipient, ROUND).is_err());
    assert!(seal_installment(&json, "age1notarecipient", ROUND).is_err());
    assert!(seal_installment(&json, &recipient, 0).is_err());
    let mut unordered = serde_json::from_str::<InstallmentLadder>(&json).unwrap();
    unordered.rungs.reverse();
    assert!(seal_installment(&serde_json::to_string(&unordered).unwrap(), &recipient, ROUND).is_err());
}

#[test]
fn cancel_builds_and_signs() {
    let p = params();
    let pocket = Pocket::from_seed(&SEED, p.network_type().coin_type());
    let live = synthetic_note(NET, &SEED, 60_000).unwrap();
    let refund_ua = pocket_info(NET, &[3u8; 32]).unwrap().ua;
    let refund = match Address::decode(&p, &refund_ua) {
        Some(Address::Unified(ua)) => *ua.orchard().unwrap(),
        _ => unreachable!(),
    };

    let c = build_cancel(NET, &SEED, &live.note, &refund_ua, BASE + 1).unwrap();
    assert_eq!(c.fee_zat, 10_000);
    assert_eq!(c.refunded_zat, 50_000);
    assert_eq!(c.spends_nullifier, live.nullifier);
    assert_eq!(c.target_height, BASE + 1);
    assert!(c.expiry_height > c.target_height);
    assert_signed(&c.pczt);

    // A standard two-action send: the refund, plus a dummy; no change to the pocket.
    let pczt = parse(&c.pczt);
    let actions = pczt.ironwood().actions();
    assert_eq!(actions.len(), 2);
    let outputs: Vec<_> = actions.iter().map(|a| (*a.output().recipient(), *a.output().value())).collect();
    assert!(outputs.contains(&(Some(refund.to_raw_address_bytes()), Some(50_000))));
    for (r, v) in &outputs {
        let r = r.unwrap();
        assert_ne!(r, pocket.change_address().to_raw_address_bytes());
        assert!(*v == Some(50_000) || *v == Some(0));
    }
    // The real spend's witness is deferred for the prover.
    assert_eq!(actions.iter().filter(|a| a.spend().witness().is_none()).count(), 1);
    assert_eq!(*pczt.ironwood().anchor(), None);

    // Fresh randomness per cancel.
    let again = build_cancel(NET, &SEED, &live.note, &refund_ua, BASE + 1).unwrap();
    assert_ne!(unsigned(&again.pczt), unsigned(&c.pczt));
}

/// From mainnet's ZIP 2009 switch, the cancel pays the lower fee at its own height,
/// so it still spends the whole note and leaves no change.
#[test]
fn cancel_pays_the_fee_at_its_height() {
    use zcash_protocol::consensus::NetworkUpgrade;
    let main = Network::MainNetwork;
    let Some(nu7) = main.activation_height(NetworkUpgrade::Nu7) else {
        return; // No mainnet Ironwood in this build of zcash_protocol.
    };
    let h = u32::from(nu7).max(mandate::MAINNET_FEE_SWITCH) + 10;
    let live = synthetic_note("main", &SEED, 60_000).unwrap();
    let refund_ua = pocket_info("main", &[3u8; 32]).unwrap().ua;
    let c = build_cancel("main", &SEED, &live.note, &refund_ua, h).unwrap();
    assert_eq!(c.fee_zat, 2_000);
    assert_eq!(c.refunded_zat, 58_000);
    assert_signed(&c.pczt);
    // Funding still covers the higher fee.
    assert_eq!(installment_fee(), 10_000);
}

#[test]
fn cancel_refuses_bad_refund_addresses_and_empty_pockets() {
    let p = params();
    let live = synthetic_note(NET, &SEED, 60_000).unwrap();
    let own = pocket_info(NET, &SEED).unwrap().ua;
    let err = build_cancel(NET, &SEED, &live.note, &own, BASE).unwrap_err();
    assert!(err.to_string().contains("not to the pocket"), "{err}");

    let transparent = Address::Transparent(zcash_transparent::address::TransparentAddress::PublicKeyHash([7; 20])).encode(&p);
    let err = build_cancel(NET, &SEED, &live.note, &transparent, BASE).unwrap_err();
    assert!(err.to_string().contains("Orchard receiver"), "{err}");

    let mainnet_ua = pocket_info("main", &[3u8; 32]).unwrap().ua;
    assert!(build_cancel(NET, &SEED, &live.note, &mainnet_ua, BASE).is_err());
    assert!(build_cancel(NET, &SEED, &live.note, "utest1garbage", BASE).is_err());

    let dust = synthetic_note(NET, &SEED, 10_000).unwrap();
    let refund_ua = pocket_info(NET, &[3u8; 32]).unwrap().ua;
    let err = build_cancel(NET, &SEED, &dust.note, &refund_ua, BASE).unwrap_err();
    assert!(err.to_string().contains("nothing is left"), "{err}");
}

/// The page's cancel key: an age scrypt file the CLI's `read_kit` opens.
#[test]
fn recovery_kit_round_trips_and_refuses_bad_input() {
    let kit = format!("{{\"network\":\"test\",\"seed_hex\":\"{}\"}}", hex::encode(SEED));
    let sealed = seal_kit(&kit, "correct horse battery").unwrap();
    assert!(cadence_seal::is_sealed_kit(&sealed));
    assert_eq!(open_kit(&sealed, "correct horse battery").unwrap(), kit);
    // What the CLI does with it.
    assert_eq!(cadence_seal::open_kit(&sealed, "correct horse battery").unwrap(), kit.as_bytes());

    assert!(open_kit(&sealed, "wrong horse battery").unwrap_err().to_string().contains("wrong passphrase"));
    assert!(seal_kit(&kit, "short").unwrap_err().to_string().contains("at least 8"));
    assert!(seal_kit("[1, 2]", "correct horse battery").is_err());
    assert!(open_kit(kit.as_bytes(), "correct horse battery").unwrap_err().to_string().contains("not an encrypted"));
}

/// The whole pipeline the page runs (window per installment, shards of uneven
/// size, change chaining) against `cadence_core::mandate::presign` itself, over
/// full windows. About 660 rungs: run with
/// `cargo test -p cadence-wasm --release -- --ignored`.
#[test]
#[ignore = "signs ~660 rungs; run in release"]
fn sharded_pipeline_equals_mandate_presign() {
    let params = params();
    let pocket = Pocket::from_seed(&SEED, params.network_type().coin_type());
    let count = 2;
    let funding = synthetic_note(NET, &SEED, funding_total(AMOUNT, count).unwrap()).unwrap();
    let t = terms(count);
    let (tip, now, first_release_at, period) = (BASE, 1_800_000_000u64, 1_800_000_060u64, 600u64);
    let merchant = match Address::decode(&params, &t.merchant_ua) {
        Some(Address::Unified(ua)) => *ua.orchard().unwrap(),
        _ => unreachable!(),
    };
    let core_terms = mandate::Terms {
        amount: Zatoshis::const_from_u64(AMOUNT),
        count,
        period_secs: period,
        release_times: (0..u64::from(count)).map(|i| first_release_at + i * period).collect(),
        merchant,
        label: t.label.clone(),
    };
    let reference = mandate::presign(
        &params,
        &pocket,
        note::decode_hex(&funding.note).unwrap(),
        &core_terms,
        BlockHeight::from_u32(tip),
        now,
        MANDATE,
        |_, _, _| {},
    )
    .unwrap();
    assert_eq!(reference.len(), count as usize);

    let mut input = funding.note.clone();
    for r in &reference {
        let k = r.k;
        let hs = window(NET, tip, now, core_terms.release_at(k)).unwrap();
        let chunks: Vec<&[u32]> = hs.chunks(23).collect();
        let parts: Vec<ShardOut> = chunks.iter().map(|c| shard(&input, &t, k, c)).collect();
        let rungs: Vec<_> = parts.iter().flat_map(|p| p.rungs.iter()).collect();
        assert_eq!(rungs.len(), r.ladder.rungs.len());
        for p in &parts {
            assert_eq!(p.spends_nullifier, r.ladder.spends_nullifier);
            assert_eq!(p.change, parts[0].change);
        }
        for (a, b) in rungs.iter().zip(&r.ladder.rungs) {
            assert_eq!((a.target_height, a.expiry_height), (b.target_height, b.expiry_height));
            assert_eq!(sighash(&a.pczt), sighash(&b.pczt));
            assert_eq!(unsigned(&a.pczt), unsigned(&b.pczt));
        }
        if let Some(c) = &parts[0].change {
            input = c.note.clone();
        }
    }
}

/// Proves a cancel against a self-consistent single-leaf tree (the note at
/// position 0, every sibling the empty subtree root), as the spike did. The
/// anchor is not an on-chain root, but the proving work is a real two-action
/// Ironwood spend, and extraction verifies the proof and every signature.
#[cfg(feature = "prover")]
#[test]
#[cfg_attr(debug_assertions, ignore = "proving is very slow in debug; run with --release --features prover")]
fn cancel_proves_and_extracts() {
    use incrementalmerkletree::{Hashable, Level};
    use orchard::{note::ExtractedNoteCommitment, tree::{MerkleHashOrchard, MerklePath}};

    let live = synthetic_note(NET, &SEED, 60_000).unwrap();
    let refund_ua = pocket_info(NET, &[3u8; 32]).unwrap().ua;
    let c = build_cancel(NET, &SEED, &live.note, &refund_ua, BASE + 1).unwrap();

    let siblings: [MerkleHashOrchard; 32] = core::array::from_fn(|i| MerkleHashOrchard::empty_root(Level::from(i as u8)));
    let cmx = ExtractedNoteCommitment::from(note::decode_hex(&live.note).unwrap().commitment());
    let anchor = MerklePath::from_parts(0, siblings).root(cmx);
    let path: Vec<String> = siblings.iter().map(|h| hex::encode(h.to_bytes())).collect();

    let proved = cadence_wasm::prove::complete_and_prove(&c.pczt, &hex::encode(anchor.to_bytes()), 0, &path).unwrap();
    assert_eq!(proved.txid.len(), 64);
    let tx = zcash_primitives::transaction::Transaction::read(
        &hex::decode(&proved.tx_hex).unwrap()[..],
        zcash_protocol::consensus::BranchId::for_height(&params(), BlockHeight::from_u32(BASE + 1)),
    )
    .unwrap();
    assert_eq!(tx.txid().to_string(), proved.txid);
    assert_eq!(tx.ironwood_bundle().unwrap().actions().len(), 2);

    // A wrong position is caught by verification, not by the network.
    assert!(cadence_wasm::prove::complete_and_prove(&c.pczt, &hex::encode(anchor.to_bytes()), 1, &path).is_err());
}
