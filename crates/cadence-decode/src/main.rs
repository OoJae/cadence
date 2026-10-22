use std::path::PathBuf;

use anyhow::{anyhow, Result};
use cadence_chain::{lwd, Transport};
use cadence_decode::shape;
use clap::{Parser, ValueEnum};
use orchard::Anchor;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::Network;

#[derive(Clone, Copy, ValueEnum)]
enum Net {
    Main,
    Test,
}

/// Decode the public shape of transactions, straight from lightwalletd.
#[derive(Parser)]
struct Cli {
    /// Transaction ids (display-order hex).
    txids: Vec<String>,
    #[arg(long, value_enum, default_value = "test")]
    network: Net,
    #[arg(long, default_value = "https://testnet.zec.rocks:443")]
    server: String,
    #[arg(long)]
    direct: bool,
    #[arg(long, default_value = ".cadence/decode-tor")]
    tor_dir: PathBuf,
    /// UFVKs whose OVKs to try on every output (to prove they recover nothing).
    #[arg(long = "ufvk")]
    ufvks: Vec<String>,
    /// How far below the mined height to search for the anchor's tree root.
    #[arg(long, default_value_t = 12)]
    anchor_search: u32,
}

fn parse_txid(display_hex: &str) -> Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(display_hex)?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let params = match cli.network {
        Net::Main => Network::MainNetwork,
        Net::Test => Network::TestNetwork,
    };
    let ufvks = cli
        .ufvks
        .iter()
        .map(|s| UnifiedFullViewingKey::decode(&params, s).map_err(|e| anyhow!(e)))
        .collect::<Result<Vec<_>>>()?;
    let transport = if cli.direct {
        Transport::Direct
    } else {
        Transport::Tor { dir: &cli.tor_dir }
    };
    let mut client = cadence_chain::connect(&cli.server, transport).await?;

    for txid in &cli.txids {
        let (tx, mined) = lwd::transaction(&mut client, &params, &parse_txid(txid)?).await?;
        let mut matching = vec![];
        if let (Some(mined), Some(bundle)) = (mined, tx.ironwood_bundle()) {
            for depth in 1..=cli.anchor_search {
                let h = mined - depth;
                let root = lwd::tree_state(&mut client, h).await?.ironwood_tree()?.root();
                if Anchor::from(root) == *bundle.anchor() {
                    matching.push(h);
                }
            }
        }
        let range = matching
            .iter()
            .min()
            .zip(matching.iter().max())
            .map(|(lo, hi)| (*lo, *hi));
        println!("{}", serde_json::to_string_pretty(&shape(&tx, mined, range, &ufvks))?);
    }
    Ok(())
}
