//! Pre-authorized shielded payment mandates on Zcash Ironwood.
//!
//! A payer funds a single-use *pocket*, then pre-signs a chain of installments.
//! Installment `k` spends the change note `C(k-1)` of installment `k-1`, pays the
//! merchant, and returns change `C(k)` to the pocket. Because v6 sighashes exclude
//! Orchard-family anchors (ZIP 229, ZIP 374), each installment can be signed before
//! its parent is mined; the merchant's runner installs the anchor and witness and
//! proves it when it falls due, but can never alter what was signed.
//!
//! The sighash still commits to the expiry height and consensus branch, so every
//! installment is signed once per candidate broadcast height (a *rung*). All rungs
//! of an installment share byte-identical actions, so they spend the same note and
//! produce the same change `C(k)`.

pub mod pocket;
pub mod rung;
pub mod seed;

pub use pocket::Pocket;
pub use rung::{build_rung, ActionFingerprint, Installment, Rung};
