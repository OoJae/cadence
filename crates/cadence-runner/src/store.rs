//! The runner's own records: offers, pockets, subscriptions and their installments.
//!
//! Sealed packages are kept exactly as uploaded. Once a package opens, only the
//! (public) drand beacon is stored next to it; the plaintext ladder is re-derived in
//! memory when needed, so nothing readable sits at rest. Finished subscriptions are
//! shredded: their sealed packages and beacons are deleted.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

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
        // Pockets of subscriptions that ended before shredding covered their keys.
        store.conn.execute(
            "UPDATE pockets SET ufvk = '', funding_tx_hex = NULL
             WHERE ufvk != '' AND subscription_id IN
               (SELECT subscription_id FROM subscriptions WHERE status NOT IN ('active', 'stalled'))",
            [],
        )?;
        store.conn.execute(
            "UPDATE installments SET sealed = NULL, beacon = NULL
             WHERE (sealed IS NOT NULL OR beacon IS NOT NULL) AND subscription_id IN
               (SELECT subscription_id FROM subscriptions WHERE status NOT IN ('active', 'stalled'))",
            [],
        )?;
        store.checkpoint()?;
        Ok(store)
    }

    pub fn insert_offer(&self, o: &Offer) -> Result<()> {
        self.conn.execute(
            "INSERT INTO offers VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![o.offer_id, o.name, o.amount_zat, o.period_secs, o.count, o.merchant_ua, o.created_at],
        )?;
        Ok(())
    }

    pub fn offer(&self, id: &str) -> Result<Option<Offer>> {
        Ok(self
            .conn
            .query_row(
                "SELECT offer_id, name, amount_zat, period_secs, count, merchant_ua, created_at
                 FROM offers WHERE offer_id = ?1",
                [id],
                |r| {
                    Ok(Offer {
                        offer_id: r.get(0)?,
                        name: r.get(1)?,
                        amount_zat: r.get(2)?,
                        period_secs: r.get(3)?,
                        count: r.get(4)?,
                        merchant_ua: r.get(5)?,
                        created_at: r.get(6)?,
                    })
                },
            )
            .optional()?)
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

    /// Pockets registered but neither funded nor subscribed yet.
    pub fn count_pending_pockets(&self) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM pockets WHERE funding_txid IS NULL AND subscription_id IS NULL",
            [],
            |r| r.get(0),
        )?)
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
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO subscriptions VALUES (?1, ?2, ?3, 'active', ?4)",
            params![id, offer_id, pocket_id, now],
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

    fn subscription_from(&self, id: String, offer_id: String, pocket_id: String, status: String, created_at: u64) -> Result<Subscription> {
        let funding = self.pocket(&pocket_id)?.and_then(|p| p.funding).map(|f| FundingView {
            txid: f.txid,
            mined_height: f.mined_height,
            amount_zat: f.value_zat,
        });
        Ok(Subscription {
            installments: self.installments(&id)?,
            subscription_id: id,
            offer_id,
            pocket_id,
            status,
            created_at,
            funding,
        })
    }

    pub fn subscriptions(&self, only_active: bool) -> Result<Vec<Subscription>> {
        let sql = if only_active {
            "SELECT subscription_id, offer_id, pocket_id, status, created_at FROM subscriptions
             WHERE status IN ('active', 'stalled') ORDER BY created_at"
        } else {
            "SELECT subscription_id, offer_id, pocket_id, status, created_at FROM subscriptions
             ORDER BY created_at DESC"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let heads = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<Vec<(String, String, String, String, u64)>>>()?;
        heads
            .into_iter()
            .map(|(id, offer, pocket, status, created)| self.subscription_from(id, offer, pocket, status, created))
            .collect()
    }

    pub fn subscription(&self, id: &str) -> Result<Option<Subscription>> {
        let head = self
            .conn
            .query_row(
                "SELECT subscription_id, offer_id, pocket_id, status, created_at FROM subscriptions
                 WHERE subscription_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        head.map(|(id, offer, pocket, status, created): (String, String, String, String, u64)| {
            self.subscription_from(id, offer, pocket, status, created)
        })
        .transpose()
    }

    pub fn set_status(&self, subscription_id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE subscriptions SET status = ?2 WHERE subscription_id = ?1",
            params![subscription_id, status],
        )?;
        Ok(())
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
        self.conn.execute(
            "UPDATE installments SET sealed = NULL, beacon = NULL WHERE subscription_id = ?1",
            [subscription_id],
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
