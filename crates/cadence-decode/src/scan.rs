//! `cadence-decode scan`: the population distribution of shape fields over a height
//! range, with chosen transactions placed in it.
//!
//! Pipeline:
//! 1. Stream compact blocks for `[from - anchor_search, to]` (one `GetBlockRange`).
//! 2. Fetch tree roots for that window. A root changes only when its tree grows, so
//!    when the compact blocks' `chain_metadata` tree sizes check out against their
//!    action counts, only heights where a tree grew are fetched and the rest are
//!    copied forward. Otherwise every height is fetched, once.
//! 3. Fetch every transaction in `[from, to]` that has Orchard-pool or Ironwood
//!    actions (`concurrency` at a time) and compute its [`Shape`].
//! 4. Aggregate shape classes and histograms; place `--compare` transactions.
//!
//! Tree roots and decoded records are appended to JSON-lines files in the cache
//! directory as they arrive, so rerunning an interrupted scan resumes where it stopped.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::atomic::Ordering,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Result};
use cadence_chain::{lwd, Client};
use cadence_decode::{
    fee_without_prevouts,
    fingerprint::{self, class_label, ClassReport, Comparison, Counts, LabelCount, Pool, TxRecord, CLASSES},
    matching_range, shape_with_ranges, AnchorRanges,
};
use futures_util::{stream, StreamExt};
use serde::Serialize;
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::consensus::{BlockHeight, Network};

use crate::net::{self, with_retry, BlockSummary, Jsonl, RootStore};

pub struct ScanArgs {
    pub network: Network,
    pub network_name: &'static str,
    pub server: String,
    pub from: u32,
    pub to: u32,
    pub anchor_search: u32,
    pub concurrency: usize,
    pub cache_dir: Option<PathBuf>,
    pub out: Option<PathBuf>,
    pub compare: Vec<String>,
    pub include_records: bool,
}

#[derive(Serialize)]
struct Elapsed {
    blocks: f64,
    tree_states: f64,
    transactions: f64,
    total: f64,
}

#[derive(Serialize)]
struct Stats {
    blocks: u32,
    compact_txs: u64,
    orchard_family_txs: u64,
    decoded: u64,
    decoded_from_cache: u64,
    failed: u64,
    /// Whether the server returned transparent data (and transparent-only transactions)
    /// in the compact blocks. Without it, the compact population is shielded-only.
    transparent_data_in_compact_blocks: bool,
    /// Whether tree roots were fetched only where a tree grew (see the module docs).
    tree_root_dedupe: bool,
    tree_state_window: (u32, u32),
    tree_states_fetched: u64,
    tree_states_from_cache: u64,
    tree_states_derived: u64,
    transactions_fetched: u64,
    retries: u64,
    elapsed_secs: Elapsed,
    ms_per_block: f64,
}

#[derive(Serialize)]
struct Population {
    /// Every transaction in the compact blocks, by the pools it touches.
    compact_by_pools: Vec<LabelCount>,
    /// The same, by pools and component counts (no version: compact blocks omit it).
    compact_by_class: Vec<LabelCount>,
    /// Decoded Orchard-family transactions, by version, pools and counts.
    decoded_by_class: Vec<LabelCount>,
}

#[derive(Serialize)]
struct Failure {
    txid: String,
    height: u32,
    error: String,
}

#[derive(Serialize)]
struct Report {
    tool: String,
    network: String,
    server: String,
    from: u32,
    to: u32,
    chain_tip: u32,
    anchor_search: u32,
    generated_at_unix: u64,
    notes: Vec<String>,
    stats: Stats,
    population: Population,
    classes: Vec<ClassReport>,
    compare: Vec<Comparison>,
    failures: Vec<Failure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    records: Option<Vec<TxRecord>>,
}

pub fn parse_txid(display_hex: &str) -> Result<TxId> {
    let mut bytes: [u8; 32] = hex::decode(display_hex)?
        .try_into()
        .map_err(|_| anyhow!("txid must be 32 bytes"))?;
    bytes.reverse();
    Ok(TxId::from_bytes(bytes))
}

/// Fetches a full transaction, retrying transient failures.
pub async fn fetch_tx(client: &Client, params: &Network, txid: &TxId) -> Result<(Transaction, Option<BlockHeight>)> {
    with_retry(&format!("GetTransaction({txid})"), || {
        let mut c = client.clone();
        async move { lwd::transaction(&mut c, params, txid).await }
    })
    .await
}

/// The heights (below `mined`) whose roots match each Orchard-family anchor of `tx`.
pub fn anchor_ranges(tx: &Transaction, mined: Option<BlockHeight>, search: u32, roots: &RootStore) -> AnchorRanges {
    let Some(mined) = mined else {
        return AnchorRanges::default();
    };
    let locate = |pool: Pool, anchor: [u8; 32]| matching_range(mined, search, &anchor, |h| roots.root(pool, h));
    AnchorRanges {
        orchard: tx.orchard_bundle().and_then(|b| locate(Pool::Orchard, b.anchor().to_bytes())),
        ironwood: tx.ironwood_bundle().and_then(|b| locate(Pool::Ironwood, b.anchor().to_bytes())),
    }
}

/// The heights an anchor search for a transaction mined at `mined` reads.
pub fn search_window(mined: u32, search: u32) -> std::ops::Range<u32> {
    mined.saturating_sub(search).max(1)..mined
}

fn record(tx: &Transaction, mined: Option<BlockHeight>, index: Option<u64>, search: u32, roots: &RootStore) -> TxRecord {
    TxRecord {
        height: mined.map(u32::from),
        index,
        coinbase: index == Some(0),
        fee: fee_without_prevouts(tx),
        anchor_search: search,
        shape: shape_with_ranges(tx, mined, anchor_ranges(tx, mined, search, roots), &[]),
    }
}

fn secs(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 100.0).round() / 100.0
}

/// Plans which heights of the window need a `GetTreeState`. With trustworthy tree
/// sizes, that is the first height and every height where either tree grew.
fn plan_tree_states(blocks: &[BlockSummary]) -> (Vec<u32>, bool) {
    let sizes_check_out = blocks.iter().all(|b| b.orchard_size.is_some() && b.ironwood_size.is_some())
        && blocks.windows(2).all(|w| {
            let (prev, cur) = (&w[0], &w[1]);
            let grew = |p: Option<u32>, c: Option<u32>, n: usize| {
                c.unwrap_or(0).checked_sub(p.unwrap_or(0)) == Some(n as u32)
            };
            grew(prev.orchard_size, cur.orchard_size, cur.orchard_actions)
                && grew(prev.ironwood_size, cur.ironwood_size, cur.ironwood_actions)
        });
    if !sizes_check_out {
        return (blocks.iter().map(|b| b.height).collect(), false);
    }
    let needed = blocks
        .iter()
        .enumerate()
        .filter(|(i, b)| {
            *i == 0 || {
                let prev = &blocks[i - 1];
                prev.orchard_size != b.orchard_size || prev.ironwood_size != b.ironwood_size
            }
        })
        .map(|(_, b)| b.height)
        .collect();
    (needed, true)
}

pub async fn run(client: Client, args: ScanArgs) -> Result<()> {
    let started = Instant::now();
    let client = client.max_decoding_message_size(64 << 20);
    let mut notes: Vec<String> = vec![];

    let tip = u32::from(with_retry("GetLatestBlock", || {
        let mut c = client.clone();
        async move { lwd::tip(&mut c).await }
    })
    .await?);
    if args.from > args.to {
        bail!("--from {} is above --to {}", args.from, args.to);
    }
    let to = if args.to > tip {
        notes.push(format!("--to {} was above the chain tip; scanned to the tip {tip}", args.to));
        tip
    } else {
        args.to
    };
    if args.from > to {
        bail!("--from {} is above the chain tip {tip}", args.from);
    }
    if tip - to < 10 {
        notes.push(format!(
            "the range ends {} blocks below the tip; a reorg could still change its last blocks",
            tip - to
        ));
    }
    let from = args.from;
    let window_start = from.saturating_sub(args.anchor_search).max(1);
    eprintln!(
        "scan {} {from}..={to} (tip {tip}); compact blocks and tree states from {window_start}",
        args.network_name
    );

    // 1. Compact blocks for the whole window, in one stream.
    let t_blocks = Instant::now();
    let (blocks, transparent_data) = net::block_range(&client, window_start, to).await?;
    let elapsed_blocks = secs(t_blocks);
    if !transparent_data {
        notes.push(
            "the server returned shielded-only compact blocks, so transparent-only transactions are missing from compact_by_* and transparent counts there read 0".into(),
        );
    }
    let hash_at: BTreeMap<u32, String> = blocks.iter().map(|b| (b.height, b.hash.clone())).collect();
    let in_range = |b: &&BlockSummary| b.height >= from && b.height <= to;
    eprintln!("  {} blocks in {elapsed_blocks}s", blocks.len());

    // 2. Tree roots for the window.
    let t_roots = Instant::now();
    let cache = |name: &str| args.cache_dir.as_ref().map(|d| d.join(name));
    let mut roots = RootStore::open(cache("roots.jsonl"), |h| hash_at.get(&h).cloned())?;
    let (mut needed, mut dedupe) = plan_tree_states(&blocks);
    if !dedupe {
        notes.push("compact-block tree sizes did not account for every action, so a tree state was fetched for every height of the window".into());
    }
    eprintln!(
        "  tree states: {} of {} heights needed ({} cached)",
        needed.len(),
        blocks.len(),
        needed.iter().filter(|h| roots.contains(**h)).count()
    );
    roots.ensure(&client, needed.iter().copied(), args.concurrency).await?;
    if dedupe {
        // Check the sizes that justified skipping heights against the fetched tree states.
        let mismatch = blocks.iter().find(|b| {
            roots.get(b.height).is_some_and(|r| {
                Some(r.orchard_size) != b.orchard_size.map(u64::from)
                    || Some(r.ironwood_size) != b.ironwood_size.map(u64::from)
            })
        });
        if let Some(b) = mismatch {
            notes.push(format!(
                "tree-state sizes disagreed with compact-block metadata at {}, so every height was fetched",
                b.height
            ));
            dedupe = false;
            needed = blocks.iter().map(|b| b.height).collect();
            roots.ensure(&client, needed.iter().copied(), args.concurrency).await?;
        }
    }
    let mut derived = 0u64;
    for b in &blocks {
        if !roots.contains(b.height) {
            if !roots.derive_from_previous(b.height, &b.hash) {
                bail!("no tree state for {} and none to copy forward", b.height);
            }
            derived += 1;
        }
    }
    let reorged: Vec<u32> = blocks
        .iter()
        .filter(|b| roots.get(b.height).is_some_and(|r| !net::same_hash(&r.hash, &b.hash)))
        .map(|b| b.height)
        .collect();
    if !reorged.is_empty() {
        notes.push(format!(
            "tree states at {reorged:?} name a different block hash than the compact blocks (a reorg during the scan?)"
        ));
    }
    let elapsed_roots = secs(t_roots);
    eprintln!(
        "  tree states: {} fetched, {} from cache, {derived} copied forward, in {elapsed_roots}s",
        roots.fetched, roots.loaded_from_cache
    );

    // 3. Orchard-family transactions in the range.
    let t_txs = Instant::now();
    let candidates: Vec<(u32, u64, TxId)> = blocks
        .iter()
        .filter(in_range)
        .flat_map(|b| {
            b.txs
                .iter()
                .filter(|t| t.orchard_family())
                .map(|t| (b.height, t.index, TxId::from_bytes(t.txid)))
        })
        .collect();
    let mut records: BTreeMap<String, TxRecord> = BTreeMap::new();
    let mut from_cache = 0u64;
    if let Some(path) = cache("txs.jsonl") {
        let wanted: BTreeMap<String, u32> = candidates.iter().map(|(h, _, id)| (id.to_string(), *h)).collect();
        for r in net::load_jsonl::<TxRecord>(&path)? {
            if wanted.get(&r.shape.txid) == r.height.as_ref() && r.anchor_search == args.anchor_search {
                records.insert(r.shape.txid.clone(), r);
            }
        }
        from_cache = records.len() as u64;
    }
    let mut tx_cache = cache("txs.jsonl").map(|p| Jsonl::append(&p)).transpose()?;
    let todo: Vec<_> = candidates
        .iter()
        .filter(|(_, _, id)| !records.contains_key(&id.to_string()))
        .copied()
        .collect();
    eprintln!(
        "  {} Orchard-family transactions ({} cached, {} to fetch, {} at a time)",
        candidates.len(),
        from_cache,
        todo.len(),
        args.concurrency
    );
    let mut failures = vec![];
    let mut fetched = 0u64;
    {
        let (client, params, roots) = (&client, &args.network, &roots);
        let search = args.anchor_search;
        let mut results = stream::iter(todo.iter().copied())
            .map(|(height, index, txid)| async move {
                let result = fetch_tx(client, params, &txid).await.map(|(tx, mined)| {
                    // Trust the block we found it in if the server omits the height.
                    let mined = mined.or(Some(BlockHeight::from_u32(height)));
                    record(&tx, mined, Some(index), search, roots)
                });
                (height, txid, result)
            })
            .buffer_unordered(args.concurrency.max(1));
        while let Some((height, txid, result)) = results.next().await {
            match result {
                Ok(r) => {
                    if r.height != Some(height) {
                        notes.push(format!("{txid} was found at {height} but the server says it was mined at {:?}", r.height));
                    }
                    if let Some(c) = tx_cache.as_mut() {
                        c.write(&r)?;
                    }
                    records.insert(r.shape.txid.clone(), r);
                    fetched += 1;
                    if fetched.is_multiple_of(100) {
                        eprintln!("  transactions {fetched}/{} ({}s)", todo.len(), secs(t_txs));
                    }
                }
                Err(e) => {
                    eprintln!("  {txid} at {height}: {e:#}");
                    failures.push(Failure {
                        txid: txid.to_string(),
                        height,
                        error: format!("{e:#}"),
                    });
                }
            }
        }
    }
    let elapsed_txs = secs(t_txs);
    let mut population: Vec<TxRecord> = records.into_values().collect();
    population.sort_by_key(|r| (r.height, r.index));

    // 4. Compare: our transactions, placed in that population.
    let mut order: Vec<String> = vec![];
    for t in &args.compare {
        let id = parse_txid(t)?.to_string();
        if !order.contains(&id) {
            order.push(id);
        }
    }
    let compared: BTreeSet<String> = order.iter().cloned().collect();
    let mut comparisons = vec![];
    for txid in &order {
        let (rec, in_scan) = match population.iter().find(|r| &r.shape.txid == txid) {
            Some(r) => (r.clone(), true),
            None => {
                let (tx, mined) = fetch_tx(&client, &args.network, &parse_txid(txid)?).await?;
                if let Some(m) = mined {
                    roots
                        .ensure(&client, search_window(u32::from(m), args.anchor_search), args.concurrency)
                        .await?;
                }
                (record(&tx, mined, None, args.anchor_search, &roots), false)
            }
        };
        if !in_scan {
            notes.push(format!("compared transaction {txid} is outside the scanned range"));
        }
        comparisons.push(fingerprint::compare(&rec, &population, &compared, in_scan));
    }

    let compact: Vec<(Counts, bool)> = blocks
        .iter()
        .filter(in_range)
        .flat_map(|b| b.txs.iter().map(|t| (t.counts, t.index == 0)))
        .collect();
    let coinbase = |label: String, cb: bool| if cb { format!("coinbase {label}") } else { label };
    let report = Report {
        tool: format!("cadence-decode {} scan", env!("CARGO_PKG_VERSION")),
        network: args.network_name.into(),
        server: args.server.clone(),
        from,
        to,
        chain_tip: tip,
        anchor_search: args.anchor_search,
        generated_at_unix: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        notes,
        stats: Stats {
            blocks: to - from + 1,
            compact_txs: compact.len() as u64,
            orchard_family_txs: candidates.len() as u64,
            decoded: population.len() as u64,
            decoded_from_cache: from_cache,
            failed: failures.len() as u64,
            transparent_data_in_compact_blocks: transparent_data,
            tree_root_dedupe: dedupe,
            tree_state_window: (window_start, to),
            tree_states_fetched: roots.fetched,
            tree_states_from_cache: roots.loaded_from_cache,
            tree_states_derived: derived,
            transactions_fetched: fetched,
            retries: net::RETRIES.load(Ordering::Relaxed),
            elapsed_secs: Elapsed {
                blocks: elapsed_blocks,
                tree_states: elapsed_roots,
                transactions: elapsed_txs,
                total: secs(started),
            },
            ms_per_block: (started.elapsed().as_secs_f64() * 1000.0 / f64::from(to - from + 1)).round(),
        },
        population: Population {
            compact_by_pools: fingerprint::tally(compact.iter().map(|(c, cb)| coinbase(c.pools(), *cb))),
            compact_by_class: fingerprint::tally(compact.iter().map(|(c, cb)| coinbase(c.label(), *cb))),
            decoded_by_class: fingerprint::tally(population.iter().map(|r| class_label(&r.shape))),
        },
        classes: CLASSES.iter().map(|c| fingerprint::class_report(c, &population)).collect(),
        compare: comparisons,
        failures,
        records: args.include_records.then(|| population.clone()),
    };

    if let Some(out) = &args.out {
        if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(out, serde_json::to_string_pretty(&report)? + "\n")?;
        eprintln!("  wrote {}", out.display());
    }
    print_summary(&report);
    Ok(())
}

fn pct(share: f64) -> String {
    format!("{:.1}%", share * 100.0)
}

fn print_buckets(field: &str, buckets: &[fingerprint::Bucket], limit: usize) {
    let shown: Vec<String> = buckets
        .iter()
        .take(limit)
        .map(|b| format!("{} ×{} ({})", b.value, b.count, pct(b.share)))
        .collect();
    let rest = buckets.len().saturating_sub(limit);
    let more = if rest > 0 { format!(", +{rest} more values") } else { String::new() };
    println!("    {field:<26} {}{more}", shown.join(", "));
}

fn print_summary(r: &Report) {
    let s = &r.stats;
    println!();
    println!(
        "Fingerprint scan: {} {}..={} ({} blocks, tip {}), {}",
        r.network, r.from, r.to, s.blocks, r.chain_tip, r.server
    );
    println!(
        "  {} compact txs, {} with Orchard-family actions, {} decoded ({} from cache), {} failed",
        s.compact_txs, s.orchard_family_txs, s.decoded, s.decoded_from_cache, s.failed
    );
    println!(
        "  {} tree states fetched ({} cached, {} copied forward, dedupe {}), {} transactions fetched, {} retries",
        s.tree_states_fetched,
        s.tree_states_from_cache,
        s.tree_states_derived,
        if s.tree_root_dedupe { "on" } else { "off" },
        s.transactions_fetched,
        s.retries
    );
    println!(
        "  {:.1}s total (blocks {:.1}s, tree states {:.1}s, transactions {:.1}s), {} ms/block",
        s.elapsed_secs.total, s.elapsed_secs.blocks, s.elapsed_secs.tree_states, s.elapsed_secs.transactions, s.ms_per_block
    );
    for n in &r.notes {
        println!("  note: {n}");
    }

    println!("\nPopulation by pools (all compact txs):");
    for c in r.population.compact_by_pools.iter().take(10) {
        println!("  {:>6} {:>7}  {}", c.count, pct(c.share), c.label);
    }
    println!("\nOrchard-family txs by shape class (decoded):");
    for c in r.population.decoded_by_class.iter().take(15) {
        println!("  {:>6} {:>7}  {}", c.count, pct(c.share), c.label);
    }
    if r.population.decoded_by_class.len() > 15 {
        println!("  ... {} more classes in the report", r.population.decoded_by_class.len() - 15);
    }

    for class in &r.classes {
        println!("\nClass {}: {} txs", class.id, class.count);
        println!("  {}", class.description);
        for h in class.histograms.iter().filter(|h| h.field != "joint") {
            print_buckets(&h.field, &h.buckets, 8);
        }
        if let Some(joint) = class.histograms.iter().find(|h| h.field == "joint") {
            println!("    distinct joint fingerprints: {}", joint.buckets.len());
        }
        if let Some(known) = class.anchor_offset_known.filter(|k| *k > 0) {
            let profile: Vec<String> = class
                .anchor_offset_consistency
                .iter()
                .map(|o| format!("{}:{}", o.offset, pct(o.share)))
                .collect();
            println!(
                "    anchor = target-k consistent ({known} with inferable target): {}",
                profile.join(" ")
            );
        }
    }

    for c in &r.compare {
        println!(
            "\nCompare {} ({}, class {}: {} members, {} excluding the compared set)",
            c.txid,
            if c.in_scanned_range { "in range" } else { "outside range" },
            c.class,
            c.class_size,
            c.class_size_excluding_compared
        );
        for f in &c.fields {
            if f.field == "joint" {
                println!(
                    "    {:<26} {}/{} ({}), excluding compared {}/{} ({})",
                    "all fields at once",
                    f.count,
                    c.class_size,
                    pct(f.share),
                    f.count_excluding_compared,
                    c.class_size_excluding_compared,
                    pct(f.share_excluding_compared)
                );
            } else {
                println!(
                    "    {:<26} {:<12} {}/{} ({}), excluding compared {}/{} ({})",
                    f.field,
                    f.value,
                    f.count,
                    c.class_size,
                    pct(f.share),
                    f.count_excluding_compared,
                    c.class_size_excluding_compared,
                    pct(f.share_excluding_compared)
                );
            }
        }
    }
}
