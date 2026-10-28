//! Consensus parameters for the networks Cadence runs on.
//!
//! Mainnet and testnet are zcash_protocol's own [`Network`], passed through
//! unchanged. Regtest is a local chain for rehearsals (`scripts/regtest/`), whose
//! node must use the same activation heights: every upgrade through NU6.3 at height
//! 1, and NU7 at [`REGTEST_NU7`].

use zcash_protocol::consensus::{BlockHeight, Network, NetworkType, NetworkUpgrade, Parameters};

/// NU7's activation height on regtest, as in `scripts/regtest/zebrad.toml`.
pub const REGTEST_NU7: u32 = 200;

/// The network a runner, payer or decoder works on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Params {
    /// Mainnet or testnet.
    Public(Network),
    Regtest,
}

impl Params {
    pub const MAIN: Params = Params::Public(Network::MainNetwork);
    pub const TEST: Params = Params::Public(Network::TestNetwork);

    /// The network named `main`, `test` or `regtest`.
    pub fn from_name(name: &str) -> Option<Params> {
        match name {
            "main" => Some(Params::MAIN),
            "test" => Some(Params::TEST),
            "regtest" => Some(Params::Regtest),
            _ => None,
        }
    }
}

impl From<Network> for Params {
    fn from(network: Network) -> Self {
        Params::Public(network)
    }
}

impl Parameters for Params {
    fn network_type(&self) -> NetworkType {
        match self {
            Params::Public(network) => network.network_type(),
            Params::Regtest => NetworkType::Regtest,
        }
    }

    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Params::Public(network) => network.activation_height(nu),
            Params::Regtest => match nu {
                NetworkUpgrade::Overwinter
                | NetworkUpgrade::Sapling
                | NetworkUpgrade::Blossom
                | NetworkUpgrade::Heartwood
                | NetworkUpgrade::Canopy
                | NetworkUpgrade::Nu5
                | NetworkUpgrade::Nu6
                | NetworkUpgrade::Nu6_1
                | NetworkUpgrade::Nu6_2
                | NetworkUpgrade::Nu6_3 => Some(BlockHeight::from_u32(1)),
                NetworkUpgrade::Nu7 => Some(BlockHeight::from_u32(REGTEST_NU7)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cadence_core::Pocket;
    use zcash_protocol::consensus::{BranchId, MainNetwork, NetworkConstants, TestNetwork};

    const UPGRADES: [NetworkUpgrade; 11] = [
        NetworkUpgrade::Overwinter,
        NetworkUpgrade::Sapling,
        NetworkUpgrade::Blossom,
        NetworkUpgrade::Heartwood,
        NetworkUpgrade::Canopy,
        NetworkUpgrade::Nu5,
        NetworkUpgrade::Nu6,
        NetworkUpgrade::Nu6_1,
        NetworkUpgrade::Nu6_2,
        NetworkUpgrade::Nu6_3,
        NetworkUpgrade::Nu7,
    ];

    fn same_as<P: Parameters>(params: Params, network: P) {
        assert_eq!(params.network_type(), network.network_type());
        assert_eq!(params.coin_type(), network.coin_type());
        let pocket = Pocket::from_seed(&[7; 32], params.coin_type());
        assert_eq!(pocket.funding_ua(&params), pocket.funding_ua(&network));
        assert_eq!(pocket.ufvk().encode(&params).unwrap(), pocket.ufvk().encode(&network).unwrap());
        for nu in UPGRADES {
            assert_eq!(params.activation_height(nu), network.activation_height(nu), "{nu}");
            let at = network.activation_height(nu).unwrap();
            for h in [at - 1, at, at + 1] {
                assert_eq!(BranchId::for_height(&params, h), BranchId::for_height(&network, h), "{nu} {h}");
            }
        }
    }

    #[test]
    fn main_and_test_are_zcash_protocols_own() {
        same_as(Params::MAIN, MainNetwork);
        same_as(Params::TEST, TestNetwork);
        same_as(Params::from(Network::MainNetwork), Network::MainNetwork);
        assert_eq!(Params::from_name("main"), Some(Params::MAIN));
        assert_eq!(Params::from_name("test"), Some(Params::TEST));
        assert_eq!(Params::from_name("mainnet"), None);
    }

    #[test]
    fn regtest_activates_nu7_at_its_own_height() {
        let params = Params::from_name("regtest").unwrap();
        assert_eq!(params.network_type(), NetworkType::Regtest);
        let pocket = Pocket::from_seed(&[7; 32], params.coin_type());
        assert!(pocket.funding_ua(&params).starts_with("uregtest1"));
        let at = |h| BranchId::for_height(&params, BlockHeight::from_u32(h));
        assert_eq!(at(1), BranchId::Nu6_3);
        assert_eq!(at(REGTEST_NU7 - 1), BranchId::Nu6_3);
        assert_eq!(at(REGTEST_NU7), BranchId::Nu7);
        assert_eq!(u32::from(BranchId::Nu7), 0x7719_0ad9);
    }
}
