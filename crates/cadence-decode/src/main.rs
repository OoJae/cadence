mod net;
mod scan;

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use cadence_chain::{lwd, Client, Transport};
use cadence_decode::shape_with_ranges;
use clap::{Args, Parser, Subcommand, ValueEnum};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::Network;

use crate::{
    net::{with_retry, RootStore},
    scan::{anchor_ranges, fetch_tx, parse_txid, search_window, ScanArgs},
};

#[derive(Clone, Copy, ValueEnum)]
enum Net {
    Main,
    Test,
}

/// Decode the public shape of transactions, straight from lightwalletd, or build the
/// population distribution of those shapes over a range of blocks.
#[derive(Parser)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Conn {
    #[arg(long, value_enum, default_value = "test")]
    network: Net,
    /// lightwalletd URL [default: https://testnet.zec.rocks:443 on test, https://zec.rocks:443 on main]
    #[arg(long)]
    server: Option<String>,
    /// Connect over plain TLS instead of Tor. The server learns this machine's IP address.
    #[arg(long)]
    direct: bool,
    #[arg(long, default_value = ".cadence/decode-tor")]
    tor_dir: PathBuf,
}

impl Conn {
    fn params(&self) -> Network {
        match self.network {
            Net::Main => Network::MainNetwork,
            Net::Test => Network::TestNetwork,
        }
    }

    fn name(&self) -> &'static str {
        match self.network {
            Net::Main => "main",
            Net::Test => "test",
        }
    }

    fn server(&self) -> String {
        self.server.clone().unwrap_or_else(|| {
            match self.network {
                Net::Main => "https://zec.rocks:443",
                Net::Test => "https://testnet.zec.rocks:443",
            }
            .into()
        })
    }

    async fn connect(&self) -> Result<Client> {
        let transport = if self.direct {
            Transport::Direct
        } else {
            Transport::Tor { dir: &self.tor_dir }
        };
        cadence_chain::connect(&self.server(), transport).await
    }
}

#[derive(Subcommand)]
enum Command {
    /// Print the public shape of each transaction as JSON.
    Decode {
        /// Transaction ids (display-order hex).
        txids: Vec<String>,
        #[command(flatten)]
        conn: Conn,
        /// UFVKs whose OVKs to try on every output (to prove they recover nothing).
        #[arg(long = "ufvk")]
        ufvks: Vec<String>,
        /// How far below the mined height to search for the anchor's tree root.
        #[arg(long, default_value_t = 12)]
        anchor_search: u32,
    },
    /// Build the distribution of shape fields over [--from, --to] and place --compare
    /// transactions in it.
    Scan {
        #[command(flatten)]
        conn: Conn,
        /// First height to scan.
        #[arg(long)]
        from: u32,
        /// Last height to scan (inclusive).
        #[arg(long)]
        to: u32,
        /// Where to write the JSON report.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Transaction ids to place in the population (display-order hex).
        #[arg(long, num_args = 1..)]
        compare: Vec<String>,
        /// How far below each mined height to search for anchor roots.
        #[arg(long, default_value_t = 12)]
        anchor_search: u32,
        /// Requests in flight at once.
        #[arg(long, default_value_t = 4)]
        concurrency: usize,
        /// Directory for the resumable tree-root and transaction cache
        /// [default: .cadence/scan-cache/<network>].
        #[arg(long)]
        cache_dir: Option<PathBuf>,
        /// Neither read nor write the cache.
        #[arg(long)]
        no_cache: bool,
        /// Include every decoded record in the report.
        #[arg(long)]
        records: bool,
    },
    /// Print the chain tip height.
    Tip {
        #[command(flatten)]
        conn: Conn,
    },
}

async fn decode(conn: Conn, txids: Vec<String>, ufvks: Vec<String>, anchor_search: u32) -> Result<()> {
    let params = conn.params();
    let ufvks = ufvks
        .iter()
        .map(|s| UnifiedFullViewingKey::decode(&params, s).map_err(|e| anyhow!(e)))
        .collect::<Result<Vec<_>>>()?;
    let client = conn.connect().await?;
    // Shared across txids, so neighbouring transactions reuse each other's tree states.
    let mut roots = RootStore::default();

    for txid in &txids {
        let (tx, mined) = fetch_tx(&client, &params, &parse_txid(txid)?).await?;
        if let Some(m) = mined {
            if tx.orchard_bundle().is_some() || tx.ironwood_bundle().is_some() {
                roots.ensure(&client, search_window(u32::from(m), anchor_search), 1).await?;
            }
        }
        let ranges = anchor_ranges(&tx, mined, anchor_search, &roots);
        let shape = shape_with_ranges(&tx, mined, ranges, &ufvks);
        println!("{}", serde_json::to_string_pretty(&shape)?);
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Decode {
            txids,
            conn,
            ufvks,
            anchor_search,
        } => decode(conn, txids, ufvks, anchor_search).await,
        Command::Scan {
            conn,
            from,
            to,
            out,
            compare,
            anchor_search,
            concurrency,
            cache_dir,
            no_cache,
            records,
        } => {
            let client = conn.connect().await?;
            let cache_dir = (!no_cache)
                .then(|| cache_dir.unwrap_or_else(|| PathBuf::from(".cadence/scan-cache").join(conn.name())));
            scan::run(
                client,
                ScanArgs {
                    network: conn.params(),
                    network_name: conn.name(),
                    server: conn.server(),
                    from,
                    to,
                    anchor_search,
                    concurrency,
                    cache_dir,
                    out,
                    compare,
                    include_records: records,
                },
            )
            .await
        }
        Command::Tip { conn } => {
            let client = conn.connect().await?;
            let tip = with_retry("GetLatestBlock", || {
                let mut c = client.clone();
                async move { lwd::tip(&mut c).await }
            })
            .await?;
            println!("{}", u32::from(tip));
            Ok(())
        }
    }
}
