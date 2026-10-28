//! The runner's own records: offers, pockets, subscriptions and their installments.
//!
//! Sealed packages are kept exactly as uploaded. Once a package opens, only the
//! (public) drand beacon is stored next to it; the plaintext ladder is re-derived in
//! memory when needed, so nothing readable sits at rest. Finished subscriptions are
//! shredded: their sealed packages and beacons are deleted. A few keep their pocket
//! for a while first (`refund.rs`): until the payer refunds after a stop or a miss,
//! and on the sandbox, a cancel's voided packages for the charge-after-cancel demo.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub struct Store {
    conn: Connection,
}

#[derive(Clone, Serialize)]
pub struct Offer {
    pub offer_id: String,
    pub name: String,
    pub amount_zat: u64,
    pub period_secs: u64,
    pub count: u32,
    pub merchant_ua: String,
    pub created_at: u64,
    /// How much later installment 1 releases than it would without a trial.
    pub trial_secs: u64,
    pub quote: Option<Quote>,
}

/// The merchant's own fiat label for an offer, shown to payers. `amount_zat` stays
/// what is paid; nothing checks that the two agree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Quote {
    pub currency: String,
    /// The price per installment, in minor units.
    pub amount_minor: u64,
    /// Minor units per 1 ZEC, the rate the merchant used.
    pub zec_rate_minor: u64,
    pub set_at: u64,
}

impl Quote {
    pub fn check(&self) -> Result<(), String> {
        if self.currency.len() != 3 || !self.currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err("quote.currency must be 3 uppercase letters".into());
        }
        if !(1..=1_000_000_000).contains(&self.amount_minor) {
            return Err("quote.amount_minor must be between 1 and 10^9".into());
        }
        if !(1..=1_000_000_000_000).contains(&self.zec_rate_minor) {
            return Err("quote.zec_rate_minor must be between 1 and 10^12".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
pub struct Funding {
    pub txid: String,
    pub tx_hex: String,
    pub mined_height: u32,
    pub value_zat: u64,
}

#[derive(Clone)]
pub struct Pocket {
    pub pocket_id: String,
    pub account: String,
    pub ufvk: String,
    pub birthday: u32,
    pub funding: Option<Funding>,
    pub subscription_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Installment {
    pub k: u32,
    pub amount_zat: u64,
    pub release_round: u64,
    pub release_at: u64,
    pub state: String,
    pub txid: Option<String>,
    pub target_height: Option<u32>,
    pub expiry_height: Option<u32>,
    pub mined_height: Option<u32>,
    #[serde(skip)]
    pub sealed: Option<Vec<u8>>,
    #[serde(skip)]
    pub beacon: Option<Vec<u8>>,
}

#[derive(Clone, Serialize)]
pub struct Subscription {
    pub subscription_id: String,
    pub offer_id: String,
    pub pocket_id: String,
    pub status: String,
    pub created_at: u64,
    pub funding: Option<FundingView>,
    pub installments: Vec<Installment>,
    /// The subscription was stopped or stalled, and its pocket is still kept for the
    /// payer to refund what is left.
    pub refundable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund: Option<Refund>,
    /// The hex Ed25519 key that signs the payer's requests (`payer_auth.rs`).
    #[serde(skip)]
    pub payer_auth_key: Option<String>,
    /// When the kept pocket is shredded, while it is kept.
    #[serde(skip)]
    pub keep_until: Option<u64>,
}

/// The payer's transaction that spent what a stopped or stalled pocket had left.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Refund {
    pub txid: String,
    pub mined_height: u32,
}

/// A subscription's own row.
struct Head {
    id: String,
    offer_id: String,
    pocket_id: String,
    status: String,
    created_at: u64,
    payer_auth_key: Option<String>,
    keep_until: Option<u64>,
    released: bool,
    refund: Option<Refund>,
}

#[derive(Clone, Serialize)]
pub struct FundingView {
    pub txid: String,
    pub mined_height: u32,
    pub amount_zat: u64,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS offers (
                 offer_id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_zat INTEGER NOT NULL,
                 period_secs INTEGER NOT NULL, count INTEGER NOT NULL, merchant_ua TEXT NOT NULL,
                 created_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS pockets (
                 pocket_id TEXT PRIMARY KEY, account TEXT NOT NULL, ufvk TEXT NOT NULL,
                 birthday INTEGER NOT NULL, created_at INTEGER NOT NULL,
                 funding_txid TEXT, funding_tx_hex TEXT, funding_height INTEGER, funding_value INTEGER,
                 subscription_id TEXT);
             CREATE TABLE IF NOT EXISTS subscriptions (
                 subscription_id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, pocket_id TEXT NOT NULL,
                 status TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS installments (
                 subscription_id TEXT NOT NULL, k INTEGER NOT NULL, amount_zat INTEGER NOT NULL,
                 release_round INTEGER NOT NULL, release_at INTEGER NOT NULL, state TEXT NOT NULL,
                 sealed BLOB, beacon BLOB, txid TEXT, target_height INTEGER, expiry_height INTEGER,
                 mined_height INTEGER, PRIMARY KEY (subscription_id, k));",
        )?;
        let store = Store { conn };
        store.migrate()?;
        // Pockets of subscriptions that ended before shredding covered their keys.
        store.conn.execute(
            "UPDATE pockets SET ufvk = '', funding_tx_hex = NULL
             WHERE ufvk != '' AND subscription_id IN
               (SELECT subscription_id FROM subscriptions WHERE status NOT IN ('active', 'stalled'))",
            [],
        )?;
        // A sandbox cancel's voided packages stay for their hour (`refund.rs`).
        store.conn.execute(
            "UPDATE installments SET sealed = NULL, beacon = NULL
             WHERE (sealed IS NOT NULL OR beacon IS NOT NULL) AND subscription_id IN
               (SELECT subscription_id FROM subscriptions
                WHERE status NOT IN ('active', 'stalled') AND keep_until IS NULL)",
            [],
        )?;
        store.checkpoint()?;
        Ok(store)
    }

    /// Brings a database made by an older runner up to date. Each step only adds a
    /// column, so the older runner can still open the file.
    fn migrate(&self) -> Result<()> {
        self.add_column("offers", "trial_secs", "INTEGER NOT NULL DEFAULT 0")?;
        self.add_column("offers", "quote", "TEXT")?;
        self.add_column("subscriptions", "payer_auth_key", "TEXT")?;
        if self.add_column("subscriptions", "keep_until", "INTEGER")? {
            // Stalled pockets used to be kept until the payer emptied them; they now
            // go after the refund window, counted from this upgrade.
            let until = crate::service::now() + crate::refund::REFUND_KEEP_SECS;
            self.conn.execute("UPDATE subscriptions SET keep_until = ?1 WHERE status = 'stalled'", [until])?;
        }
        self.add_column("subscriptions", "released_at", "INTEGER")?;
        self.add_column("subscriptions", "refund_txid", "TEXT")?;
        self.add_column("subscriptions", "refund_height", "INTEGER")?;
        Ok(())
    }

    /// Adds `column` to `table` unless it is there already. Returns whether it was added.
    fn add_column(&self, table: &str, column: &str, decl: &str) -> Result<bool> {
        let present: bool = self.conn.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2",
            [table, column],
            |r| r.get(0),
        )?;
        if !present {
            self.conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
        }
        Ok(!present)
    }

    pub fn insert_offer(&self, o: &Offer) -> Result<()> {
        let quote = o.quote.as_ref().map(serde_json::to_string).transpose()?;
        self.conn.execute(
            "INSERT INTO offers (offer_id, name, amount_zat, period_secs, count, merchant_ua, created_at, trial_secs, quote)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![o.offer_id, o.name, o.amount_zat, o.period_secs, o.count, o.merchant_ua, o.created_at, o.trial_secs, quote],
        )?;
        Ok(())
    }

    pub fn offer(&self, id: &str) -> Result<Option<Offer>> {
        let row = self
            .conn
            .query_row(
                "SELECT offer_id, name, amount_zat, period_secs, count, merchant_ua, created_at, trial_secs, quote
                 FROM offers WHERE offer_id = ?1",
                [id],
                |r| {
                    let offer = Offer {
                        offer_id: r.get(0)?,
                        name: r.get(1)?,
                        amount_zat: r.get(2)?,
                        period_secs: r.get(3)?,
                        count: r.get(4)?,
                        merchant_ua: r.get(5)?,
                        created_at: r.get(6)?,
                        trial_secs: r.get(7)?,
                        quote: None,
                    };
                    Ok((offer, r.get::<_, Option<String>>(8)?))
                },
            )
            .optional()?;
        row.map(|(offer, quote)| Ok(Offer { quote: quote.as_deref().map(serde_json::from_str).transpose()?, ..offer }))
            .transpose()
    }

    pub fn insert_pocket(&self, id: &str, account: &str, ufvk: &str, birthday: u32, now: u64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO pockets (pocket_id, account, ufvk, birthday, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, account, ufvk, birthday, now],
        )?;
        Ok(())
    }

    fn pocket_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Pocket> {
        let funding = match r.get::<_, Option<String>>(4)? {
            Some(txid) => Some(Funding {
                txid,
                tx_hex: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                mined_height: r.get(6)?,
                value_zat: r.get(7)?,
            }),
            None => None,
        };
        Ok(Pocket {
            pocket_id: r.get(0)?,
            account: r.get(1)?,
            ufvk: r.get(2)?,
            birthday: r.get(3)?,
            funding,
            subscription_id: r.get(8)?,
        })
    }

    const POCKET_COLUMNS: &'static str = "pocket_id, account, ufvk, birthday, funding_txid, funding_tx_hex,
        funding_height, funding_value, subscription_id";

    pub fn pocket(&self, id: &str) -> Result<Option<Pocket>> {
        let sql = format!("SELECT {} FROM pockets WHERE pocket_id = ?1", Self::POCKET_COLUMNS);
        Ok(self.conn.query_row(&sql, [id], Self::pocket_row).optional()?)
    }

    pub fn unfunded_pockets(&self) -> Result<Vec<Pocket>> {
        let sql = format!("SELECT {} FROM pockets WHERE funding_txid IS NULL", Self::POCKET_COLUMNS);
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], Self::pocket_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_funding(&self, pocket_id: &str, f: &Funding) -> Result<()> {
        self.conn.execute(
            "UPDATE pockets SET funding_txid = ?2, funding_tx_hex = ?3, funding_height = ?4, funding_value = ?5
             WHERE pocket_id = ?1",
            params![pocket_id, f.txid, f.tx_hex, f.mined_height, f.value_zat],
        )?;
        Ok(())
    }

    pub fn insert_subscription(
        &mut self,
        id: &str,
        offer_id: &str,
        pocket_id: &str,
        now: u64,
        installments: &[Installment],
        payer_auth_key: Option<&str>,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO subscriptions (subscription_id, offer_id, pocket_id, status, created_at, payer_auth_key)
             VALUES (?1, ?2, ?3, 'active', ?4, ?5)",
            params![id, offer_id, pocket_id, now, payer_auth_key],
        )?;
        tx.execute(
            "UPDATE pockets SET subscription_id = ?2 WHERE pocket_id = ?1",
            params![pocket_id, id],
        )?;
        for i in installments {
            tx.execute(
                "INSERT INTO installments (subscription_id, k, amount_zat, release_round, release_at, state, sealed)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'sealed', ?6)",
                params![id, i.k, i.amount_zat, i.release_round, i.release_at, i.sealed],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    fn installments(&self, subscription_id: &str) -> Result<Vec<Installment>> {
        let mut stmt = self.conn.prepare(
            "SELECT k, amount_zat, release_round, release_at, state, txid, target_height, expiry_height,
                    mined_height, sealed, beacon
             FROM installments WHERE subscription_id = ?1 ORDER BY k",
        )?;
        let rows = stmt.query_map([subscription_id], |r| {
            Ok(Installment {
                k: r.get(0)?,
                amount_zat: r.get(1)?,
                release_round: r.get(2)?,
                release_at: r.get(3)?,
                state: r.get(4)?,
                txid: r.get(5)?,
                target_height: r.get(6)?,
                expiry_height: r.get(7)?,
                mined_height: r.get(8)?,
                sealed: r.get(9)?,
                beacon: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    const SUBSCRIPTION_COLUMNS: &'static str = "subscription_id, offer_id, pocket_id, status, created_at,
        payer_auth_key, keep_until, released_at, refund_txid, refund_height";

    fn head_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Head> {
        let refund = match (r.get::<_, Option<String>>(8)?, r.get::<_, Option<u32>>(9)?) {
            (Some(txid), Some(mined_height)) => Some(Refund { txid, mined_height }),
            _ => None,
        };
        Ok(Head {
            id: r.get(0)?,
            offer_id: r.get(1)?,
            pocket_id: r.get(2)?,
            status: r.get(3)?,
            created_at: r.get(4)?,
            payer_auth_key: r.get(5)?,
            keep_until: r.get(6)?,
            released: r.get::<_, Option<u64>>(7)?.is_some(),
            refund,
        })
    }

    fn subscription_from(&self, head: Head) -> Result<Subscription> {
        let funding = self.pocket(&head.pocket_id)?.and_then(|p| p.funding).map(|f| FundingView {
            txid: f.txid,
            mined_height: f.mined_height,
            amount_zat: f.value_zat,
        });
        let kept = head.keep_until.is_some() && !head.released;
        Ok(Subscription {
            installments: self.installments(&head.id)?,
            refundable: kept && head.refund.is_none() && matches!(head.status.as_str(), "stopped" | "stalled"),
            subscription_id: head.id,
            offer_id: head.offer_id,
            pocket_id: head.pocket_id,
            status: head.status,
            created_at: head.created_at,
            funding,
            refund: head.refund,
            payer_auth_key: head.payer_auth_key,
            keep_until: head.keep_until.filter(|_| kept),
        })
    }

    fn subscriptions_where(&self, condition: &str, order: &str) -> Result<Vec<Subscription>> {
        let sql = format!("SELECT {} FROM subscriptions WHERE {condition} ORDER BY {order}", Self::SUBSCRIPTION_COLUMNS);
        let mut stmt = self.conn.prepare(&sql)?;
        let heads = stmt.query_map([], Self::head_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        heads.into_iter().map(|head| self.subscription_from(head)).collect()
    }

    /// With `only_active`, those the scheduler advances: active ones, and stalled ones
    /// whose pocket is still kept.
    pub fn subscriptions(&self, only_active: bool) -> Result<Vec<Subscription>> {
        if only_active {
            self.subscriptions_where("status = 'active' OR (status = 'stalled' AND released_at IS NULL)", "created_at")
        } else {
            self.subscriptions_where("1", "created_at DESC")
        }
    }

    /// Subscriptions whose pocket is kept past their end (`refund.rs`).
    pub fn kept_subscriptions(&self) -> Result<Vec<Subscription>> {
        self.subscriptions_where("keep_until IS NOT NULL AND released_at IS NULL", "created_at")
    }

    pub fn subscription(&self, id: &str) -> Result<Option<Subscription>> {
        let sql = format!("SELECT {} FROM subscriptions WHERE subscription_id = ?1", Self::SUBSCRIPTION_COLUMNS);
        let head = self.conn.query_row(&sql, [id], Self::head_row).optional()?;
        head.map(|head| self.subscription_from(head)).transpose()
    }

    /// Keeps the subscription's pocket until `until`, or until the earlier time it is
    /// kept until already.
    pub fn keep_until(&self, subscription_id: &str, until: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE subscriptions SET keep_until = MIN(COALESCE(keep_until, ?2), ?2) WHERE subscription_id = ?1",
            params![subscription_id, until],
        )?;
        Ok(())
    }

    /// The kept pocket was shredded at `at`.
    pub fn set_released(&self, subscription_id: &str, at: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE subscriptions SET released_at = ?2 WHERE subscription_id = ?1",
            params![subscription_id, at],
        )?;
        Ok(())
    }

    pub fn set_refund(&self, subscription_id: &str, refund: &Refund) -> Result<()> {
        self.conn.execute(
            "UPDATE subscriptions SET refund_txid = ?2, refund_height = ?3 WHERE subscription_id = ?1",
            params![subscription_id, refund.txid, refund.mined_height],
        )?;
        Ok(())
    }

    /// Installment `k` cannot be released (`state` is `missed` or `invalid`): the
    /// subscription stalls, and its pocket is kept for the payer's refund until `keep_until`.
    pub fn stall(&mut self, subscription_id: &str, k: u32, state: &str, keep_until: u64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE installments SET state = ?3 WHERE subscription_id = ?1 AND k = ?2",
            params![subscription_id, k, state],
        )?;
        tx.execute(
            "UPDATE subscriptions SET status = 'stalled', keep_until = MIN(COALESCE(keep_until, ?2), ?2)
             WHERE subscription_id = ?1",
            params![subscription_id, keep_until],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_status(&self, subscription_id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE subscriptions SET status = ?2 WHERE subscription_id = ?1",
            params![subscription_id, status],
        )?;
        Ok(())
    }

    /// A payer's re-sign: replaces the packages of an active subscription's sealed
    /// installments, given as `(k, release_round, sealed)`, all of them or none. The
    /// error says what changed since the request was checked: the subscription ended,
    /// or an installment opened. The packages replaced are scrubbed from the file.
    pub fn replace_sealed(&mut self, subscription_id: &str, packages: &[(u32, u64, Vec<u8>)]) -> Result<Result<(), String>> {
        let tx = self.conn.transaction()?;
        let status: String = tx.query_row(
            "SELECT status FROM subscriptions WHERE subscription_id = ?1",
            [subscription_id],
            |r| r.get(0),
        )?;
        if status != "active" {
            return Ok(Err(format!("the subscription is {status} now, so its packages were left as they were")));
        }
        for (k, round, sealed) in packages {
            let replaced = tx.execute(
                "UPDATE installments SET sealed = ?4
                 WHERE subscription_id = ?1 AND k = ?2 AND release_round = ?3 AND state = 'sealed'",
                params![subscription_id, k, round, sealed],
            )?;
            if replaced != 1 {
                return Ok(Err(format!(
                    "installment {k} opened while the re-sign was checked; nothing was replaced. Re-sign what is still sealed"
                )));
            }
        }
        let sealed: usize = tx.query_row(
            "SELECT COUNT(*) FROM installments WHERE subscription_id = ?1 AND state = 'sealed'",
            [subscription_id],
            |r| r.get(0),
        )?;
        if sealed != packages.len() {
            return Ok(Err(format!("{sealed} installments are sealed, but {} packages were given", packages.len())));
        }
        tx.commit()?;
        self.checkpoint()?;
        Ok(Ok(()))
    }

    pub fn set_beacon(&self, subscription_id: &str, k: u32, beacon: &[u8]) -> Result<()> {
        self.conn.execute(
            "UPDATE installments SET beacon = ?3, state = 'due' WHERE subscription_id = ?1 AND k = ?2",
            params![subscription_id, k, beacon],
        )?;
        Ok(())
    }

    pub fn set_state(&self, subscription_id: &str, k: u32, state: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE installments SET state = ?3 WHERE subscription_id = ?1 AND k = ?2",
            params![subscription_id, k, state],
        )?;
        Ok(())
    }

    pub fn set_broadcast(&self, subscription_id: &str, k: u32, txid: &str, target: u32, expiry: u32) -> Result<()> {
        self.conn.execute(
            "UPDATE installments SET state = 'broadcast', txid = ?3, target_height = ?4, expiry_height = ?5
             WHERE subscription_id = ?1 AND k = ?2",
            params![subscription_id, k, txid, target, expiry],
        )?;
        Ok(())
    }

    pub fn set_mined(&self, subscription_id: &str, k: u32, height: u32) -> Result<()> {
        self.conn.execute(
            "UPDATE installments SET state = 'mined', mined_height = ?3 WHERE subscription_id = ?1 AND k = ?2",
            params![subscription_id, k, height],
        )?;
        Ok(())
    }

    /// Marks every not-yet-mined installment with `state`.
    pub fn close_remaining(&self, subscription_id: &str, state: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE installments SET state = ?2 WHERE subscription_id = ?1 AND state NOT IN ('mined')",
            params![subscription_id, state],
        )?;
        Ok(())
    }

    /// Deletes everything that could ever open again or see into the pocket: sealed
    /// packages, beacons, the pocket's viewing key and its funding transaction.
    pub fn shred(&self, subscription_id: &str) -> Result<()> {
        self.shred_but(subscription_id, "")
    }

    /// As [`Store::shred`], but keeps the packages of the installments a cancel voided.
    pub fn shred_but_voided(&self, subscription_id: &str) -> Result<()> {
        self.shred_but(subscription_id, "cancelled")
    }

    fn shred_but(&self, subscription_id: &str, kept_state: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE installments SET sealed = NULL, beacon = NULL WHERE subscription_id = ?1 AND state != ?2",
            [subscription_id, kept_state],
        )?;
        self.conn.execute(
            "UPDATE pockets SET ufvk = '', funding_tx_hex = NULL WHERE subscription_id = ?1",
            [subscription_id],
        )?;
        self.checkpoint()
    }

    /// Pockets nobody subscribed with: unfunded since `unfunded_before`, or funded
    /// but never given packages since `funded_before`.
    pub fn abandoned_pockets(&self, unfunded_before: u64, funded_before: u64) -> Result<Vec<Pocket>> {
        let sql = format!(
            "SELECT {} FROM pockets WHERE subscription_id IS NULL
             AND ((funding_txid IS NULL AND created_at < ?1) OR (funding_txid IS NOT NULL AND created_at < ?2))",
            Self::POCKET_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![unfunded_before, funded_before], Self::pocket_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn delete_pocket(&self, pocket_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM pockets WHERE pocket_id = ?1", [pocket_id])?;
        self.checkpoint()
    }

    /// `secure_delete` overwrites what is deleted from now on. `VACUUM` rewrites the
    /// file, so free pages left by earlier writes keep no copy either, and the WAL
    /// is then folded back in and emptied. (The filesystem may still hold older
    /// blocks; the runner's disk should be encrypted.)
    fn checkpoint(&self) -> Result<()> {
        self.conn.execute_batch("VACUUM")?;
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn pocket_for_subscription(&self, subscription_id: &str) -> Result<Pocket> {
        let sql = format!("SELECT {} FROM pockets WHERE subscription_id = ?1", Self::POCKET_COLUMNS);
        self.conn
            .query_row(&sql, [subscription_id], Self::pocket_row)
            .optional()?
            .context("subscription has no pocket")
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn count_subscriptions(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM subscriptions", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The schema and rows of a runner from before trials, payer keys and refunds
    /// (build 7244e6a), as on the sandbox's volume.
    fn old_database(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE offers (
                 offer_id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_zat INTEGER NOT NULL,
                 period_secs INTEGER NOT NULL, count INTEGER NOT NULL, merchant_ua TEXT NOT NULL,
                 created_at INTEGER NOT NULL);
             CREATE TABLE pockets (
                 pocket_id TEXT PRIMARY KEY, account TEXT NOT NULL, ufvk TEXT NOT NULL,
                 birthday INTEGER NOT NULL, created_at INTEGER NOT NULL,
                 funding_txid TEXT, funding_tx_hex TEXT, funding_height INTEGER, funding_value INTEGER,
                 subscription_id TEXT);
             CREATE TABLE subscriptions (
                 subscription_id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, pocket_id TEXT NOT NULL,
                 status TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE installments (
                 subscription_id TEXT NOT NULL, k INTEGER NOT NULL, amount_zat INTEGER NOT NULL,
                 release_round INTEGER NOT NULL, release_at INTEGER NOT NULL, state TEXT NOT NULL,
                 sealed BLOB, beacon BLOB, txid TEXT, target_height INTEGER, expiry_height INTEGER,
                 mined_height INTEGER, PRIMARY KEY (subscription_id, k));
             INSERT INTO meta VALUES ('funder_account', '00000000-0000-0000-0000-000000000001');
             INSERT INTO offers VALUES ('off_old', 'Sandbox standing order', 20000, 300, 3, 'utest1x', 1792000000);
             INSERT INTO pockets VALUES ('pkt_a', '00000000-0000-0000-0000-00000000000a', 'uviewtest1a', 10, 1792000000,
                 'aa', 'beef', 11, 90000, 'sub_active');
             INSERT INTO pockets VALUES ('pkt_s', '00000000-0000-0000-0000-00000000000b', 'uviewtest1b', 10, 1792000000,
                 'bb', 'beef', 11, 90000, 'sub_stalled');
             INSERT INTO subscriptions VALUES ('sub_active', 'off_old', 'pkt_a', 'active', 1792000001);
             INSERT INTO subscriptions VALUES ('sub_stalled', 'off_old', 'pkt_s', 'stalled', 1792000002);
             INSERT INTO installments (subscription_id, k, amount_zat, release_round, release_at, state, sealed)
                 VALUES ('sub_active', 1, 20000, 1, 1792000060, 'sealed', x'01');
             INSERT INTO installments (subscription_id, k, amount_zat, release_round, release_at, state, sealed)
                 VALUES ('sub_stalled', 1, 20000, 1, 1792000060, 'missed', x'02');",
        )
        .unwrap();
    }

    #[test]
    fn a_database_from_an_older_runner_opens_and_keeps_working() {
        let path = std::env::temp_dir().join(format!("cadence-old-state-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        old_database(&path);
        let mut store = Store::open(&path).unwrap();

        let offer = store.offer("off_old").unwrap().unwrap();
        assert_eq!((offer.amount_zat, offer.trial_secs, offer.quote), (20_000, 0, None));
        assert_eq!(store.meta("funder_account").unwrap().as_deref(), Some("00000000-0000-0000-0000-000000000001"));
        let active = store.subscription("sub_active").unwrap().unwrap();
        assert_eq!((active.status.as_str(), active.refundable, active.payer_auth_key), ("active", false, None));
        assert_eq!(active.installments[0].sealed.as_deref(), Some(&[1u8][..]));
        assert_eq!(active.funding.as_ref().map(|f| f.amount_zat), Some(90_000));
        // A stalled pocket, kept until its payer emptied it, now has the refund window.
        let stalled = store.subscription("sub_stalled").unwrap().unwrap();
        assert!(stalled.refundable);
        let until = stalled.keep_until.unwrap();
        assert!(until.abs_diff(crate::service::now() + crate::refund::REFUND_KEEP_SECS) < 5);
        assert_eq!(store.subscriptions(true).unwrap().len(), 2);

        // New rows of every kind go in next to the old ones.
        let quote = Quote { currency: "USD".into(), amount_minor: 500, zec_rate_minor: 4210, set_at: 1_793_170_000 };
        let new = Offer { offer_id: "off_new".into(), trial_secs: 600, quote: Some(quote.clone()), ..offer };
        store.insert_offer(&new).unwrap();
        assert_eq!(store.offer("off_new").unwrap().unwrap().quote, Some(quote));
        store.insert_pocket("pkt_n", "00000000-0000-0000-0000-00000000000c", "uviewtest1c", 12, 1792000003).unwrap();
        store.insert_subscription("sub_new", "off_new", "pkt_n", 1792000004, &[], Some(&"ab".repeat(32))).unwrap();
        assert_eq!(store.subscription("sub_new").unwrap().unwrap().payer_auth_key, Some("ab".repeat(32)));
        assert_eq!(store.count_subscriptions().unwrap(), 3);
        drop(store);

        // Opening it again changes nothing.
        let store = Store::open(&path).unwrap();
        assert_eq!(store.subscription("sub_stalled").unwrap().unwrap().keep_until, Some(until));
        assert_eq!(store.offer("off_new").unwrap().unwrap().trial_secs, 600);
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
