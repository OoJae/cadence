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
