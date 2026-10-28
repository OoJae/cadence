//! What the payer uploads to the merchant's runner, and the redaction applied first.

use pczt::{roles::redactor::Redactor, Pczt};
use serde::{Deserialize, Serialize};

/// Strips everything the runner does not need to prove and broadcast: ZIP 32
/// derivation paths (and with them the seed fingerprint), outgoing cipher keys,
/// user-facing address strings and proprietary fields. ZIP 374's "Privacy
/// Implications" asks Constructors to redact before handing a PCZT to a Prover.
///
/// What remains (FVK, `alpha`, `rcv`, note plaintexts) is exactly what proving needs.
pub fn redact_for_runner(pczt: Pczt) -> Pczt {
    Redactor::new(pczt)
        .redact_global_with(|mut global| global.clear_proprietary())
        .redact_ironwood_with(|mut bundle| {
            bundle.redact_actions(|mut action| {
                action.clear_spend_zip32_derivation();
                action.clear_spend_proprietary();
                action.clear_output_zip32_derivation();
                action.clear_output_ock();
                action.clear_output_user_address();
                action.clear_output_proprietary();
            })
        })
        .finish()
}

/// A mandate's full pre-signed schedule, as handed to the runner.
#[derive(Serialize, Deserialize)]
pub struct Ladder {
    pub network: String,
    pub mandate_id: String,
    pub installments: Vec<InstallmentLadder>,
}

#[derive(Serialize, Deserialize)]
pub struct InstallmentLadder {
    pub k: u32,
    pub amount_zat: u64,
    /// Nullifier of the pocket note this installment spends. If it is spent by any
    /// other transaction, the payer has cancelled.
    pub spends_nullifier: String,
    pub rungs: Vec<RungPackage>,
}

/// One rung: the installment signed for broadcast at exactly `target_height`.
#[derive(Serialize, Deserialize)]
pub struct RungPackage {
    pub target_height: u32,
    pub expiry_height: u32,
    pub pczt: String,
}

/// Checks a rung before it is ever broadcast: it must pay exactly `amount` to
/// `merchant`, and carry exactly the branch, expiry and lock time a fresh send
/// targeting `target` would. A payer could otherwise seal validly signed
/// installments that pay someone else, or that are fingerprintable.
pub fn verify_rung<P: zcash_protocol::consensus::Parameters>(
    params: &P,
    pczt: &Pczt,
    merchant: &orchard::Address,
    amount: u64,
    target: zcash_protocol::consensus::BlockHeight,
) -> Result<(), String> {
    use orchard::note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho};
    use zcash_primitives::transaction::builder::default_tx_expiry_delta;
    use zcash_protocol::consensus::BranchId;

    let global = pczt.global();
    let branch = BranchId::for_height(params, target);
    if *global.consensus_branch_id() != u32::from(branch) {
        return Err(format!("signed for branch {:08x}, but height {target} is {:08x}", global.consensus_branch_id(), u32::from(branch)));
    }
    let expiry = u32::from(target) + default_tx_expiry_delta(branch);
    if *global.expiry_height() != expiry {
        return Err(format!("expiry {} is not the default {expiry} for target {target}", global.expiry_height()));
    }
    if global.fallback_lock_time().unwrap_or(0) != 0 {
        return Err("non-zero lock time".into());
    }
    if !pczt.transparent().inputs().is_empty()
        || !pczt.transparent().outputs().is_empty()
        || !pczt.sapling().spends().is_empty()
        || !pczt.sapling().outputs().is_empty()
        || !pczt.orchard().actions().is_empty()
    {
        return Err("an installment must be Ironwood-only".into());
    }

    let merchant_bytes = merchant.to_raw_address_bytes();
    let pays = pczt.ironwood().actions().iter().any(|action| {
        let out = action.output();
        if out.recipient().as_ref() != Some(&merchant_bytes) || *out.value() != Some(amount) {
            return false;
        }
        // The plaintext fields must be the note the action actually commits to.
        let note = (|| {
            let recipient = Option::from(orchard::Address::from_raw_address_bytes(&merchant_bytes))?;
            let rho = Option::from(Rho::from_bytes(action.spend().nullifier()))?;
            let rseed = Option::from(RandomSeed::from_bytes((*out.rseed())?, &rho))?;
            let note: Note = Option::from(Note::from_parts(
                recipient,
                orchard::value::NoteValue::from_raw(amount),
                rho,
                rseed,
                NoteVersion::V3,
            ))?;
            Some(note)
        })();
        match (note, out.cmx()) {
            (Some(note), Some(cmx)) => ExtractedNoteCommitment::from(note.commitment()).to_bytes() == *cmx,
            _ => false,
        }
    });
    if !pays {
        return Err(format!("no output pays {amount} zats to the merchant"));
    }
    Ok(())
}

/// The note a rung returns to the pocket's `change_address`, rebuilt from its PCZT
/// and checked against the commitment the action carries: what the next installment
/// spends. `None` if no output pays it, as for a final installment that leaves none.
pub fn change_of(pczt: &Pczt, change_address: &orchard::Address) -> Option<orchard::Note> {
    use orchard::note::{ExtractedNoteCommitment, Note, NoteVersion, RandomSeed, Rho};

    let to = change_address.to_raw_address_bytes();
    pczt.ironwood().actions().iter().find_map(|action| {
        let out = action.output();
        if out.recipient().as_ref() != Some(&to) {
            return None;
        }
        // An output's `rho` is the nullifier of the spend in the same action.
        let rho = Option::from(Rho::from_bytes(action.spend().nullifier()))?;
        let rseed = Option::from(RandomSeed::from_bytes((*out.rseed())?, &rho))?;
        let value = orchard::value::NoteValue::from_raw((*out.value())?);
        let note: Note = Option::from(Note::from_parts(*change_address, value, rho, rseed, NoteVersion::V3))?;
        (ExtractedNoteCommitment::from(note.commitment()).to_bytes() == (*out.cmx())?).then_some(note)
    })
}
