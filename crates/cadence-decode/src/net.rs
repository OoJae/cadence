//! Chain helpers the scanner needs that `cadence-chain` does not provide: a
//! `GetBlockRange` stream reduced to per-block summaries, retries with backoff,
//! a per-height tree-root store, and an append-only JSONL cache that makes a scan
//! resumable.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    future::Future,
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use anyhow::{bail, Context, Result};
use cadence_chain::{lwd, Client};
use cadence_decode::fingerprint::{Counts, Pool};
use futures_util::{stream, StreamExt};
use orchard::Anchor;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tonic::Code;
use zcash_client_backend::proto::service::{BlockId, BlockRange, PoolType};
use zcash_protocol::consensus::BlockHeight;

/// Every retry taken, for the report (a proxy for server rate limiting).
pub static RETRIES: AtomicU64 = AtomicU64::new(0);

const MAX_ATTEMPTS: u32 = 6;

fn retryable(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| {
        cause.downcast_ref::<tonic::Status>().is_some_and(|s| {
            matches!(
                s.code(),
                Code::Unavailable
                    | Code::ResourceExhausted
                    | Code::DeadlineExceeded
                    | Code::Aborted
                    | Code::Unknown
                    | Code::Internal
                    | Code::Cancelled
            )
        })
    })
}

/// Runs `op` until it succeeds, retrying transient gRPC failures with exponential backoff.
pub async fn with_retry<T, F, Fut>(what: &str, mut op: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut delay = Duration::from_millis(500);
    let mut attempt = 1;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < MAX_ATTEMPTS && retryable(&e) => {
                RETRIES.fetch_add(1, Ordering::Relaxed);
                eprintln!("  {what}: {e:#}; retry {attempt} in {delay:?}");
                tokio::time::sleep(delay).await;
                delay *= 2;
                attempt += 1;
            }
            Err(e) => return Err(e.context(what.to_string())),
        }
    }
}

/// What the scanner keeps of one compact transaction.
pub struct CompactTxSummary {
    pub index: u64,
    /// Protocol (internal) byte order, as `TxId::from_bytes` takes it.
    pub txid: [u8; 32],
    pub counts: Counts,
}

impl CompactTxSummary {
    pub fn orchard_family(&self) -> bool {
        self.counts.orchard_actions + self.counts.ironwood_actions > 0
    }
}

/// What the scanner keeps of one compact block.
pub struct BlockSummary {
    pub height: u32,
    /// Display (byte-reversed) hex, as `GetTreeState` reports it.
    pub hash: String,
    /// Note commitment tree sizes at the end of the block, from `chain_metadata`.
    pub orchard_size: Option<u32>,
    pub ironwood_size: Option<u32>,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    pub txs: Vec<CompactTxSummary>,
}

fn summarize(block: zcash_client_backend::proto::compact_formats::CompactBlock) -> Result<BlockSummary> {
    let mut hash = block.hash.clone();
    hash.reverse();
    let txs = block
        .vtx
        .iter()
        .map(|tx| {
            Ok(CompactTxSummary {
                index: tx.index,
                txid: tx
                    .txid
                    .as_slice()
                    .try_into()
                    .context("compact txid is not 32 bytes")?,
                counts: Counts {
                    transparent_inputs: tx.vin.len(),
                    transparent_outputs: tx.vout.len(),
                    sapling_spends: tx.spends.len(),
                    sapling_outputs: tx.outputs.len(),
                    orchard_actions: tx.actions.len(),
                    ironwood_actions: tx.ironwood_actions.len(),
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(BlockSummary {
        height: u32::try_from(block.height)?,
        hash: hex::encode(hash),
        orchard_size: block.chain_metadata.map(|m| m.orchard_commitment_tree_size),
        ironwood_size: block.chain_metadata.map(|m| m.ironwood_commitment_tree_size),
        orchard_actions: txs.iter().map(|t| t.counts.orchard_actions).sum(),
        ironwood_actions: txs.iter().map(|t| t.counts.ironwood_actions).sum(),
        txs,
    })
}

fn block_id(height: u32) -> BlockId {
    BlockId {
        height: u64::from(height),
        hash: vec![],
    }
}

/// Streams `[from, to]` with `GetBlockRange`, resuming after the last block received if
/// the stream breaks. It first asks for every pool, transparent included, so that the
/// population covers transparent-only transactions too; a server that refuses
/// `poolTypes` gets the legacy (shielded-only) request. Returns the summaries and
/// whether transparent data was requested successfully.
pub async fn block_range(client: &Client, from: u32, to: u32) -> Result<(Vec<BlockSummary>, bool)> {
    let all_pools = vec![
        PoolType::Transparent as i32,
        PoolType::Sapling as i32,
        PoolType::Orchard as i32,
        PoolType::Ironwood as i32,
    ];
    let mut pool_types = all_pools.clone();
    let mut blocks: Vec<BlockSummary> = Vec::with_capacity((to - from + 1) as usize);
    let mut next = from;
    let mut attempt = 1;
    while next <= to {
        let request = BlockRange {
            start: Some(block_id(next)),
            end: Some(block_id(to)),
            pool_types: pool_types.clone(),
        };
        let result: Result<()> = async {
            let mut stream = client.clone().get_block_range(request).await?.into_inner();
            while let Some(block) = stream.message().await? {
                let summary = summarize(block)?;
                if summary.height != next {
                    bail!("block stream returned height {} where {next} was expected", summary.height);
                }
                next += 1;
                blocks.push(summary);
                if blocks.len().is_multiple_of(250) {
                    eprintln!("  streamed {} blocks (at {})", blocks.len(), next - 1);
                }
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) if next <= to => bail!("block stream ended at {} before {to}", next - 1),
            Ok(()) => {}
            Err(e)
                if blocks.is_empty()
                    && pool_types == all_pools
                    && e.downcast_ref::<tonic::Status>().is_some_and(|s| {
                        matches!(s.code(), Code::InvalidArgument | Code::Unimplemented)
                    }) =>
            {
                eprintln!("  server refused poolTypes ({e}); falling back to shielded-only compact blocks");
                pool_types = vec![];
            }
            Err(e) if attempt < MAX_ATTEMPTS && retryable(&e) => {
                RETRIES.fetch_add(1, Ordering::Relaxed);
                let delay = Duration::from_millis(500 << attempt);
                eprintln!("  block stream broke at {next}: {e:#}; resuming in {delay:?}");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => return Err(e.context(format!("streaming blocks {next}..={to}"))),
        }
    }
    Ok((blocks, !pool_types.is_empty()))
}

/// Tree roots as of the end of one block, from `GetTreeState`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Roots {
    pub height: u32,
    /// Block hash (display hex) the roots belong to; checked against the compact
    /// block at the same height before a cached entry is reused.
    pub hash: String,
    #[serde(with = "hex32")]
    pub orchard: [u8; 32],
    #[serde(with = "hex32")]
    pub ironwood: [u8; 32],
    pub orchard_size: u64,
    pub ironwood_size: u64,
    /// True when this entry was copied from the previous height (same tree sizes, so
    /// the same tree) instead of fetched.
    #[serde(default)]
    pub derived: bool,
}

mod hex32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(&s)
            .map_err(serde::de::Error::custom)?
            .try_into()
            .map_err(|_| serde::de::Error::custom("expected 32 bytes"))
    }
}

async fn fetch_roots(client: &Client, height: u32) -> Result<Roots> {
    let ts = with_retry(&format!("GetTreeState({height})"), || {
        let mut c = client.clone();
        async move { lwd::tree_state(&mut c, BlockHeight::from_u32(height)).await }
    })
    .await?;
    if ts.height != u64::from(height) {
        bail!("GetTreeState({height}) answered for height {}", ts.height);
    }
    let orchard = ts.orchard_tree()?;
    let ironwood = ts.ironwood_tree()?;
    Ok(Roots {
        height,
        hash: ts.hash.clone(),
        orchard: Anchor::from(orchard.root()).to_bytes(),
        ironwood: Anchor::from(ironwood.root()).to_bytes(),
        orchard_size: orchard.size() as u64,
        ironwood_size: ironwood.size() as u64,
        derived: false,
    })
}

/// Tree roots per height, fetched at most once each (and persisted, when a cache is open).
#[derive(Default)]
pub struct RootStore {
    map: BTreeMap<u32, Roots>,
    cache: Option<Jsonl>,
    pub fetched: u64,
    pub loaded_from_cache: u64,
}

impl RootStore {
    /// Opens a store backed by `path`, keeping only cached entries whose block hash
    /// matches `hash_at` (so a reorg since the last run invalidates them).
    pub fn open(path: Option<PathBuf>, hash_at: impl Fn(u32) -> Option<String>) -> Result<Self> {
        let mut store = RootStore::default();
        if let Some(path) = path {
            for r in load_jsonl::<Roots>(&path)? {
                if !r.derived && hash_at(r.height).is_some_and(|h| same_hash(&h, &r.hash)) {
                    store.map.insert(r.height, r);
                    store.loaded_from_cache += 1;
                }
            }
            store.cache = Some(Jsonl::append(&path)?);
        }
        Ok(store)
    }

    pub fn get(&self, height: u32) -> Option<&Roots> {
        self.map.get(&height)
    }

    pub fn contains(&self, height: u32) -> bool {
        self.map.contains_key(&height)
    }

    pub fn root(&self, pool: Pool, height: BlockHeight) -> Option<[u8; 32]> {
        self.map.get(&u32::from(height)).map(|r| match pool {
            Pool::Orchard => r.orchard,
            Pool::Ironwood => r.ironwood,
        })
    }

    /// Fetches every height in `heights` not already present, `concurrency` at a time.
    pub async fn ensure(&mut self, client: &Client, heights: impl IntoIterator<Item = u32>, concurrency: usize) -> Result<()> {
        let missing: Vec<u32> = heights.into_iter().filter(|h| !self.map.contains_key(h)).collect();
        let total = missing.len();
        let mut results = stream::iter(missing)
            .map(|h| fetch_roots(client, h))
            .buffer_unordered(concurrency.max(1));
        let mut done = 0usize;
        while let Some(roots) = results.next().await {
            let roots = roots?;
            if let Some(cache) = self.cache.as_mut() {
                cache.write(&roots)?;
            }
            self.map.insert(roots.height, roots);
            self.fetched += 1;
            done += 1;
            if done.is_multiple_of(100) {
                eprintln!("  tree states {done}/{total}");
            }
        }
        Ok(())
    }

    /// Records that `height` has the same trees as `height - 1`.
    pub fn derive_from_previous(&mut self, height: u32, hash: &str) -> bool {
        let Some(prev) = height.checked_sub(1).and_then(|p| self.map.get(&p)).cloned() else {
            return false;
        };
        self.map.insert(
            height,
            Roots {
                height,
                hash: hash.to_string(),
                derived: true,
                ..prev
            },
        );
        true
    }
}

/// Block hashes compared in either byte order, since servers differ in which they report.
pub fn same_hash(a: &str, b: &str) -> bool {
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    match (hex::decode(a), hex::decode(b)) {
        (Ok(mut x), Ok(y)) => {
            x.reverse();
            x == y
        }
        _ => false,
    }
}

/// An append-only JSON-lines file, flushed after every line so an interrupted scan
/// loses at most the line being written.
pub struct Jsonl {
    out: BufWriter<File>,
}

impl Jsonl {
    pub fn append(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        Ok(Jsonl {
            out: BufWriter::new(file),
        })
    }

    pub fn write<T: Serialize>(&mut self, value: &T) -> Result<()> {
        serde_json::to_writer(&mut self.out, value)?;
        self.out.write_all(b"\n")?;
        self.out.flush()?;
        Ok(())
    }
}

/// Reads a JSON-lines file, skipping lines that do not parse (such as a line cut off
/// by an interrupted run). A missing file reads as empty.
pub fn load_jsonl<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    Ok(BufReader::new(file)
        .lines()
        .map_while(|l| l.ok())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect())
}
