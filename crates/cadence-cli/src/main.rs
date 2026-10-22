mod subscribe;

use std::{collections::HashMap, fs, path::PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use cadence_chain::{lwd, Transport};
use cadence_core::{
    build_rung,
    package::{redact_for_runner, InstallmentLadder, Ladder, RungPackage},
    seed, Installment, Pocket,
};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use zcash_keys::address::Address;
use zcash_primitives::transaction::TxId;
use zcash_protocol::{
    consensus::{BlockHeight, Network, NetworkConstants, Parameters},
    memo::MemoBytes,
    value::Zatoshis,
};

#[derive(Parser)]
#[command(name = "cadence", about = "Pre-authorized shielded payments on Zcash Ironwood")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, ValueEnum)]
enum Net {
    Main,
    Test,
}

impl Net {
    fn params(self) -> Network {
        match self {
            Net::Main => Network::MainNetwork,
            Net::Test => Network::TestNetwork,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Net::Main => "main",
            Net::Test => "test",
        }
    }
}

#[derive(Subcommand)]
enum Command {
    /// Pocket management.
    Pocket {
        #[command(subcommand)]
        command: PocketCommand,
    },
    /// Pre-sign a mandate's installments as rung ladders for the merchant's runner.
    Presign(PresignArgs),
    /// Subscribe to a runner's offer: fund one pocket, pre-sign, seal, upload.
    Subscribe {
        /// The runner's base URL.
        #[arg(long)]
        runner: String,
        #[arg(long)]
        offer: String,
        /// Where to keep the subscription (needed to cancel).
        #[arg(long)]
        out: PathBuf,
        /// Seconds from signing until installment 1 becomes releasable.
        #[arg(long, default_value_t = 60)]
        first_in: u64,
        /// Testnet: ask the runner's sandbox wallet to fund the pocket.
        #[arg(long)]
        sandbox_fund: bool,
    },
    /// Continue an interrupted subscribe from its file.
    Resume {
        #[arg(long)]
        subscription: PathBuf,
    },
    /// Dev: send from a pocket whose notes a local wallet DB tracks.
    Send {
        #[arg(long)]
        pocket: PathBuf,
        #[arg(long)]
        wallet_db: PathBuf,
        #[arg(long)]
        to: String,
        /// Zatoshis to send.
        #[arg(long)]
        amount: u64,
        #[command(flatten)]
        chain: ChainArgs,
    },
    /// Cancel a subscription by spending the pocket's live note to your own address.
    Cancel {
        #[arg(long)]
        subscription: PathBuf,
        /// Your unified address (Orchard receiver) to refund to.
        #[arg(long)]
        to: String,
        #[command(flatten)]
        chain: ChainArgs,
    },
}

#[derive(Subcommand)]
enum PocketCommand {
    /// Create a fresh single-use pocket and print the address to fund.
    New {
        #[arg(long, value_enum, default_value = "test")]
        network: Net,
        /// Where to write the pocket file. Dev-only: the seed is stored unencrypted.
        #[arg(long)]
        out: PathBuf,
    },
    /// Print a pocket's funding address and UFVK.
    Show {
        #[arg(long)]
        pocket: PathBuf,
    },
}

#[derive(Args)]
struct ChainArgs {
    /// lightwalletd endpoint.
    #[arg(long, default_value = "https://testnet.zec.rocks:443")]
    server: String,
    /// Connect without Tor. Development only: the server sees this machine's IP.
    #[arg(long)]
    direct: bool,
    /// Directory for Tor (arti) state.
    #[arg(long, default_value = ".cadence/tor")]
    tor_dir: PathBuf,
}

impl ChainArgs {
    async fn connect(&self) -> Result<lwd::Client> {
        let transport = if self.direct {
            Transport::Direct
        } else {
            Transport::Tor { dir: &self.tor_dir }
        };
        cadence_chain::connect(&self.server, transport).await
    }
}

#[derive(Args)]
struct PresignArgs {
    #[arg(long)]
    pocket: PathBuf,
    /// The transaction that funded the pocket (display-order hex).
    #[arg(long)]
    funding_txid: String,
    /// The merchant's unified address; its Orchard receiver is paid.
    #[arg(long)]
    merchant: String,
    /// Amount per installment, in zatoshis.
    #[arg(long)]
    amount: u64,
    /// Number of installments.
    #[arg(long, default_value_t = 3)]
    count: u32,
    /// First candidate target height (default: chain tip + 1).
    #[arg(long)]
    from: Option<u32>,
    /// Number of consecutive target heights to sign per installment.
    #[arg(long, default_value_t = 300)]
    window: u32,
    #[arg(long)]
    out: PathBuf,
    #[command(flatten)]
    chain: ChainArgs,
}

/// Dev-only pocket file. Production pockets wrap the seed with WebAuthn-PRF or Argon2id.
#[derive(Serialize, Deserialize)]
struct PocketFile {
    network: String,
    seed_hex: String,
}

fn load_pocket(path: &PathBuf) -> Result<(Network, &'static str, Pocket)> {
    let file: PocketFile = serde_json::from_slice(&fs::read(path)?)?;
    let net = match file.network.as_str() {
        "main" => Net::Main,
        "test" => Net::Test,
        other => bail!("unknown network {other}"),
    };
    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
        .try_into()
        .map_err(|_| anyhow!("seed must be 32 bytes"))?;
    let params = net.params();
    Ok((params, net.name(), Pocket::from_seed(&seed, params.network_type().coin_type())))
}

fn print_pocket(params: &Network, pocket: &Pocket) -> Result<()> {
    let ufvk = pocket
        .ufvk()
        .encode(params)
        .map_err(|e| anyhow!("encoding UFVK: {e:?}"))?;
    println!("funding address: {}", pocket.funding_ua(params));
    println!("pocket ufvk:     {ufvk}");
    Ok(())
}

fn parse_txid(display_hex: &str) -> Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(display_hex)?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

fn merchant_receiver(params: &Network, ua: &str) -> Result<orchard::Address> {
    match Address::decode(params, ua) {
        Some(Address::Unified(ua)) => ua
            .orchard()
            .copied()
            .context("merchant address has no Orchard receiver"),
        Some(_) => bail!("merchant address must be a unified address with an Orchard receiver"),
        None => bail!("merchant address is not valid on this network"),
    }
}

async fn presign(args: PresignArgs) -> Result<()> {
    let (params, network, pocket) = load_pocket(&args.pocket)?;
    let merchant = merchant_receiver(&params, &args.merchant)?;
    let amount = Zatoshis::from_u64(args.amount).map_err(|_| anyhow!("invalid amount"))?;

    let mut client = args.chain.connect().await?;
    let tip = lwd::tip(&mut client).await?;
    let txid = parse_txid(&args.funding_txid)?;
    let (tx, mined) = lwd::transaction(&mut client, &params, &txid).await?;
    let ufvks = HashMap::from([(0u32, pocket.ufvk())]);
    let decrypted =
        zcash_client_backend::decrypt_transaction(&params, mined, Some(tip), &tx, &ufvks);
    let funding = decrypted
        .ironwood_outputs()
        .iter()
        .map(|o| o.note().0)
        .find(|note| note.recipient() == pocket.funding_address())
        .context("the funding transaction pays no Ironwood note to this pocket")?;
    println!(
        "funding note: {} zats (tx {}, mined at {:?})",
        funding.value().inner(),
        args.funding_txid,
        mined
    );

    let mut mandate_id = [0u8; 16];
    rand::fill(&mut mandate_id);
    let secret = seed::app_secret(&pocket);
    let from = args.from.unwrap_or(u32::from(tip) + 1);

    let mut input = funding;
    let mut installments = Vec::with_capacity(args.count as usize);
    for k in 1..=args.count {
        // An opaque tag only the merchant can tie to the subscription.
        let mut memo = [0u8; 20];
        memo[..16].copy_from_slice(&mandate_id);
        memo[16..].copy_from_slice(&k.to_le_bytes());
        let inst = Installment {
            input,
            amount,
            merchant,
            memo: MemoBytes::from_bytes(&memo)?,
        };
        let rung_seed = seed::rung_seed(&secret, &mandate_id, k, 0);

        let mut rungs = Vec::with_capacity(args.window as usize);
        let mut change = None;
        let mut spends_nullifier = [0u8; 32];
        for t in from..from + args.window {
            let rung = build_rung(&params, BlockHeight::from_u32(t), &pocket, &inst, rung_seed)
                .map_err(|e| anyhow!("building installment {k} at height {t}: {e:?}"))?;
            change = rung.change;
            spends_nullifier = rung.actions[rung.spend_action].nf;
            let bytes = redact_for_runner(rung.pczt)
                .serialize()
                .map_err(|e| anyhow!("encoding PCZT: {e:?}"))?;
            rungs.push(RungPackage {
                target_height: t,
                expiry_height: rung.expiry_height.into(),
                pczt: hex::encode(bytes),
            });
        }
        println!("installment {k}: {} rungs over heights {from}..{}", rungs.len(), from + args.window);
        installments.push(InstallmentLadder {
            k,
            amount_zat: args.amount,
            spends_nullifier: hex::encode(spends_nullifier),
            rungs,
        });
        match change {
            Some(c) => input = c,
            None if k < args.count => bail!("the pocket is exhausted after installment {k}"),
            None => {}
        }
    }

    let ladder = Ladder {
        network: network.into(),
        mandate_id: hex::encode(mandate_id),
        installments,
    };
    if let Some(dir) = args.out.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&args.out, serde_json::to_vec(&ladder)?)?;
    println!("wrote {}", args.out.display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Pocket { command } => match command {
            PocketCommand::New { network, out } => {
                if out.exists() {
                    bail!("{} already exists", out.display());
                }
                let mut seed = [0u8; 32];
                rand::fill(&mut seed);
                let file = PocketFile {
                    network: network.name().into(),
                    seed_hex: hex::encode(seed),
                };
                if let Some(dir) = out.parent() {
                    fs::create_dir_all(dir)?;
                }
                fs::write(&out, serde_json::to_vec_pretty(&file)?)
                    .with_context(|| format!("writing {}", out.display()))?;
                let params = network.params();
                let pocket = Pocket::from_seed(&seed, params.network_type().coin_type());
                print_pocket(&params, &pocket)?;
            }
            PocketCommand::Show { pocket } => {
                let (params, _, pocket) = load_pocket(&pocket)?;
                print_pocket(&params, &pocket)?;
            }
        },
        Command::Presign(args) => presign(args).await?,
        Command::Subscribe { runner, offer, out, first_in, sandbox_fund } => {
            tokio::task::spawn_blocking(move || subscribe::subscribe(&runner, &offer, &out, first_in, sandbox_fund))
                .await??
        }
        Command::Resume { subscription } => {
            tokio::task::spawn_blocking(move || subscribe::resume(&subscription)).await??
        }
        Command::Send { pocket, wallet_db, to, amount, chain } => {
            let client = chain.connect().await?;
            subscribe::send(&pocket, &wallet_db, &to, amount, client).await?
        }
        Command::Cancel { subscription, to, chain } => {
            let client = chain.connect().await?;
            subscribe::cancel(&subscription, &to, client).await?
        }
    }
    Ok(())
}
