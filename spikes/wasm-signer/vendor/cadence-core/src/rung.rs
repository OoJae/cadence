use core::convert::Infallible;

use orchard::{
    note::{ExtractedNoteCommitment, Note, NoteVersion, Rho},
    Address,
};
use pczt::{
    roles::{creator::Creator, io_finalizer::IoFinalizer, signer::Signer},
    Pczt,
};
use rand::{rngs::ChaCha20Rng, SeedableRng};
use zcash_primitives::transaction::{
    builder::{BundlePadding, DeferredPcztBuilder},
    fees::zip317::FeeRule,
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

use crate::Pocket;

/// One installment of a mandate, before it is laddered over broadcast heights.
#[derive(Clone)]
pub struct Installment {
    /// The pocket note this installment spends: the funding note for `k = 1`,
    /// otherwise the previous installment's change `C(k-1)`.
    pub input: Note,
    pub amount: Zatoshis,
    pub merchant: Address,
    pub memo: MemoBytes,
}

/// The public contents of one Ironwood action. These must not depend on the
/// rung's target height, or the rungs of an installment would diverge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionFingerprint {
    pub cv_net: [u8; 32],
    pub nf: [u8; 32],
    pub rk: [u8; 32],
    pub cmx: [u8; 32],
    pub epk: [u8; 32],
    pub enc_ciphertext: Vec<u8>,
    pub out_ciphertext: [u8; 80],
}

/// An installment signed for one candidate target height.
pub struct Rung {
    pub target_height: BlockHeight,
    pub expiry_height: BlockHeight,
    pub branch: BranchId,
    pub fee: Zatoshis,
    /// Signed and unproven, with its Ironwood anchor and spend witness deferred.
    pub pczt: Pczt,
    pub sighash: [u8; 32],
    /// Position of the real spend among the Ironwood actions.
    pub spend_action: usize,
    /// The change note `C(k)`, or `None` for the final installment.
    pub change: Option<Note>,
    pub actions: Vec<ActionFingerprint>,
}

#[derive(Debug)]
pub enum Error {
    Build(String),
    Value,
    MissingIronwoodBundle,
    MissingActionIndex,
    PcztCreate,
    IoFinalize(String),
    Sign(String),
    ChangeNote,
}

fn build_err<E: core::fmt::Debug>(e: E) -> Error {
    Error::Build(format!("{e:?}"))
}

/// Builds and signs installment `inst` for broadcast at exactly `target_height`.
///
/// `seed` drives every random choice the builder makes, so calling this with the
/// same seed at different heights yields byte-identical actions; only the expiry,
/// the consensus branch and therefore the sighash and signatures differ.
pub fn build_rung<P: Parameters + Clone>(
    params: &P,
    target_height: BlockHeight,
    pocket: &Pocket,
    inst: &Installment,
    seed: [u8; 32],
) -> Result<Rung, Error> {
    let fee_rule = FeeRule::standard();
    let mut builder = DeferredPcztBuilder::new::<Infallible>(
        params.clone(),
        target_height,
        BundlePadding::DEFAULT,
        BundlePadding::DEFAULT,
    )
    .map_err(build_err)?;
    builder
        .add_ironwood_spend::<Infallible>(pocket.fvk().clone(), inst.input)
        .map_err(build_err)?;
    builder
        .add_ironwood_output::<Infallible>(None, inst.merchant, inst.amount, inst.memo.clone())
        .map_err(build_err)?;

    // The bundle pads to two actions, so the change output does not alter the fee.
    let fee = builder.get_fee(&fee_rule).map_err(build_err)?;
    let input = Zatoshis::from_u64(inst.input.value().inner()).map_err(|_| Error::Value)?;
    let change = (input - inst.amount).and_then(|v| v - fee).ok_or(Error::Value)?;
    if !change.is_zero() {
        builder
            .add_ironwood_output::<Infallible>(
                None,
                pocket.change_address(),
                change,
                MemoBytes::empty(),
            )
            .map_err(build_err)?;
    }

    let res = builder
        .build_for_pczt(ChaCha20Rng::from_seed(seed), &fee_rule)
        .map_err(build_err)?;
    let expiry_height = res.pczt_parts.expiry_height;
    let branch = res.pczt_parts.consensus_branch_id;
    let bundle = res
        .pczt_parts
        .ironwood
        .as_ref()
        .ok_or(Error::MissingIronwoodBundle)?;
    let actions = bundle.actions().iter().map(fingerprint).collect();
    let spend_action = res
        .ironwood_meta
        .spend_action_index(0)
        .ok_or(Error::MissingActionIndex)?;
    let change_note = if change.is_zero() {
        None
    } else {
        let idx = res
            .ironwood_meta
            .output_action_index(1)
            .ok_or(Error::MissingActionIndex)?;
        Some(change_note(&bundle.actions()[idx])?)
    };

    let pczt = Creator::build_from_parts(res.pczt_parts).ok_or(Error::PcztCreate)?;
    let pczt = IoFinalizer::new(pczt)
        .finalize_io(rand::rng())
        .map_err(|e| Error::IoFinalize(format!("{e:?}")))?;
    let mut signer = Signer::new(pczt).map_err(|e| Error::Sign(format!("{e:?}")))?;
    let sighash = signer.shielded_sighash();
    signer
        .sign_ironwood(rand::rng(), spend_action, &pocket.ask())
        .map_err(|e| Error::Sign(format!("{e:?}")))?;

    Ok(Rung {
        target_height,
        expiry_height,
        branch,
        fee,
        pczt: signer.finish(),
        sighash,
        spend_action,
        change: change_note,
        actions,
    })
}

fn fingerprint(action: &orchard::pczt::Action) -> ActionFingerprint {
    let note = action.output().encrypted_note();
    ActionFingerprint {
        cv_net: action.cv_net().to_bytes(),
        nf: action.spend().nullifier().to_bytes(),
        rk: action.spend().rk().into(),
        cmx: action.output().cmx().to_bytes(),
        epk: note.epk_bytes,
        enc_ciphertext: note.enc_ciphertext.as_ref().to_vec(),
        out_ciphertext: note.out_ciphertext,
    }
}

/// Rebuilds the change note from its action. An output's `rho` is the nullifier
/// of the spend in the same action.
fn change_note(action: &orchard::pczt::Action) -> Result<Note, Error> {
    let output = action.output();
    let recipient = (*output.recipient()).ok_or(Error::ChangeNote)?;
    let value = (*output.value()).ok_or(Error::ChangeNote)?;
    let rseed = (*output.rseed()).ok_or(Error::ChangeNote)?;
    let rho = Option::from(Rho::from_bytes(&action.spend().nullifier().to_bytes()))
        .ok_or(Error::ChangeNote)?;
    let note: Note = Option::from(Note::from_parts(recipient, value, rho, rseed, NoteVersion::V3))
        .ok_or(Error::ChangeNote)?;
    if ExtractedNoteCommitment::from(note.commitment()) != *output.cmx() {
        return Err(Error::ChangeNote);
    }
    Ok(note)
}
