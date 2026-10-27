//! What a rung shows beyond its payment: `redact_for_runner` strips the wallet
//! metadata a Constructor or Updater may attach, and no output of an installment or
//! a cancel can be read back with an outgoing viewing key (spec P3, Discard).

use core::convert::Infallible;

use cadence_core::{
    build_rung, mandate::installment_fee_at, package::redact_for_runner, rung::fee_rule_at, seed, Installment, Pocket,
};
use orchard::{
    keys::{OutgoingViewingKey, Scope},
    note::{Note, NoteVersion, RandomSeed, Rho},
    pczt::Zip32Derivation,
    value::NoteValue,
    Address,
};
use pczt::{
    roles::{creator::Creator, io_finalizer::IoFinalizer, updater::Updater, verifier::Verifier},
    Pczt,
};
use rand::{rngs::ChaCha20Rng, SeedableRng};
use zcash_primitives::transaction::builder::{BundlePadding, DeferredPcztBuilder};
use zcash_protocol::{
    consensus::{BlockHeight, MainNetwork, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

const POCKET_SEED: [u8; 32] = [42u8; 32];
const NU7_MAINNET: u32 = 3_543_405;

/// A stand-in for the funding note F, as in the S1 tests; nothing here is proven.
fn funding_note(pocket: &Pocket, value: u64) -> Note {
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

fn fixture() -> (MainNetwork, Pocket, Installment) {
    let params = MainNetwork;
    let pocket = Pocket::from_seed(&POCKET_SEED, params.network_type().coin_type());
    let merchant = Pocket::from_seed(&[9u8; 32], params.network_type().coin_type()).funding_address();
    let inst = Installment {
        input: funding_note(&pocket, 100_000),
        amount: Zatoshis::const_from_u64(20_000),
        merchant,
        memo: MemoBytes::from_bytes(b"cadence:test:k=1").unwrap(),
    };
    (params, pocket, inst)
}

fn rung_seed(pocket: &Pocket, k: u32) -> [u8; 32] {
    seed::rung_seed(&seed::app_secret(pocket), &[1u8; 16], k, 0)
}

/// The payer's cancel, as `cadence-wasm`'s `build_cancel` and the CLI's cancel build
/// it: the whole live note less the fee, to the payer's own address, with no memo.
fn cancel(params: &MainNetwork, pocket: &Pocket, live: Note, target: BlockHeight) -> Pczt {
    let refund = Pocket::from_seed(&[3u8; 32], params.network_type().coin_type()).funding_address();
    let fee = u64::from(installment_fee_at(params, target));
    let amount = Zatoshis::from_u64(live.value().inner() - fee).unwrap();
    let inst = Installment { input: live, amount, merchant: refund, memo: MemoBytes::empty() };
    let rung = build_rung(params, target, pocket, &inst, [6u8; 32]).unwrap();
    assert!(rung.change.is_none(), "a cancel spends the whole note");
    rung.pczt
}

/// Every transaction shape Cadence signs: an installment with change, on either side
/// of NU7, the final installment (payment and padding) and the cancel. Installments are
/// redacted, as `presign` hands them to the runner; the cancel is proven in the
/// payer's browser, so it never is.
fn shapes(params: &MainNetwork, pocket: &Pocket, inst: &Installment) -> Vec<(&'static str, Pczt)> {
    let at = |h: u32| BlockHeight::from_u32(h);
    let k1 = build_rung(params, at(3_530_000), pocket, inst, rung_seed(pocket, 1)).unwrap();
    let after_nu7 = build_rung(params, at(NU7_MAINNET + 1), pocket, inst, rung_seed(pocket, 1)).unwrap();
    let last = Installment { input: k1.change.unwrap(), amount: Zatoshis::const_from_u64(70_000 - 10_000), ..inst.clone() };
    let last = build_rung(params, at(3_530_010), pocket, &last, rung_seed(pocket, 2)).unwrap();
    assert!(last.change.is_none());
    vec![
        ("installment with change", redact_for_runner(k1.pczt)),
        ("installment after NU7", redact_for_runner(after_nu7.pczt)),
        ("final installment", redact_for_runner(last.pczt)),
        ("cancel", cancel(params, pocket, inst.input, at(3_530_020))),
    ]
}

/// Runs `f` over the PCZT's parsed Ironwood bundle, where every field has a getter.
fn with_ironwood<T>(pczt: &Pczt, f: impl FnOnce(&orchard::pczt::Bundle) -> T) -> T {
    let mut out = None;
    Verifier::new(pczt.clone())
        .with_ironwood::<Infallible, _>(|bundle| {
            out = Some(f(bundle));
            Ok(())
        })
        .expect("the Ironwood bundle parses");
    out.unwrap()
}

/// The fields `redact_for_runner` must clear that are still set.
fn leftovers(pczt: &Pczt) -> Vec<String> {
    let mut left = vec![];
    if !pczt.global().proprietary().is_empty() {
        left.push("global proprietary".to_string());
    }
    with_ironwood(pczt, |bundle| {
        for (i, a) in bundle.actions().iter().enumerate() {
            let (spend, output) = (a.spend(), a.output());
            for (field, set) in [
                ("spend zip32_derivation", spend.zip32_derivation().is_some()),
                ("spend proprietary", !spend.proprietary().is_empty()),
                ("output zip32_derivation", output.zip32_derivation().is_some()),
                ("output ock", output.ock().is_some()),
                ("output user_address", output.user_address().is_some()),
                ("output proprietary", !output.proprietary().is_empty()),
            ] {
                if set {
                    left.push(format!("action {i}: {field}"));
                }
            }
        }
    });
    left
}

/// What a stock wallet acting as Updater may attach: the pocket's ZIP 32 path with
/// the seed fingerprint, the merchant's address string and proprietary fields.
fn with_wallet_metadata(pczt: Pczt, coin_type: u32) -> Pczt {
    let fingerprint = zip32::fingerprint::SeedFingerprint::from_seed(&POCKET_SEED).unwrap().to_bytes();
    let path = || {
        let hardened = |i: u32| i | (1 << 31);
        Zip32Derivation::parse(fingerprint, vec![hardened(32), hardened(coin_type), hardened(7)]).unwrap()
    };
    Updater::new(pczt)
        .update_global_with(|mut g| g.set_proprietary("wallet:global".into(), b"g".to_vec()))
        .update_ironwood_with(|mut u| {
            for i in 0..u.bundle().actions().len() {
                u.update_action_with(i, |mut a| {
                    a.set_spend_zip32_derivation(path());
                    a.set_spend_proprietary("wallet:spend".into(), b"s".to_vec());
                    a.set_output_zip32_derivation(path());
                    a.set_output_user_address("u1merchant".into());
                    a.set_output_proprietary("wallet:output".into(), b"o".to_vec());
                    Ok(())
                })?;
            }
            Ok(())
        })
        .unwrap()
        .finish()
}

#[test]
fn redaction_strips_every_wallet_field_and_keeps_what_proving_needs() {
    let (params, pocket, inst) = fixture();
    let coin_type = params.network_type().coin_type();

    // Cadence's own builder attaches none of it, so even an unredacted cancel carries none.
    for (name, pczt) in shapes(&params, &pocket, &inst) {
        assert_eq!(leftovers(&pczt), Vec::<String>::new(), "{name}");
    }

    let rung = build_rung(&params, BlockHeight::from_u32(3_530_000), &pocket, &inst, rung_seed(&pocket, 1)).unwrap();
    let filled = with_wallet_metadata(rung.pczt, coin_type);
    // The global map, then five fields on each of the two actions. No public API sets
    // `ock` (orchard's builder always leaves it `None`), so it is only checked after.
    assert_eq!(leftovers(&filled).len(), 1 + 2 * 5, "{:?}", leftovers(&filled));

    let redacted = redact_for_runner(filled);
    assert_eq!(leftovers(&redacted), Vec::<String>::new());
    assert!(redacted.global().proprietary().is_empty());

    // The runner still has the FVK, alpha, rcv and note plaintexts it proves with.
    with_ironwood(&redacted, |bundle| {
        let spend = &bundle.actions()[rung.spend_action];
        assert!(spend.spend().fvk().is_some() && spend.spend().alpha().is_some());
        for a in bundle.actions() {
            assert!(a.rcv().is_some());
            let o = a.output();
            assert!(o.recipient().is_some() && o.value().is_some() && o.rseed().is_some());
        }
    });
}

/// Every output of `pczt` that one of `ovks` recovers, by sender-side decryption
/// (protocol § 4.20.3) of the action's `out_ciphertext` with its `cv_net`, `cmx` and
/// `epk`, all fixed before proving: (action, note, recipient, memo).
fn recovered(pczt: &Pczt, ovks: &[OutgoingViewingKey]) -> Vec<(usize, Note, Address, [u8; 512])> {
    with_ironwood(pczt, |bundle| {
        let version = *bundle.bundle_version();
        let mut found = vec![];
        for (i, action) in bundle.actions().iter().enumerate() {
            for ovk in ovks {
                let out = action.recover_output_with_ovk(ovk, version).expect("Ironwood v3 has a note encryption domain");
                if let Some((note, to, memo)) = out {
                    found.push((i, note, to, memo));
                    break;
                }
            }
        }
        found
    })
}

/// The zero OVK, which anyone can try, and both of the pocket's own.
fn ovks(pocket: &Pocket) -> [OutgoingViewingKey; 3] {
    [
        OutgoingViewingKey::from([0u8; 32]),
        pocket.fvk().to_ovk(Scope::External),
        pocket.fvk().to_ovk(Scope::Internal),
    ]
}

#[test]
fn no_output_is_recoverable_with_the_zero_or_a_pocket_ovk() {
    let (params, pocket, inst) = fixture();
    let ovks = ovks(&pocket);
    for (name, pczt) in shapes(&params, &pocket, &inst) {
        assert_eq!(with_ironwood(&pczt, |b| b.actions().len()), 2, "{name}");
        let found = recovered(&pczt, &ovks);
        assert!(found.is_empty(), "{name}: actions {:?} are recoverable", found.iter().map(|f| f.0).collect::<Vec<_>>());
    }
}

/// The installment `build_rung` would sign at `target`, but with the given OVKs on
/// its payment and change instead of `None`.
fn build_with_ovks(
    params: &MainNetwork,
    target: BlockHeight,
    pocket: &Pocket,
    inst: &Installment,
    payment_ovk: Option<OutgoingViewingKey>,
    change_ovk: Option<OutgoingViewingKey>,
) -> Pczt {
    let fee_rule = fee_rule_at(params, target);
    let mut b = DeferredPcztBuilder::new::<Infallible>(*params, target, BundlePadding::DEFAULT, BundlePadding::DEFAULT).unwrap();
    b.add_ironwood_spend::<Infallible>(pocket.fvk().clone(), inst.input).unwrap();
    b.add_ironwood_output::<Infallible>(payment_ovk, inst.merchant, inst.amount, inst.memo.clone()).unwrap();
    let fee = b.get_fee(&fee_rule).unwrap();
    let input = Zatoshis::from_u64(inst.input.value().inner()).unwrap();
    let change = (input - inst.amount).and_then(|v| v - fee).unwrap();
    b.add_ironwood_output::<Infallible>(change_ovk, pocket.change_address(), change, MemoBytes::empty()).unwrap();
    let res = b.build_for_pczt(ChaCha20Rng::from_seed(rung_seed(pocket, 1)), &fee_rule).unwrap();
    let pczt = Creator::build_from_parts(res.pczt_parts).unwrap();
    IoFinalizer::new(pczt).finalize_io(rand::rng()).unwrap()
}

#[test]
fn the_ovk_check_finds_outputs_that_were_built_with_an_ovk() {
    let (params, pocket, inst) = fixture();
    let target = BlockHeight::from_u32(3_530_000);
    let [zero, external, internal] = ovks(&pocket);
    let all = [zero.clone(), external.clone(), internal.clone()];

    // A stock wallet's default policy: the payment under the external OVK, the change
    // under the internal one. Both come back, and say exactly what was sent.
    let sender = build_with_ovks(&params, target, &pocket, &inst, Some(external), Some(internal));
    let found = recovered(&sender, &all);
    assert_eq!(found.len(), 2);
    let payment = found.iter().find(|f| f.2 == inst.merchant).expect("the payment is recovered");
    assert_eq!(payment.1.value().inner(), 20_000);
    assert_eq!(&payment.3, inst.memo.as_array());
    let change = found.iter().find(|f| f.2 == pocket.change_address()).expect("the change is recovered");
    assert_eq!(change.1.value().inner(), 100_000 - 20_000 - 10_000);
    // Redaction leaves the ciphertexts alone, so checking redacted rungs is no weaker.
    assert_eq!(recovered(&redact_for_runner(sender), &all).len(), 2);

    // The zero OVK alone recovers an output built under it.
    let zero_built = build_with_ovks(&params, target, &pocket, &inst, Some(zero.clone()), None);
    let found = recovered(&zero_built, &[zero]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].2, inst.merchant);

    // The same builder with no OVK, as `build_rung` calls it, gives nothing back.
    assert!(recovered(&build_with_ovks(&params, target, &pocket, &inst, None, None), &all).is_empty());
}
