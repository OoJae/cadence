//! The merchant-side executor for Cadence mandates.
//!
//! The runner holds, per subscription, only the pocket's Orchard-only UFVK and the
//! payer's sealed ladders. When an installment's drand round passes it opens the
//! package, picks the rung signed for exactly the next block, installs a fresh
//! anchor and the spend witness, proves, and broadcasts. It cannot change a single
//! signed byte.

mod api;
mod sandbox;
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
use axum::http::{HeaderValue, Uri};
use cadence_chain::{lwd, wallet, Params, Transport};
use cadence_seal::{age::x25519, DrandChain};
use clap::{Args, Parser, Subcommand, ValueEnum};

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
    Regtest,
}

impl Net {
    fn params(self) -> Params {
        match self {
            Net::Main => Params::MAIN,
            Net::Test => Params::TEST,
            Net::Regtest => Params::Regtest,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Net::Main => "main",
            Net::Test => "test",
            Net::Regtest => "regtest",
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
        /// Reach lightwalletd without Tor: for a node of your own, or development.
        #[arg(long)]
        direct: bool,
        /// Fetch drand beacons without Tor. Development only: the relay learns this
        /// runner's address and, from it, when installments fall due.
        #[arg(long)]
        drand_direct: bool,
        #[arg(long, default_value = ".cadence/runner-tor")]
        tor_dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:8737")]
        listen: String,
        /// Where payers reach this runner (also the base of share links, unless --app-url).
        #[arg(long, default_value = "http://127.0.0.1:8737")]
        public_url: String,
        /// Where the web app is hosted, when not by this runner: share links point
        /// there, and its origin may call the API.
        #[arg(long, env = "CADENCE_APP_URL")]
        app_url: Option<String>,
        /// Another origin whose pages may call the API, such as https://app.example
        /// (repeatable, or comma-separated).
        #[arg(long = "cors-origin", env = "CADENCE_CORS_ORIGINS", value_delimiter = ',')]
        cors_origins: Vec<String>,
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
        /// Testnet or regtest only: a dev pocket file whose funds pay judges' sandbox pockets.
        #[arg(long)]
        sandbox_funder: Option<PathBuf>,
        /// Height before the sandbox funder's first note.
        #[arg(long)]
        sandbox_funder_birthday: Option<u32>,
        /// Serve the built web app (web/dist) from this directory, same-origin with the API.
        #[arg(long)]
        web_dir: Option<PathBuf>,
    },
}

fn load_identity(path: &PathBuf) -> Result<x25519::Identity> {
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    x25519::Identity::from_str(text.trim()).map_err(|e| anyhow!("bad identity: {e}"))
}

/// Retries for a few minutes: Tor circuits and public servers time out now and then,
/// and a restarted runner should come back on its own.
async fn connect(server: &str, direct: bool, tor_dir: PathBuf) -> Result<lwd::Client> {
    let mut attempt = 1;
    loop {
        let result = if direct {
            cadence_chain::connect(server, Transport::Direct).await
        } else {
            cadence_chain::connect(server, Transport::Tor { dir: &tor_dir }).await
        };
        match result {
            Ok(client) => return Ok(client),
            Err(e) if attempt < 8 => {
                eprintln!("connecting to {server} (attempt {attempt}): {e:#}; retrying");
                tokio::time::sleep(Duration::from_secs(5 * attempt)).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
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
            drand_direct,
            tor_dir,
            listen,
            public_url,
            app_url,
            cors_origins,
            merchant_token,
            webhook_url,
            webhook_secret,
            drand_url,
            tick,
            sandbox_funder,
            sandbox_funder_birthday,
            web_dir,
        } => {
            // A sandbox runner is a public demo: it lists every subscription and pays
            // pockets from a custodial wallet. Never on mainnet.
            if sandbox_funder.is_some() && matches!(paths.network, Net::Main) {
                bail!("--sandbox-funder is testnet only");
            }
            if merchant_token.len() < 16 {
                bail!("use a merchant token of at least 16 characters");
            }
            let app_url = app_url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty());
            let mut origins = cors_origins
                .iter()
                .map(|o| o.trim())
                .filter(|o| !o.is_empty())
                .map(|o| origin_of(o, true).context("--cors-origin"))
                .collect::<Result<Vec<_>>>()?;
            if let Some(url) = &app_url {
                origins.push(origin_of(url, false).context("--app-url")?);
            }
            origins.sort();
            origins.dedup();
            let cors = origins
                .iter()
                .map(|o| HeaderValue::from_str(o).map_err(|_| anyhow!("{o}: not a header value")))
                .collect::<Result<Vec<_>>>()?;
            let identity = load_identity(&paths.identity)?;
            let recipient = identity.to_public().to_string();
            let sync_client = connect(&server, direct, tor_dir.join("sync")).await?;
            let broadcast_client = connect(
                broadcast_server.as_deref().unwrap_or(&server),
                direct,
                tor_dir.join("broadcast"),
            )
            .await?;
            wallet::compact(&paths.wallet_db)?;
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
            let tor = if drand_direct {
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
                    app_url,
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
            if !origins.is_empty() {
                println!("the API also answers pages from {}", origins.join(", "));
            }
            axum::serve(listener, api::router(app, web_dir, cors)).await?;
        }
    }
    Ok(())
}

/// The origin a browser sends for pages under `url`: scheme and host in lower case,
/// the default port left out. With `bare`, `url` must be an origin alone, with no path.
fn origin_of(url: &str, bare: bool) -> Result<String> {
    if url == "*" {
        bail!("give exact origins; * is not allowed");
    }
    let uri: Uri = url.parse().map_err(|_| anyhow!("{url}: not a URL"))?;
    let scheme = uri.scheme_str().unwrap_or_default().to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => bail!("{url}: expected an http:// or https:// URL"),
    };
    let authority = uri.authority().with_context(|| format!("{url}: no host"))?;
    if authority.as_str().contains('@') {
        bail!("{url}: must not carry a user name or password");
    }
    if bare && !matches!(uri.path_and_query().map(|p| p.as_str()), None | Some("/")) {
        bail!("{url}: give the origin alone (scheme, host and port), with no path");
    }
    if uri.query().is_some() {
        bail!("{url}: must not carry a query string");
    }
    let host = authority.host().to_ascii_lowercase();
    Ok(match authority.port_u16() {
        Some(port) if port != default_port => format!("{scheme}://{host}:{port}"),
        _ => format!("{scheme}://{host}"),
    })
}

#[cfg(test)]
mod tests {
    use super::origin_of;

    #[test]
    fn origins_are_what_browsers_send() {
        assert_eq!(origin_of("https://app.example", true).unwrap(), "https://app.example");
        assert_eq!(origin_of("https://App.Example:443/", true).unwrap(), "https://app.example");
        assert_eq!(origin_of("http://localhost:5173", true).unwrap(), "http://localhost:5173");
        assert_eq!(origin_of("https://app.example/cadence", false).unwrap(), "https://app.example");
        for bad in ["*", "app.example", "https://app.example/cadence", "ftp://app.example", "https://me@app.example", "null"] {
            assert!(origin_of(bad, true).is_err(), "{bad}");
        }
        assert!(origin_of("https://app.example/?from=runner", false).is_err());
    }
}
