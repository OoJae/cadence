use orchard::keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey};
use zip32::AccountId;

/// Pockets live at a fixed, non-zero ZIP 32 account. A stock wallet that restores
/// account 0 from the pocket seed finds nothing, so it can never sweep a pocket with
/// the default Sender OVK (which the merchant's runner could decrypt).
pub const POCKET_ACCOUNT: u32 = 7;

/// A single-use spending pocket for one mandate.
///
/// The seed is fresh per mandate and is never the payer's main wallet seed.
pub struct Pocket {
    sk: SpendingKey,
    fvk: FullViewingKey,
}

impl Pocket {
    /// Derives the pocket for `seed` on the network with the given SLIP 44 coin type.
    pub fn from_seed(seed: &[u8; 32], coin_type: u32) -> Self {
        let account = AccountId::try_from(POCKET_ACCOUNT).expect("valid ZIP 32 account index");
        let sk = SpendingKey::from_zip32_seed(seed, coin_type, account)
            .expect("seed of valid length and hardened path");
        let fvk = FullViewingKey::from(&sk);
        Pocket { sk, fvk }
    }

    pub fn fvk(&self) -> &FullViewingKey {
        &self.fvk
    }

    pub fn ask(&self) -> SpendAuthorizingKey {
        SpendAuthorizingKey::from(&self.sk)
    }

    /// The external receiver the payer funds from their own wallet.
    pub fn funding_address(&self) -> orchard::Address {
        self.fvk.address_at(0u32, Scope::External)
    }

    /// The internal receiver that holds each installment's change `C(k)`.
    pub fn change_address(&self) -> orchard::Address {
        self.fvk.address_at(0u32, Scope::Internal)
    }

    pub(crate) fn sk_bytes(&self) -> &[u8; 32] {
        self.sk.to_bytes()
    }
}
