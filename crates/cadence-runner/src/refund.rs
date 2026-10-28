//! Pockets kept after their subscription ends.
//!
//! - **After a stop or a miss** the pocket's wallet account stays, with its notes,
//!   witnesses and tracking, so that the payer's browser can refund what is left with
//!   the ordinary cancel (`GET /api/pockets/{id}`, `…/witness`, `POST /api/broadcast`).
//!   A stop shreds the packages at once; the account goes when the payer's refund is
//!   seen, when nothing is left, or [`REFUND_KEEP_SECS`] after the end. A stalled
//!   subscription sees the refund as a cancel, as it always has (`service::advance`).
//! - **On the sandbox, after a cancel**, the installments it voided keep their
//!   packages, and the pocket its account, for [`VOIDED_KEEP_SECS`], so that the
//!   charge-after-cancel demo can try to release one (`sandbox.rs`).
//!
//! What spent a pocket note is in the wallet's own records. zcash_client_sqlite has no
//! call for it, so its tables are read, read-only, through its extension handle.

use anyhow::{anyhow, Result};
use cadence_chain::wallet::{self, Db};
use incrementalmerkletree::Position;
use orchard::note::Nullifier;
use rusqlite::OptionalExtension;
use zcash_client_backend::data_api::WalletWrite;
use zcash_client_sqlite::AccountUuid;
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::BlockHeight;

use crate::{
    service::{parse_account, send_webhook, App},
    store::{Refund, Subscription},
    webhook::Event,
};

/// How long a stopped or stalled pocket is kept for the payer's refund.
pub const REFUND_KEEP_SECS: u64 = 30 * 24 * 60 * 60;

/// How long a sandbox cancel's voided packages are kept.
pub const VOIDED_KEEP_SECS: u64 = 60 * 60;

/// A mined transaction that spent one of a pocket's notes.
#[derive(Clone, Debug, PartialEq)]
pub struct Spend {
    pub txid: TxId,
    pub mined_height: u32,
}

/// Every mined spend of `account`'s notes that the wallet has scanned, oldest first.
pub fn spends(db: &mut Db, account: AccountUuid) -> Result<Vec<Spend>> {
    let uuid = account.expose_uuid();
    let rows: String = db.transactionally_with_extension(|_, ext| {
        ext.query_row(
            "SELECT COALESCE(group_concat(hex(t.txid) || ' ' || t.mined_height, ','), '')
             FROM ironwood_received_notes n
             JOIN accounts a ON a.id = n.account_id
             JOIN ironwood_received_note_spends s ON s.ironwood_received_note_id = n.id
             JOIN transactions t ON t.id_tx = s.transaction_id
             WHERE a.uuid = ?1 AND t.mined_height IS NOT NULL",
            [uuid.as_bytes().as_slice()],
            |r| r.get(0),
        )
    })?;
    let mut spends = rows
        .split(',')
        .filter(|row| !row.is_empty())
        .map(|row| {
            let (txid, height) = row.split_once(' ').ok_or_else(|| anyhow!("bad spend row {row}"))?;
            let bytes: [u8; 32] = hex::decode(txid)?.try_into().map_err(|_| anyhow!("bad txid {txid}"))?;
            Ok(Spend { txid: TxId::from_bytes(bytes), mined_height: height.parse()? })
        })
        .collect::<Result<Vec<_>>>()?;
    spends.sort_by_key(|s| s.mined_height);
    spends.dedup();
    Ok(spends)
}

/// Where `account`'s note with nullifier `nf` sits in the commitment tree, spent or not.
pub fn note_position(db: &mut Db, account: AccountUuid, nf: &Nullifier) -> Result<Option<Position>> {
    let uuid = account.expose_uuid();
    let nf = nf.to_bytes();
    let position: Option<Option<u64>> = db.transactionally_with_extension(|_, ext| {
        ext.query_row(
            "SELECT n.commitment_tree_position FROM ironwood_received_notes n
             JOIN accounts a ON a.id = n.account_id
             WHERE a.uuid = ?1 AND n.nf = ?2",
            [uuid.as_bytes().as_slice(), nf.as_slice()],
            |r| r.get(0),
        )
        .optional()
    })?;
    Ok(position.flatten().map(Position::from))
}

/// What a kept pocket's spends show.
#[derive(Debug, Default, PartialEq)]
pub struct Seen {
    /// The first spend that is none of the subscription's installments.
    pub refund: Option<Refund>,
    /// Installments mined after the end, as `(k, height)`: in flight when it was stopped.
    pub paid: Vec<(u32, u32)>,
}

pub fn classify(sub: &Subscription, spends: &[Spend]) -> Seen {
    let mut seen = Seen::default();
    for spend in spends {
        let txid = spend.txid.to_string();
        match sub.installments.iter().find(|i| i.txid.as_deref() == Some(txid.as_str())) {
            Some(inst) if inst.mined_height.is_none() => seen.paid.push((inst.k, spend.mined_height)),
            Some(_) => {}
            None if seen.refund.is_none() => seen.refund = Some(Refund { txid, mined_height: spend.mined_height }),
            None => {}
        }
    }
    seen
}

/// The payer's refund of `sub`'s pocket, if the wallet has seen one.
pub async fn refund_of(app: &App, sub: &Subscription) -> Result<Option<Refund>> {
    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let account = parse_account(&pocket.account)?;
    let spends = spends(&mut *app.wallet.lock().await, account)?;
    Ok(classify(sub, &spends).refund)
}

/// Shreds a kept pocket as `service::finish` shreds an ended one.
pub async fn release(app: &App, sub: &Subscription, now: u64) -> Result<()> {
    let pocket = {
        let store = app.store.lock().unwrap();
        store.shred(&sub.subscription_id)?;
        store.set_released(&sub.subscription_id, now)?;
        store.pocket_for_subscription(&sub.subscription_id)?
    };
    app.wallet.lock().await.delete_account(parse_account(&pocket.account)?)?;
    Ok(())
}

/// Shreds the kept pockets whose time is up. It needs no network, so the scheduler
/// runs it even when lightwalletd does not answer.
pub async fn expire(app: &App, now: u64) -> Result<()> {
    let kept = app.store.lock().unwrap().kept_subscriptions()?;
    for sub in kept.iter().filter(|s| s.keep_until.is_some_and(|until| now >= until)) {
        match release(app, sub, now).await {
            Ok(()) => println!("{}: {}; kept pocket data deleted after its time", sub.subscription_id, sub.status),
            Err(e) => eprintln!("{}: deleting the kept pocket: {e:#}", sub.subscription_id),
        }
    }
    Ok(())
}

/// Reads what spent each stopped pocket's notes, once the wallet has synced to `tip`.
pub async fn watch(app: &App, tip: BlockHeight, now: u64) -> Result<()> {
    let kept = app.store.lock().unwrap().kept_subscriptions()?;
    for sub in kept.iter().filter(|s| s.status == "stopped") {
        if let Err(e) = watch_one(app, sub, tip, now).await {
            eprintln!("{}: watching the kept pocket: {e:#}", sub.subscription_id);
        }
    }
    Ok(())
}

async fn watch_one(app: &App, sub: &Subscription, tip: BlockHeight, now: u64) -> Result<()> {
    let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id)?;
    let account = parse_account(&pocket.account)?;
    let (spends, left) = {
        let mut db = app.wallet.lock().await;
        (spends(&mut db, account)?, wallet::unspent_notes(&db, account, tip + 1)?.len())
    };
    settle(app, sub, classify(sub, &spends), left, now).await
}

/// Records what a stopped pocket's spends show, given the notes it has `left`: the
/// pocket goes once the refund is seen, or once nothing is left to refund.
pub async fn settle(app: &App, sub: &Subscription, seen: Seen, left: usize, now: u64) -> Result<()> {
    for &(k, height) in &seen.paid {
        println!("{} #{k}: mined at {height}, after the stop", sub.subscription_id);
        app.store.lock().unwrap().set_mined(&sub.subscription_id, k, height)?;
        if let Some(inst) = sub.installments.iter().find(|i| i.k == k) {
            let mut mined = inst.clone();
            mined.mined_height = Some(height);
            send_webhook(app, Event::confirmed(sub, &mined));
        }
    }
    if let Some(refund) = &seen.refund {
        app.store.lock().unwrap().set_refund(&sub.subscription_id, refund)?;
        release(app, sub, now).await?;
        println!("{}: refunded by {} at {}; pocket data deleted", sub.subscription_id, refund.txid, refund.mined_height);
    } else if left == 0 {
        release(app, sub, now).await?;
        println!("{}: nothing left to refund; pocket data deleted", sub.subscription_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};

    use super::*;
    use crate::{
        api::{
            router,
            tests::{get_json, subscribed, test_app, TOKEN},
        },
        service::{finish, now, parse_txid},
        store::Installment,
    };

    fn spend(txid: &str, mined_height: u32) -> Spend {
        Spend { txid: parse_txid(txid).unwrap(), mined_height }
    }

    fn stopped(installments: &[(&str, Option<&str>)]) -> Subscription {
        Subscription {
            subscription_id: "sub_test".into(),
            offer_id: "off_test".into(),
            pocket_id: "pkt_test".into(),
            status: "stopped".into(),
            created_at: 0,
            funding: None,
            installments: installments
                .iter()
                .enumerate()
                .map(|(i, (state, txid))| Installment {
                    k: i as u32 + 1,
                    amount_zat: 20_000,
                    release_round: 0,
                    release_at: 0,
                    state: state.to_string(),
                    txid: txid.map(String::from),
                    target_height: None,
                    expiry_height: None,
                    mined_height: (*state == "mined").then_some(100 + i as u32),
                    sealed: None,
                    beacon: None,
                })
                .collect(),
            refundable: true,
            refund: None,
            payer_auth_key: None,
            keep_until: Some(1),
        }
    }

    #[test]
    fn spends_are_installments_or_the_refund() {
        let (paid, in_flight, refund) = ("aa".repeat(32), "bb".repeat(32), "cc".repeat(32));
        // Installment 1 paid; #2 was in the mempool when the merchant stopped.
        let sub = stopped(&[("mined", Some(&paid)), ("cancelled", Some(&in_flight)), ("cancelled", None)]);
        assert_eq!(classify(&sub, &[spend(&paid, 100)]), Seen::default());
        assert_eq!(
            classify(&sub, &[spend(&paid, 100), spend(&in_flight, 105)]),
            Seen { refund: None, paid: vec![(2, 105)] }
        );
        assert_eq!(
            classify(&sub, &[spend(&paid, 100), spend(&in_flight, 105), spend(&refund, 109)]),
            Seen { refund: Some(Refund { txid: refund.clone(), mined_height: 109 }), paid: vec![(2, 105)] }
        );
        assert_eq!(
            classify(&sub, &[spend(&paid, 100), spend(&refund, 101)]).refund,
            Some(Refund { txid: refund, mined_height: 101 })
        );
    }

    fn stop(id: &str) -> axum::http::Request<axum::body::Body> {
        axum::http::Request::post(format!("/api/subscriptions/{id}/stop"))
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(axum::body::Body::empty())
            .unwrap()
    }

    fn subscription(app: &App, id: &str) -> Subscription {
        app.store.lock().unwrap().subscription(id).unwrap().unwrap()
    }

    fn scheduled(app: &App) -> Vec<String> {
        let subs = app.store.lock().unwrap().subscriptions(true).unwrap();
        subs.into_iter().map(|s| s.subscription_id).collect()
    }

    #[tokio::test]
    async fn a_stopped_pocket_is_kept_until_the_payer_refunds() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let id = subscribed(&app, &api, now(), None).await.unwrap();
        assert_eq!(get_json(&api, &format!("/api/subscriptions/{id}")).await["refundable"], false);

        let (status, _, _) = crate::api::tests::send(&api, stop(&id)).await;
        assert_eq!(status, StatusCode::OK);
        let view = get_json(&api, &format!("/api/subscriptions/{id}")).await;
        assert_eq!(view["status"], "stopped");
        assert_eq!(view["refundable"], true);
        assert!(view.get("refund").is_none(), "{view}");
        // The packages go at once; the pocket stays for 30 days.
        let sub = subscription(&app, &id);
        assert!(sub.installments.iter().all(|i| i.sealed.is_none() && i.state == "cancelled"));
        assert!(sub.keep_until.unwrap().abs_diff(now() + REFUND_KEEP_SECS) < 5);
        assert!(!scheduled(&app).contains(&id));

        // The payer's refund is seen: recorded, and the pocket shredded.
        let refund = Refund { txid: "cc".repeat(32), mined_height: 4_550_000 };
        let seen = Seen { refund: Some(refund.clone()), paid: vec![] };
        settle(&app, &sub, seen, 0, now()).await.unwrap();
        let view = get_json(&api, &format!("/api/subscriptions/{id}")).await;
        assert_eq!(view["refundable"], false);
        assert_eq!(view["refund"], json!({ "txid": refund.txid, "mined_height": 4_550_000 }));
        assert!(app.store.lock().unwrap().kept_subscriptions().unwrap().is_empty());
        // Shredding again later finds nothing to do.
        expire(&app, now() + REFUND_KEEP_SECS).await.unwrap();
        assert_eq!(subscription(&app, &id).refund, Some(refund));
    }

    #[tokio::test]
    async fn a_stopped_pocket_goes_when_nothing_is_left_or_after_30_days() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let refundable = |id: &str| subscription(&app, id).refundable;

        // Installment 1 was in flight when the merchant stopped, and was mined after.
        let in_flight = subscribed(&app, &api, now(), None).await.unwrap();
        app.store.lock().unwrap().set_broadcast(&in_flight, 1, &"bb".repeat(32), 10, 50).unwrap();
        crate::api::tests::send(&api, stop(&in_flight)).await;
        let sub = subscription(&app, &in_flight);
        settle(&app, &sub, Seen { refund: None, paid: vec![(1, 12)] }, 1, now()).await.unwrap();
        let sub = subscription(&app, &in_flight);
        assert_eq!((sub.installments[0].state.as_str(), sub.installments[0].mined_height), ("mined", Some(12)));
        assert!(sub.refundable, "its change is still there");
        // Once nothing is left, the pocket goes.
        settle(&app, &sub, Seen::default(), 0, now()).await.unwrap();
        assert!(!refundable(&in_flight));
        assert_eq!(subscription(&app, &in_flight).refund, None);

        // Never refunded: kept for exactly the window.
        let id = subscribed(&app, &api, now(), None).await.unwrap();
        crate::api::tests::send(&api, stop(&id)).await;
        let until = subscription(&app, &id).keep_until.unwrap();
        expire(&app, until - 1).await.unwrap();
        assert!(refundable(&id));
        expire(&app, until).await.unwrap();
        assert!(!refundable(&id));
        assert_eq!(subscription(&app, &id).status, "stopped");
    }

    #[tokio::test]
    async fn a_missed_pocket_is_kept_for_30_days_then_no_longer_scheduled() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        let id = subscribed(&app, &api, now(), None).await.unwrap();
        let until = now() + REFUND_KEEP_SECS;
        app.store.lock().unwrap().stall(&id, 1, "missed", until).unwrap();
        let view = get_json(&api, &format!("/api/subscriptions/{id}")).await;
        assert_eq!((view["status"].as_str(), view["refundable"].as_bool()), (Some("stalled"), Some(true)));
        assert_eq!(view["installments"][0]["state"], "missed");
        // Still advanced, so that the payer's refund reads as a cancel, as before.
        assert!(scheduled(&app).contains(&id));
        assert!(subscription(&app, &id).installments[1].sealed.is_some());

        // A second stall, or a stop, keeps the first deadline.
        app.store.lock().unwrap().stall(&id, 2, "invalid", until + 600).unwrap();
        assert_eq!(subscription(&app, &id).keep_until, Some(until));

        expire(&app, until).await.unwrap();
        let sub = subscription(&app, &id);
        assert_eq!((sub.status.as_str(), sub.refundable), ("stalled", false));
        assert!(sub.installments.iter().all(|i| i.sealed.is_none()));
        assert!(!scheduled(&app).contains(&id));
    }

    #[tokio::test]
    async fn completed_and_cancelled_shred_at_once_as_before() {
        let app = test_app(false, None);
        let api = router(app.clone(), None, vec![]);
        for status in ["completed", "cancelled"] {
            let id = subscribed(&app, &api, now(), None).await.unwrap();
            let sub = subscription(&app, &id);
            finish(&app, &sub, status, Some(&sub.installments[0])).await.unwrap();
            let sub = subscription(&app, &id);
            assert_eq!((sub.status.as_str(), sub.refundable, sub.keep_until), (status, false, None));
            assert!(sub.installments.iter().all(|i| i.sealed.is_none()));
            let pocket = app.store.lock().unwrap().pocket_for_subscription(&id).unwrap();
            assert_eq!(pocket.ufvk, "");
            let view: Value = get_json(&api, &format!("/api/subscriptions/{id}")).await;
            assert!(view.get("refund").is_none(), "{view}");
        }
        assert!(app.store.lock().unwrap().kept_subscriptions().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_wallet_is_read_with_its_own_schema() {
        // An empty wallet answers both queries, so their tables and columns exist.
        let app = test_app(false, None);
        let account = parse_account("00000000-0000-0000-0000-000000000002").unwrap();
        let mut db = app.wallet.lock().await;
        assert_eq!(spends(&mut db, account).unwrap(), vec![]);
        let nf = Nullifier::from_bytes(&[0; 32]).unwrap();
        assert_eq!(note_position(&mut db, account, &nf).unwrap(), None);
    }
}
