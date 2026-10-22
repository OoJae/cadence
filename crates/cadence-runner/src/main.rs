//! The merchant-side executor for Cadence mandates.
//!
//! The runner holds, per subscription, only the pocket's Orchard-only UFVK and the
//! payer's sealed ladders. When an installment's drand round passes it opens the
//! package, picks the rung signed for exactly the next block, installs a fresh
//! anchor and the spend witness, proves, and broadcasts. It cannot change a single
//! signed byte.

mod api;
mod service;
mod store;
mod webhook;

use std::{
    fs,
    io::Write,
    path::PathBuf,
    str::FromStr,
    sync::{atomic::AtomicU32, Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use cadence_chain::{lwd, wallet, Transport};
use cadence_seal::{age::x25519, DrandChain};
use clap::{Args, Parser, Subcommand, ValueEnum};
use zcash_protocol::consensus::Network;

use crate::{
    service::{App, Config},
    store::Store,
};

#[derive(Parser)]
#[command(name = "cadence-runner", about = "Executes pre-signed Cadence installments")]
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

#[derive(Args)]
struct Paths {
    #[arg(long, value_enum, default_value = "test")]
    network: Net,
    /// The zcash_client_sqlite wallet holding pocket accounts.
    #[arg(long, default_value = ".cadence/runner-wallet.sqlite")]
    wallet_db: PathBuf,
    /// The runner's own records.
    #[arg(long, default_value = ".cadence/runner-state.sqlite")]
    state_db: PathBuf,
    /// The runner's age identity; payers seal packages to its recipient.
    #[arg(long, default_value = ".cadence/runner-identity.txt")]
    identity: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    /// Create the wallet and state databases and the runner's age identity.
    Init {
        #[command(flatten)]
        paths: Paths,
    },
    /// Run the scheduler and the HTTP API.
    Serve {
        #[command(flatten)]
        paths: Paths,
        /// lightwalletd used for sync.
        #[arg(long, default_value = "https://testnet.zec.rocks:443")]
        server: String,
        /// lightwalletd used for broadcasts (default: the sync server).
        #[arg(long)]
        broadcast_server: Option<String>,
        /// Connect without Tor. Development only.
        #[arg(long)]
        direct: bool,
        #[arg(long, default_value = ".cadence/runner-tor")]
        tor_dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8737")]
        listen: String,
        /// Where payers reach this runner (also the base of share links).
        #[arg(long, default_value = "http://127.0.0.1:8737")]
        public_url: String,
        #[arg(long, env = "CADENCE_MERCHANT_TOKEN")]
        merchant_token: String,
        #[arg(long)]
        webhook_url: Option<String>,
        #[arg(long, env = "CADENCE_WEBHOOK_SECRET")]
        webhook_secret: Option<String>,
        #[arg(long, default_value = cadence_seal::DEFAULT_RELAY)]
        drand_url: String,
        /// Seconds between scheduler ticks.
        #[arg(long, default_value_t = 10)]
        tick: u64,
        /// Testnet only: a dev pocket file whose funds pay judges' sandbox pockets.
        #[arg(long)]
        sandbox_funder: Option<PathBuf>,
        /// Height before the sandbox funder's first note.
        #[arg(long)]
        sandbox_funder_birthday: Option<u32>,
    },
}

fn load_identity(path: &PathBuf) -> Result<x25519::Identity> {
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    x25519::Identity::from_str(text.trim()).map_err(|e| anyhow!("bad identity: {e}"))
}

async fn connect(server: &str, direct: bool, tor_dir: PathBuf) -> Result<lwd::Client> {
    if direct {
        cadence_chain::connect(server, Transport::Direct).await
    } else {
        cadence_chain::connect(server, Transport::Tor { dir: &tor_dir }).await
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Init { paths } => {
            for p in [&paths.wallet_db, &paths.state_db, &paths.identity] {
                if let Some(dir) = p.parent() {
                    fs::create_dir_all(dir)?;
                }
            }
            let mut db = wallet::open(&paths.wallet_db, paths.network.params())?;
            wallet::init(&mut db)?;
            Store::open(&paths.state_db)?;
            if !paths.identity.exists() {
                use cadence_seal::age::secrecy::ExposeSecret;
                let identity = x25519::Identity::generate();
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                writeln!(options.open(&paths.identity)?, "{}", identity.to_string().expose_secret())?;
            }
            let recipient = load_identity(&paths.identity)?.to_public();
            println!("initialised; payers seal to {recipient}");
        }
        Command::Serve {
            paths,
            server,
            broadcast_server,
            direct,
            tor_dir,
            listen,
            public_url,
            merchant_token,
            webhook_url,
            webhook_secret,
            drand_url,
            tick,
            sandbox_funder,
            sandbox_funder_birthday,
        } => {
            if merchant_token.len() < 16 {
                bail!("use a merchant token of at least 16 characters");
            }
            let identity = load_identity(&paths.identity)?;
            let recipient = identity.to_public().to_string();
            let sync_client = connect(&server, direct, tor_dir.join("sync")).await?;
            let broadcast_client = connect(
                broadcast_server.as_deref().unwrap_or(&server),
                direct,
                tor_dir.join("broadcast"),
            )
            .await?;
            let mut wallet_db = wallet::open(&paths.wallet_db, paths.network.params())?;
            let store = Store::open(&paths.state_db)?;
            let funder = match sandbox_funder {
                None => None,
                Some(path) => {
                    #[derive(serde::Deserialize)]
                    struct DevPocket {
                        seed_hex: String,
                    }
                    let file: DevPocket = serde_json::from_slice(&fs::read(&path)?)?;
                    let seed: [u8; 32] = hex::decode(&file.seed_hex)?
                        .try_into()
                        .map_err(|_| anyhow!("bad funder seed"))?;
                    use zcash_protocol::consensus::{NetworkConstants, Parameters};
                    let params = paths.network.params();
                    let pocket = cadence_core::Pocket::from_seed(&seed, params.network_type().coin_type());
                    let account = match store.meta("funder_account")? {
                        Some(a) => service::parse_account(&a)?,
                        None => {
                            let birthday = sandbox_funder_birthday
                                .context("--sandbox-funder-birthday is needed the first time")?;
                            let ufvk = pocket.ufvk().encode(&params).map_err(|e| anyhow!("{e:?}"))?;
                            let mut client = sync_client.clone();
                            let account = wallet::import_pocket(
                                &mut client,
                                &mut wallet_db,
                                &params,
                                &ufvk,
                                zcash_protocol::consensus::BlockHeight::from_u32(birthday),
                                "sandbox-funder",
                            )
                            .await?;
                            store.set_meta("funder_account", &account.expose_uuid().to_string())?;
                            account
                        }
                    };
                    println!("sandbox funder enabled");
                    Some(service::Funder {
                        pocket,
                        account,
                        in_flight: Mutex::new(vec![]),
                        funded: Mutex::new(Default::default()),
                        queue: tokio::sync::Mutex::new(()),
                    })
                }
            };
            let tor = if direct {
                None
            } else {
                let dir = tor_dir.join("drand");
                fs::create_dir_all(&dir)?;
                Some(
                    zcash_client_backend::tor::Client::create(&dir, |_| {})
                        .await
                        .map_err(|e| anyhow!("bootstrapping Tor for drand: {e:?}"))?,
                )
            };
            let app = Arc::new(App {
                funder,
                tor,
                cfg: Config {
                    network: paths.network.params(),
                    network_name: paths.network.name(),
                    public_url,
                    merchant_token,
                    webhook_url,
                    webhook_secret,
                    drand_url,
                    tick: Duration::from_secs(tick),
                },
                wallet: tokio::sync::Mutex::new(wallet_db),
                store: Mutex::new(store),
                sync_client,
                broadcast_client,
                identity,
                recipient: recipient.clone(),
                chain: DrandChain::quicknet(),
                tip: AtomicU32::new(0),
            });
            tokio::spawn(service::run(app.clone()));
            let listener = tokio::net::TcpListener::bind(&listen).await?;
            println!("runner listening on {listen}; payers seal to {recipient}");
            axum::serve(listener, api::router(app)).await?;
        }
    }
    Ok(())
}
