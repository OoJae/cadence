//! The scheduler's decisions, and what it does to the store and the wallet, without
//! lightwalletd or drand: the test runner's clients never connect.

use zcash_client_backend::data_api::{chain::ChainState, Account as _, AccountBirthday, AccountPurpose};
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::{NetworkUpgrade, Parameters};

use super::*;
use crate::api::{insert_offer, tests::test_app};

fn at(height: u32) -> BlockHeight {
    BlockHeight::from_u32(height)
}

fn installment(k: u32, state: &str) -> Installment {
    Installment {
        k,
        amount_zat: 20_000,
        release_round: 1_000 + u64::from(k),
        release_at: 0,
        state: state.into(),
        txid: None,
        target_height: None,
        expiry_height: None,
        mined_height: None,
        sealed: Some(vec![k as u8; 8]),
        beacon: None,
    }
}

fn with_states(states: &[&str]) -> Subscription {
    Subscription {
        subscription_id: "sub_test".into(),
        offer_id: "off_test".into(),
        pocket_id: "pkt_test".into(),
        status: "active".into(),
        created_at: 0,
        funding: None,
        installments: states.iter().zip(1..).map(|(s, k)| installment(k, s)).collect(),
    }
}

fn rungs(targets: &[u32]) -> Vec<RungPackage> {
    targets
        .iter()
        .map(|t| RungPackage { target_height: *t, expiry_height: t + 40, pczt: String::new() })
        .collect()
}

/// A pocket account in the test wallet, imported from an empty tree so that no
/// lightwalletd is asked.
fn pocket_account(app: &App, seed: u8) -> AccountUuid {
    let pocket = cadence_core::Pocket::from_seed(&[seed; 32], 1);
    let prior = ChainState::empty(at(2_999_999), BlockHash([0; 32]));
    let birthday = AccountBirthday::from_parts(prior, None);
    let mut db = app.wallet.try_lock().unwrap();
    db.import_account_ufvk("test", &pocket.ufvk(), &birthday, AccountPurpose::Spending { derivation: None }, None)
        .unwrap()
        .id()
}

/// A subscription with `states`, on a pocket the wallet holds, funded at height 1.
fn subscribed(app: &App, seed: u8, states: &[&str]) -> Subscription {
    let account = pocket_account(app, seed);
    let created = insert_offer(app, "Plan".into(), 20_000, 90, states.len() as u32, String::new()).unwrap();
    let offer_id = created["offer_id"].as_str().unwrap();
    let pocket_id = format!("pkt_{seed}");
    let sub_id = format!("sub_{seed}");
    let mut store = app.store.lock().unwrap();
    store.insert_pocket(&pocket_id, &account.expose_uuid().to_string(), "uview-test", 1, now()).unwrap();
    let funding = Funding { txid: "00".repeat(32), tx_hex: String::new(), mined_height: 1, value_zat: 60_000 };
    store.set_funding(&pocket_id, &funding).unwrap();
    let installments: Vec<Installment> = (1..).zip(states).map(|(k, _)| installment(k, "sealed")).collect();
    store.insert_subscription(&sub_id, offer_id, &pocket_id, now(), &installments).unwrap();
    for (k, state) in (1..).zip(states) {
        match *state {
            "sealed" => {}
            "mined" => store.set_mined(&sub_id, k, 10 + k).unwrap(),
            other => store.set_state(&sub_id, k, other).unwrap(),
        }
    }
    store.subscription(&sub_id).unwrap().unwrap()
}

fn reread(app: &App, sub: &Subscription) -> Subscription {
    app.store.lock().unwrap().subscription(&sub.subscription_id).unwrap().unwrap()
}

fn states(sub: &Subscription) -> Vec<&str> {
    sub.installments.iter().map(|i| i.state.as_str()).collect()
}

fn holds_account(app: &App, account: &str) -> bool {
    let db = app.wallet.try_lock().unwrap();
    db.get_account_ids().unwrap().contains(&parse_account(account).unwrap())
}

#[test]
fn the_first_installment_not_mined_is_worked_on() {
    assert_eq!(next_unmined(&with_states(&["sealed", "sealed"])), Some(0));
    assert_eq!(next_unmined(&with_states(&["mined", "broadcast", "sealed"])), Some(1));
    // Mined is the only state passed over: a missed one holds up those after it.
    assert_eq!(next_unmined(&with_states(&["mined", "missed", "sealed"])), Some(1));
    assert_eq!(next_unmined(&with_states(&["mined", "mined"])), None);
}

#[test]
fn each_state_has_its_action() {
    let inst = |state: &str| installment(1, state);
    let round = inst("sealed").release_round;
    assert_eq!(action(&inst("sealed"), round - 1), Action::Wait);
    assert_eq!(action(&inst("sealed"), round), Action::Open);
    assert_eq!(action(&inst("sealed"), round + 100), Action::Open);
    // Once opened, the round no longer matters.
    assert_eq!(action(&inst("due"), 0), Action::Release);
    assert_eq!(action(&inst("broadcast"), 0), Action::Confirm);
    for state in ["mined", "missed", "invalid", "cancelled"] {
        assert_eq!(action(&inst(state), round + 100), Action::Wait, "{state}");
    }
}

#[test]
fn only_installments_not_in_flight_watch_for_a_cancel() {
    for state in ["sealed", "missed", "invalid"] {
        assert!(watches_for_cancel(&installment(1, state)), "{state}");
    }
    // Due and broadcast spend the note themselves; payer_cancelled rules that out in release.
    for state in ["due", "broadcast", "mined", "cancelled"] {
        assert!(!watches_for_cancel(&installment(1, state)), "{state}");
    }
}

#[test]
fn the_rung_signed_for_exactly_the_next_block_is_released() {
    let ladder = rungs(&[100, 101, 102, 103, 104]);
    let chosen = |target| match choose_rung(&ladder, target) {
        RungChoice::Signed(r) => Ok(r.target_height),
        RungChoice::Missed => Err("missed"),
        RungChoice::Wait => Err("wait"),
    };
    assert_eq!(chosen(100), Ok(100));
    assert_eq!(chosen(102), Ok(102));
    assert_eq!(chosen(104), Ok(104));
    // Before the first rung the chain has not caught up yet; past the last it never will.
    assert_eq!(chosen(99), Err("wait"));
    assert_eq!(chosen(105), Err("missed"));
    // A gap in the ladder waits rather than taking a neighbour, whose expiry is wrong.
    let gappy = rungs(&[100, 102]);
    assert!(matches!(choose_rung(&gappy, 101), RungChoice::Wait));
    assert!(matches!(choose_rung(&[], 1), RungChoice::Missed));
}

#[test]
fn inputs_wait_until_anchor_deep() {
    // The anchor is three blocks behind the target, which is the block after the tip.
    assert!(!anchor_deep(at(100), at(102)));
    assert!(anchor_deep(at(100), at(103)));
    assert!(anchor_deep(at(90), at(103)));
    // Spent-or-not is trusted one block later: three deep at the tip, not at the target.
    assert!(!settled(100, at(102)));
    assert!(settled(100, at(103)));
    assert!(anchor_deep(at(100), at(102) + 1) && !settled(100, at(102)));
}

#[test]
fn the_input_is_the_funding_then_each_change() {
    let mut pocket = Pocket {
        pocket_id: "pkt".into(),
        account: String::new(),
        ufvk: String::new(),
        birthday: 1,
        funding: None,
        subscription_id: None,
    };
    let mut first = installment(1, "mined");
    assert_eq!(input_height(&pocket, None), None);
    pocket.funding = Some(Funding { txid: String::new(), tx_hex: String::new(), mined_height: 50, value_zat: 1 });
    assert_eq!(input_height(&pocket, None), Some(50));
    assert_eq!(input_height(&pocket, Some(&first)), None, "#1 is not mined yet");
    first.mined_height = Some(60);
    assert_eq!(input_height(&pocket, Some(&first)), Some(60));
}

#[test]
fn a_broadcast_lapses_at_its_expiry_or_an_upgrade() {
    let network = Network::TestNetwork;
    let mut inst = installment(1, "broadcast");
    inst.target_height = Some(1_000);
    inst.expiry_height = Some(1_040);
    assert!(!lapsed(&network, &inst, at(1_040)));
    assert!(lapsed(&network, &inst, at(1_041)));
    inst.expiry_height = None;
    assert!(!lapsed(&network, &inst, at(5_000)));

    // Signed for the block before an upgrade, and the upgrade is next.
    let nu5 = u32::from(network.activation_height(NetworkUpgrade::Nu5).unwrap());
    inst.target_height = Some(nu5 - 1);
    inst.expiry_height = Some(nu5 + 40);
    assert!(!lapsed(&network, &inst, at(nu5 - 2)));
    assert!(lapsed(&network, &inst, at(nu5 - 1)));
    inst.target_height = Some(nu5);
    assert!(!lapsed(&network, &inst, at(nu5 + 10)));
}

#[tokio::test]
async fn finish_shreds_and_closes_by_status() {
    let app = test_app(false, None);
    for (seed, status) in [(1, "completed"), (2, "cancelled"), (3, "stopped")] {
        let states_before: &[&str] = if status == "completed" { &["mined", "mined"] } else { &["mined", "sealed", "due"] };
        let sub = subscribed(&app, seed, states_before);
        let account = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id).unwrap().account;
        assert!(holds_account(&app, &account));
        let at = sub.installments.get(1);
        finish(&app, &sub, status, at).await.unwrap();

        let after = reread(&app, &sub);
        assert_eq!(after.status, status);
        let expected: &[&str] = if status == "completed" { &["mined", "mined"] } else { &["mined", "cancelled", "cancelled"] };
        assert_eq!(states(&after), expected, "{status}");
        assert!(after.installments.iter().all(|i| i.sealed.is_none() && i.beacon.is_none()), "{status}");
        if status != "stopped" {
            let pocket = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id).unwrap();
            assert_eq!(pocket.ufvk, "", "{status}");
            assert_eq!(pocket.funding.unwrap().tx_hex, "", "{status}");
            assert!(!holds_account(&app, &account), "{status}");
        }
    }
}

#[tokio::test]
async fn the_last_installment_mined_completes_the_subscription() {
    let app = test_app(false, None);
    let sub = subscribed(&app, 4, &["mined", "broadcast", "broadcast"]);
    record_mined(&app, &sub, &sub.installments[1], 30).await.unwrap();
    let after = reread(&app, &sub);
    assert_eq!((after.status.as_str(), states(&after)), ("active", vec!["mined", "mined", "broadcast"]));
    assert_eq!(after.installments[1].mined_height, Some(30));

    record_mined(&app, &after, &after.installments[2], 31).await.unwrap();
    let after = reread(&app, &sub);
    assert_eq!(after.status, "completed");
    assert_eq!(states(&after), ["mined", "mined", "mined"]);
}

#[tokio::test]
async fn a_package_that_is_not_what_was_agreed_stalls_the_subscription() {
    let app = test_app(false, None);
    let sub = subscribed(&app, 5, &["mined", "due"]);
    reject(&app, &sub, &sub.installments[1], "the package is malformed").unwrap();
    let after = reread(&app, &sub);
    assert_eq!(after.status, "stalled");
    assert_eq!(states(&after), ["mined", "invalid"]);
    // Nothing is shredded: the payer may still cancel and sweep.
    assert!(after.installments[1].sealed.is_some());
}

#[tokio::test]
async fn advance_completes_once_every_installment_is_mined() {
    let app = test_app(false, None);
    let sub = subscribed(&app, 6, &["mined", "mined"]);
    let mut client = app.sync_client.clone();
    advance(&app, &mut client, &sub, at(100), 0).await.unwrap();
    assert_eq!(reread(&app, &sub).status, "completed");
}

#[tokio::test]
async fn an_empty_pocket_is_no_cancel_while_its_funding_cannot_be_found() {
    // The wallet holds no note for the pocket, but lightwalletd cannot confirm the
    // funding transaction, so the scheduler waits instead of calling it a cancel.
    let app = test_app(false, None);
    let sub = subscribed(&app, 7, &["sealed", "sealed"]);
    let mut client = app.sync_client.clone();
    let round = sub.installments[0].release_round;
    advance(&app, &mut client, &sub, at(100), round - 1).await.unwrap();
    let after = reread(&app, &sub);
    assert_eq!((after.status.as_str(), states(&after)), ("active", vec!["sealed", "sealed"]));
}

#[tokio::test]
async fn pockets_never_funded_are_forgotten_after_two_hours() {
    let app = test_app(false, None);
    let t = now();
    let pocket = |id: &str, seed: u8, created: u64, funded: bool| {
        let account = pocket_account(&app, seed).expose_uuid().to_string();
        let store = app.store.lock().unwrap();
        store.insert_pocket(id, &account, "uview-test", 1, created).unwrap();
        if funded {
            let funding = Funding { txid: "00".repeat(32), tx_hex: String::new(), mined_height: 1, value_zat: 1 };
            store.set_funding(id, &funding).unwrap();
        }
        account
    };
    let stale = pocket("pkt_stale", 11, t - UNFUNDED_POCKET_SECS - 60, false);
    let fresh = pocket("pkt_fresh", 12, t - UNFUNDED_POCKET_SECS + 600, false);
    let funded = pocket("pkt_funded", 13, t - UNFUNDED_POCKET_SECS - 60, true);
    let week = pocket("pkt_week", 14, t - UNSUBSCRIBED_POCKET_SECS - 60, true);
    // A subscribed pocket is the subscription's, however old.
    let sub = subscribed(&app, 15, &["sealed"]);
    let subscribed_account = app.store.lock().unwrap().pocket_for_subscription(&sub.subscription_id).unwrap().account;

    forget_abandoned(&app, at(100)).await.unwrap();
    let kept = |id: &str| app.store.lock().unwrap().pocket(id).unwrap().is_some();
    assert!(!kept("pkt_stale") && !holds_account(&app, &stale));
    assert!(kept("pkt_fresh") && holds_account(&app, &fresh));
    assert!(kept("pkt_funded") && holds_account(&app, &funded));
    assert!(!kept("pkt_week") && !holds_account(&app, &week));
    assert!(kept(&sub.pocket_id) && holds_account(&app, &subscribed_account));
    assert_eq!(app.store.lock().unwrap().count_pending_pockets().unwrap(), 1);
}
