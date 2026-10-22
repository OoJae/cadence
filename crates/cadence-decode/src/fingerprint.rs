//! Population statistics over decoded shapes: shape classes, per-field histograms,
//! and an "anonymity set" estimate for chosen transactions.
//!
//! This module is pure: the scanner feeds it [`TxRecord`]s, and it does no I/O.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};

use crate::Shape;

/// One decoded transaction from a scanned range.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TxRecord {
    /// Height of the block the scan found it in (`None` for a mempool transaction).
    pub height: Option<u32>,
    /// Position in that block.
    pub index: Option<u64>,
    pub coinbase: bool,
    /// The fee, when it is computable without spent-output lookups (no transparent inputs).
    pub fee: Option<u64>,
    /// How many heights below the mined height were searched for each anchor's root.
    pub anchor_search: u32,
    pub shape: Shape,
}

/// Action and component counts per pool; the key of a shape class.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Counts {
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
}

impl Counts {
    pub fn of(s: &Shape) -> Self {
        Counts {
            transparent_inputs: s.transparent_inputs,
            transparent_outputs: s.transparent_outputs,
            sapling_spends: s.sapling_spends,
            sapling_outputs: s.sapling_outputs,
            orchard_actions: s.orchard_actions,
            ironwood_actions: s.ironwood_actions,
        }
    }

    /// The pools a transaction touches, such as `transparent+orchard`.
    pub fn pools(&self) -> String {
        let mut pools = vec![];
        if self.transparent_inputs + self.transparent_outputs > 0 {
            pools.push("transparent");
        }
        if self.sapling_spends + self.sapling_outputs > 0 {
            pools.push("sapling");
        }
        if self.orchard_actions > 0 {
            pools.push("orchard");
        }
        if self.ironwood_actions > 0 {
            pools.push("ironwood");
        }
        if pools.is_empty() {
            "none".into()
        } else {
            pools.join("+")
        }
    }

    /// Pools with their counts, such as `t:1in/2out + orchard:2`.
    pub fn label(&self) -> String {
        let mut parts = vec![];
        if self.transparent_inputs + self.transparent_outputs > 0 {
            parts.push(format!("t:{}in/{}out", self.transparent_inputs, self.transparent_outputs));
        }
        if self.sapling_spends + self.sapling_outputs > 0 {
            parts.push(format!("sapling:{}sp/{}out", self.sapling_spends, self.sapling_outputs));
        }
        if self.orchard_actions > 0 {
            parts.push(format!("orchard:{}", self.orchard_actions));
        }
        if self.ironwood_actions > 0 {
            parts.push(format!("ironwood:{}", self.ironwood_actions));
        }
        if parts.is_empty() {
            "none".into()
        } else {
            parts.join(" + ")
        }
    }
}

/// The full shape-class label of a decoded transaction: version, pools and counts.
pub fn class_label(s: &Shape) -> String {
    format!("{} {}", s.version, Counts::of(s).label())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pool {
    Orchard,
    Ironwood,
}

/// A named subset of the population with the fields that fingerprint it.
pub struct ClassDef {
    pub id: &'static str,
    pub description: &'static str,
    /// The Orchard-family pool whose bundle fields are histogrammed, or `None` for the
    /// pool-agnostic field set.
    pub pool: Option<Pool>,
    pub member: fn(&Shape) -> bool,
}

fn no_other_pools(s: &Shape) -> bool {
    s.transparent_inputs == 0 && s.transparent_outputs == 0 && s.sapling_spends == 0 && s.sapling_outputs == 0
}

/// The shape class Cadence installments use.
pub const CADENCE_CLASS: ClassDef = ClassDef {
    id: "cadence_class",
    description: "V6, Ironwood-only (0 transparent, 0 Sapling, 0 Orchard-pool), 2 Ironwood actions: the shape Cadence installments use",
    pool: Some(Pool::Ironwood),
    member: |s| s.version == "V6" && no_other_pools(s) && s.orchard_actions == 0 && s.ironwood_actions == 2,
};

/// The same shape one pool over: what an ordinary 2-action shielded send looked like
/// before Ironwood activated (NU6.3: mainnet 3,428,143, testnet 4,134,000).
pub const ORCHARD_ANALOG: ClassDef = ClassDef {
    id: "orchard_analog",
    description: "Orchard-pool only (0 transparent, 0 Sapling, 0 Ironwood), 2 Orchard actions, any version: the pre-Ironwood equivalent of the Cadence class",
    pool: Some(Pool::Orchard),
    member: |s| no_other_pools(s) && s.ironwood_actions == 0 && s.orchard_actions == 2,
};

/// Every decoded transaction that has Orchard-family actions.
pub const ALL_ORCHARD_FAMILY: ClassDef = ClassDef {
    id: "all_orchard_family",
    description: "Every transaction with Orchard-pool or Ironwood actions, any shape",
    pool: None,
    member: |_| true,
};

/// The classes reported with full histograms, in report order.
pub const CLASSES: [&ClassDef; 3] = [&CADENCE_CLASS, &ORCHARD_ANALOG, &ALL_ORCHARD_FAMILY];

fn lock_time_class(s: &Shape) -> String {
    match s.lock_time {
        0 => "0".into(),
        t if t >= 500_000_000 => "unix-time".into(),
        t => match s.mined_height {
            Some(m) => format!("mined-{}", i64::from(m) - i64::from(t)),
            None => format!("height:{t}"),
        },
    }
}

fn expiry_class(s: &Shape) -> String {
    if s.expiry_height == 0 {
        return "no-expiry".into();
    }
    match s.expiry_minus_mined {
        Some(d) => d.to_string(),
        None => "unmined".into(),
    }
}

/// The root of the empty Orchard-shaped tree, which coinbase bundles (spends
/// disabled) use as their anchor.
pub fn empty_root_hex() -> &'static str {
    static EMPTY: OnceLock<String> = OnceLock::new();
    EMPTY.get_or_init(|| hex::encode(orchard::Anchor::empty_tree().to_bytes()))
}

fn depth_class(depths: Option<(i64, i64)>, anchor: Option<&String>, anchor_search: u32) -> String {
    match depths {
        Some((min, _)) => min.to_string(),
        None if anchor.is_some_and(|a| a == empty_root_hex()) => "empty-tree-root".into(),
        None => format!("unresolved(>{anchor_search})"),
    }
}

fn opt<T: ToString>(v: Option<T>) -> String {
    v.map(|v| v.to_string()).unwrap_or_else(|| "none".into())
}

/// NU7's consensus branch id. NU7 cuts block spacing to 25 s and scales the default
/// expiry delta from 40 to 120 blocks.
pub const NU7_BRANCH_ID: &str = "77190ad9";

/// The target height a stock wallet would have built this transaction for, taking its
/// expiry to be `target + default delta`. The delta is 40 blocks, or 120 under NU7;
/// some NU7 wallets still use 40, so the smallest default delta that fits is used.
/// `None` when none fits (no expiry, or an expiry further out than any default).
pub fn inferred_target(s: &Shape) -> Option<i64> {
    let ahead = s.expiry_minus_mined?;
    if s.expiry_height == 0 || ahead < 0 {
        return None;
    }
    let deltas: &[i64] = if s.branch_id == NU7_BRANCH_ID { &[40, 120] } else { &[40] };
    let delta = deltas.iter().find(|d| ahead <= **d)?;
    Some(i64::from(s.expiry_height) - delta)
}

/// The range of `target - anchor height` consistent with the anchor, with the target
/// from [`inferred_target`]. Unlike the depth below the mined height, this does not
/// grow when a transaction is mined late. The lower end is clamped at 1, because an
/// anchor cannot be newer than the tip the transaction was built on (`target - 1`).
pub fn anchor_offsets(s: &Shape, pool: Pool) -> Option<(i64, i64)> {
    let (lo, hi) = match pool {
        Pool::Ironwood => s.anchor_heights,
        Pool::Orchard => s.orchard_anchor_heights,
    }?;
    let target = inferred_target(s)?;
    let (min, max) = (target - i64::from(hi), target - i64::from(lo));
    (max >= 1).then_some((min.max(1), max))
}

fn offset_class(s: &Shape, pool: Pool) -> String {
    match anchor_offsets(s, pool) {
        Some((a, b)) if a == b => a.to_string(),
        Some((a, b)) => format!("{a}..{b}"),
        None => "unknown".into(),
    }
}

/// The fingerprinting fields of a record within a class, as `(field, value)` pairs.
/// A pool class adds `joint` (all the raw fields at once) and then
/// `anchor_offset_from_target`, which is derived from fields already in `joint`.
pub fn fields(pool: Option<Pool>, r: &TxRecord) -> Vec<(&'static str, String)> {
    let s = &r.shape;
    let mut out = match pool {
        Some(Pool::Ironwood) => vec![
            ("fee", opt(s.ironwood_value_balance)),
            ("expiry_minus_mined", expiry_class(s)),
            ("min_anchor_depth", depth_class(s.anchor_depths, s.ironwood_anchor.as_ref(), r.anchor_search)),
            ("flags", opt(s.ironwood_flags)),
            ("lock_time", lock_time_class(s)),
            ("proof_bytes", opt(s.ironwood_proof_bytes)),
            ("zero_ovk_recoverable", s.zero_ovk_recoverable.to_string()),
            ("branch_id", s.branch_id.clone()),
            ("version", s.version.clone()),
        ],
        Some(Pool::Orchard) => vec![
            ("fee", opt(s.orchard_value_balance)),
            ("expiry_minus_mined", expiry_class(s)),
            ("min_anchor_depth", depth_class(s.orchard_anchor_depths, s.orchard_anchor.as_ref(), r.anchor_search)),
            ("flags", opt(s.orchard_flags)),
            ("lock_time", lock_time_class(s)),
            ("proof_bytes", opt(s.orchard_proof_bytes)),
            ("zero_ovk_recoverable", opt(s.orchard_zero_ovk_recoverable)),
            ("branch_id", s.branch_id.clone()),
            ("version", s.version.clone()),
        ],
        None => {
            let mut v = vec![
                ("pools", Counts::of(s).pools()),
                ("version", s.version.clone()),
                ("branch_id", s.branch_id.clone()),
                (
                    "fee",
                    r.fee
                        .map(|f| f.to_string())
                        .unwrap_or_else(|| "unknown(transparent inputs)".into()),
                ),
                ("expiry_minus_mined", expiry_class(s)),
                ("lock_time", lock_time_class(s)),
            ];
            if s.orchard_actions > 0 {
                v.push((
                    "orchard_min_anchor_depth",
                    depth_class(s.orchard_anchor_depths, s.orchard_anchor.as_ref(), r.anchor_search),
                ));
            }
            if s.ironwood_actions > 0 {
                v.push((
                    "ironwood_min_anchor_depth",
                    depth_class(s.anchor_depths, s.ironwood_anchor.as_ref(), r.anchor_search),
                ));
            }
            return v;
        }
    };
    let joint = out
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    out.push(("joint", joint));
    if let Some(pool) = pool {
        out.push(("anchor_offset_from_target", offset_class(s, pool)));
    }
    out
}

#[derive(Clone, Debug, Serialize)]
pub struct Bucket {
    pub value: String,
    pub count: u64,
    pub share: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Histogram {
    pub field: String,
    /// Sorted by count, most common first.
    pub buckets: Vec<Bucket>,
}

impl Histogram {
    pub fn count_of(&self, value: &str) -> u64 {
        self.buckets.iter().find(|b| b.value == value).map(|b| b.count).unwrap_or(0)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ClassReport {
    pub id: String,
    pub description: String,
    pub count: u64,
    /// Member txids (at most [`MAX_MEMBERS`]).
    pub members: Vec<String>,
    pub members_truncated: bool,
    pub histograms: Vec<Histogram>,
    /// Members whose anchor offset from the target could be inferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_offset_known: Option<u64>,
    /// For each offset `k`, how many of those members' anchors are consistent with
    /// `anchor = target - k` (an anchor root that held over several heights is
    /// consistent with several offsets). Cadence anchors at `k = 3`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub anchor_offset_consistency: Vec<OffsetConsistency>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OffsetConsistency {
    pub offset: i64,
    pub consistent: u64,
    pub share: f64,
}

pub const MAX_MEMBERS: usize = 100;

/// Offsets reported in [`ClassReport::anchor_offset_consistency`].
pub const OFFSETS: std::ops::RangeInclusive<i64> = 1..=10;

fn share(count: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        // Four decimal places keep the report readable.
        (count as f64 / total as f64 * 10_000.0).round() / 10_000.0
    }
}

/// Histograms of `values` (one `(field, value)` list per member), fields in first-seen order.
fn histograms(values: &[Vec<(&'static str, String)>]) -> Vec<Histogram> {
    let mut order: Vec<&'static str> = vec![];
    let mut counts: BTreeMap<&'static str, BTreeMap<String, u64>> = BTreeMap::new();
    for member in values {
        for (field, value) in member {
            if !order.contains(field) {
                order.push(field);
            }
            *counts.entry(field).or_default().entry(value.clone()).or_default() += 1;
        }
    }
    let total = values.len() as u64;
    order
        .into_iter()
        .map(|field| {
            let mut buckets: Vec<Bucket> = counts[field]
                .iter()
                .map(|(value, count)| Bucket {
                    value: value.clone(),
                    count: *count,
                    share: share(*count, total),
                })
                .collect();
            buckets.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| numeric_order(&a.value, &b.value)));
            Histogram {
                field: field.to_string(),
                buckets,
            }
        })
        .collect()
}

/// Orders numeric values numerically and everything else after them, lexically.
pub fn numeric_order(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<i64>(), b.parse::<i64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        (Err(_), Err(_)) => a.cmp(b),
    }
}

pub fn class_report(class: &ClassDef, records: &[TxRecord]) -> ClassReport {
    let members: Vec<&TxRecord> = records.iter().filter(|r| (class.member)(&r.shape)).collect();
    let values: Vec<_> = members.iter().map(|r| fields(class.pool, r)).collect();
    let offsets: Vec<(i64, i64)> = class
        .pool
        .map(|pool| members.iter().filter_map(|r| anchor_offsets(&r.shape, pool)).collect())
        .unwrap_or_default();
    let known = offsets.len() as u64;
    ClassReport {
        id: class.id.into(),
        description: class.description.into(),
        count: members.len() as u64,
        members: members.iter().take(MAX_MEMBERS).map(|r| r.shape.txid.clone()).collect(),
        members_truncated: members.len() > MAX_MEMBERS,
        histograms: histograms(&values),
        anchor_offset_known: class.pool.map(|_| known),
        anchor_offset_consistency: if known == 0 {
            vec![]
        } else {
            OFFSETS
                .map(|k| {
                    let consistent = offsets.iter().filter(|(a, b)| *a <= k && k <= *b).count() as u64;
                    OffsetConsistency {
                        offset: k,
                        consistent,
                        share: share(consistent, known),
                    }
                })
                .collect()
        },
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LabelCount {
    pub label: String,
    pub count: u64,
    pub share: f64,
}

/// Counts per label, most common first.
pub fn tally(labels: impl IntoIterator<Item = String>) -> Vec<LabelCount> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    let mut total = 0u64;
    for l in labels {
        *counts.entry(l).or_default() += 1;
        total += 1;
    }
    let mut out: Vec<LabelCount> = counts
        .into_iter()
        .map(|(label, count)| LabelCount {
            share: share(count, total),
            label,
            count,
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
    out
}

#[derive(Clone, Debug, Serialize)]
pub struct FieldMatch {
    pub field: String,
    pub value: String,
    /// Class members in the scanned range that share this value (the compared
    /// transaction itself included, if it is in the range).
    pub count: u64,
    pub share: f64,
    /// The same, after removing every `--compare` transaction from the population, so
    /// that our own installments do not inflate their own anonymity set.
    pub count_excluding_compared: u64,
    pub share_excluding_compared: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Comparison {
    pub txid: String,
    /// The class the transaction is compared within: a reported class id, or its own
    /// exact shape-class label when it is in none of them.
    pub class: String,
    pub class_description: String,
    pub in_scanned_range: bool,
    pub class_size: u64,
    pub class_size_excluding_compared: u64,
    pub fields: Vec<FieldMatch>,
    pub shape: Shape,
}

/// Places `target` in the population: for each fingerprinting field, how many members
/// of its class share its value.
pub fn compare(
    target: &TxRecord,
    population: &[TxRecord],
    compared: &BTreeSet<String>,
    in_scanned_range: bool,
) -> Comparison {
    let own_label = class_label(&target.shape);
    let (class, description, pool, members): (String, String, Option<Pool>, Vec<&TxRecord>) =
        match [&CADENCE_CLASS, &ORCHARD_ANALOG]
            .into_iter()
            .find(|c| (c.member)(&target.shape))
        {
            Some(c) => (
                c.id.into(),
                c.description.into(),
                c.pool,
                population.iter().filter(|r| (c.member)(&r.shape)).collect(),
            ),
            None => (
                own_label.clone(),
                format!("transactions of exactly this shape class ({own_label})"),
                None,
                population
                    .iter()
                    .filter(|r| class_label(&r.shape) == own_label)
                    .collect(),
            ),
        };
    let others: Vec<&TxRecord> = members
        .iter()
        .copied()
        .filter(|r| !compared.contains(&r.shape.txid))
        .collect();
    let member_values: Vec<_> = members.iter().map(|r| fields(pool, r)).collect();
    let other_values: Vec<_> = others.iter().map(|r| fields(pool, r)).collect();
    let all = histograms(&member_values);
    let excl = histograms(&other_values);
    let count_in = |hs: &[Histogram], field: &str, value: &str| {
        hs.iter().find(|h| h.field == field).map(|h| h.count_of(value)).unwrap_or(0)
    };
    let (n, n_excl) = (members.len() as u64, others.len() as u64);
    Comparison {
        txid: target.shape.txid.clone(),
        class,
        class_description: description,
        in_scanned_range,
        class_size: n,
        class_size_excluding_compared: n_excl,
        fields: fields(pool, target)
            .into_iter()
            .map(|(field, value)| {
                let count = count_in(&all, field, &value);
                let count_excl = count_in(&excl, field, &value);
                FieldMatch {
                    field: field.into(),
                    share: share(count, n),
                    count_excluding_compared: count_excl,
                    share_excluding_compared: share(count_excl, n_excl),
                    count,
                    value,
                }
            })
            .collect(),
        shape: target.shape.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installment(txid: &str, expiry_minus_mined: i64, depths: Option<(i64, i64)>) -> TxRecord {
        let mined: u32 = 1_000;
        TxRecord {
            height: Some(mined),
            index: Some(1),
            coinbase: false,
            fee: Some(10_000),
            anchor_search: 12,
            shape: Shape {
                txid: txid.into(),
                version: "V6".into(),
                branch_id: "77190ad9".into(),
                lock_time: 0,
                expiry_height: (i64::from(mined) + expiry_minus_mined) as u32,
                mined_height: Some(mined),
                expiry_minus_mined: Some(expiry_minus_mined),
                transparent_inputs: 0,
                transparent_outputs: 0,
                sapling_spends: 0,
                sapling_outputs: 0,
                orchard_actions: 0,
                ironwood_actions: 2,
                ironwood_flags: Some(7),
                ironwood_value_balance: Some(10_000),
                ironwood_anchor: Some("00".repeat(32)),
                anchor_heights: depths.map(|(lo, hi)| ((i64::from(mined) - hi) as u32, (i64::from(mined) - lo) as u32)),
                anchor_depths: depths,
                ironwood_proof_bytes: Some(7264),
                zero_ovk_recoverable: 0,
                supplied_ovk_recoverable: 0,
                orchard_flags: None,
                orchard_value_balance: None,
                orchard_anchor: None,
                orchard_anchor_heights: None,
                orchard_anchor_depths: None,
                orchard_proof_bytes: None,
                orchard_zero_ovk_recoverable: None,
            },
        }
    }

    #[test]
    fn classes_and_labels() {
        let mut r = installment("a", 120, Some((3, 3)));
        assert!((CADENCE_CLASS.member)(&r.shape));
        assert!(!(ORCHARD_ANALOG.member)(&r.shape));
        assert_eq!(class_label(&r.shape), "V6 ironwood:2");
        r.shape.transparent_outputs = 1;
        assert!(!(CADENCE_CLASS.member)(&r.shape));
        assert_eq!(class_label(&r.shape), "V6 t:0in/1out + ironwood:2");
        assert_eq!(Counts::of(&r.shape).pools(), "transparent+ironwood");
    }

    #[test]
    fn depth_buckets() {
        let resolved = installment("a", 120, Some((3, 5)));
        let unresolved = installment("b", 120, None);
        let mut coinbase = installment("c", 0, None);
        coinbase.shape.ironwood_anchor = Some(empty_root_hex().to_string());
        let depth = |r: &TxRecord| {
            fields(Some(Pool::Ironwood), r)
                .into_iter()
                .find(|(f, _)| *f == "min_anchor_depth")
                .unwrap()
                .1
        };
        assert_eq!(depth(&resolved), "3");
        assert_eq!(depth(&unresolved), "unresolved(>12)");
        assert_eq!(depth(&coinbase), "empty-tree-root");
    }

    #[test]
    fn compare_excludes_the_compared_set() {
        let ours = installment("ours", 117, Some((3, 3)));
        let population = vec![
            ours.clone(),
            installment("x", 117, Some((3, 3))),
            installment("y", 119, Some((1, 4))),
            installment("z", 120, Some((3, 6))),
        ];
        let compared: BTreeSet<String> = ["ours".to_string()].into();
        let c = compare(&ours, &population, &compared, true);
        assert_eq!(c.class, "cadence_class");
        assert_eq!((c.class_size, c.class_size_excluding_compared), (4, 3));
        let field = |name: &str| c.fields.iter().find(|f| f.field == name).unwrap();
        assert_eq!(field("fee").count, 4);
        assert_eq!(field("expiry_minus_mined").count, 2);
        assert_eq!(field("expiry_minus_mined").count_excluding_compared, 1);
        assert_eq!(field("min_anchor_depth").count_excluding_compared, 2);
        // Only "x" matches every field at once.
        assert_eq!(field("joint").count_excluding_compared, 1);
        assert_eq!(field("joint").share_excluding_compared, 0.3333);
    }

    #[test]
    fn anchor_offset_inference() {
        // Testnet installment 1: expiry target + 120 under NU7, mined one block late,
        // anchor root held from target - 3 to target - 1.
        let mut r = installment("a", 119, Some((2, 4)));
        assert_eq!(inferred_target(&r.shape), Some(999));
        assert_eq!(anchor_offsets(&r.shape, Pool::Ironwood), Some((1, 3)));
        // A pre-NU7 branch uses the 40-block default.
        r.shape.branch_id = "37a5165b".into();
        r.shape.expiry_minus_mined = Some(39);
        r.shape.expiry_height = 1_039;
        assert_eq!(inferred_target(&r.shape), Some(999));
        // An expiry no default delta explains gives no offset.
        r.shape.expiry_minus_mined = Some(3_435);
        r.shape.expiry_height = 4_435;
        assert_eq!(anchor_offsets(&r.shape, Pool::Ironwood), None);
        let report = class_report(&CADENCE_CLASS, &[installment("b", 120, Some((3, 3)))]);
        assert_eq!(report.anchor_offset_known, Some(1));
        let at = |k: i64| report.anchor_offset_consistency.iter().find(|o| o.offset == k).unwrap().consistent;
        assert_eq!((at(2), at(3), at(4)), (0, 1, 0));
    }

    #[test]
    fn histogram_order() {
        let population = vec![
            installment("a", 119, Some((1, 1))),
            installment("b", 120, Some((1, 1))),
            installment("c", 120, Some((2, 2))),
        ];
        let report = class_report(&CADENCE_CLASS, &population);
        assert_eq!(report.count, 3);
        let expiry = report
            .histograms
            .iter()
            .find(|h| h.field == "expiry_minus_mined")
            .unwrap();
        assert_eq!(expiry.buckets[0].value, "120");
        assert_eq!(expiry.buckets[0].count, 2);
        assert_eq!(expiry.buckets[1].value, "119");
    }
}
