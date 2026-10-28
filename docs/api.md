# Cadence runner HTTP API (v0)

The runner serves JSON over HTTP behind a TLS proxy (Caddy, or Railway's edge), and can also be published as a Tor onion service (`deploy/torrc`). The payer CLI reaches it over Tor unless the runner is on a loopback address or `--direct` is given. Amounts are zatoshis (integers). Heights are block heights. Times are unix seconds. A drand `round` is a drand quicknet round number. Errors are `{ "error": "…" }` with a 4xx or 5xx status.

This describes the runner at this commit. The mainnet runner `main` runs build 7244e6a and will not be updated. That build has nothing that `GET /api/status` lists in `features` (trials, quotes, payer auth, access passes, refunds after a stop, re-signing, and the sandbox additions), no `scheduler` field, and none of the limits under "Limits". It also forgets unfunded pockets after a day, not 2 hours.

## Merchant: offers (plans)

`POST /api/offers` creates a plan. The merchant authenticates with a bearer token.

```json
{ "name": "Shielded Press monthly", "amount_zat": 500000, "period_secs": 2592000,
  "count": 2, "merchant_ua": "u1…" }
```

`count` is 1–12, `amount_zat` and `period_secs` must be positive, and `merchant_ua` must be a unified address with an Orchard receiver on the runner's network.

Two fields are optional. Send them only to a runner whose `GET /api/status` lists `trial` and `quote` in `features`: an older runner ignores fields it does not know.

- `trial_secs`, from 0 (the default) to 2,592,000 (30 days). Installment 1 falls due that much later, and so does every later one.
- `quote`, the merchant's own price label, such as `{ "currency": "USD", "amount_minor": 500, "zec_rate_minor": 4210, "set_at": 1793170000 }`.
  - `currency` is 3 uppercase letters.
  - `amount_minor` is the price per installment in minor units, 1 to 10⁹.
  - `zec_rate_minor` is the minor units per 1 ZEC that the merchant used, 1 to 10¹².
  - `set_at` is unix seconds.

  The quote is display only. The runner checks these bounds and stores it, but does not check it against `amount_zat`, which is what payers sign. Nothing in Cadence fetches a price feed.

Keep the last installment within about 45 days of signing: any trial, plus the first payment's lead, plus `(count − 1) × period_secs`, plus the payer's jitter of up to a quarter period, at most 6 h (see "Payer: subscribing"). Each installment's sealed package is capped at 64 MiB, which holds the window of a payment due up to about 53 days out, so a longer plan cannot be signed. The web app refuses such a plan before the payer pays; the runner does not check this. The response is `201`. The share URL carries the offer in its **fragment**, so it never reaches a server:

```json
{ "offer_id": "off_…", "share_url": "https://pay.example/subscribe#offer=<base64url(offer json)>" }
```

The share URL's base is `--app-url` when the runner was started with one, and `--public-url` otherwise. `runner_endpoint` in the offer is always `--public-url`.

`GET /api/offers/:id` returns the offer the payer app signs against:

```json
{ "offer_id": "off_…", "name": "…", "amount_zat": 500000, "period_secs": 2592000, "count": 2,
  "merchant_ua": "u1…", "runner_age_recipient": "age1…", "runner_endpoint": "https://… | http://….onion",
  "network": "main | test | regtest", "drand_chain": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  "trial_secs": 0 }
```

`trial_secs` is always there, 0 for an offer without a trial, and `quote` only when the offer has one. An older runner sends neither.

## Payer: pockets

The payer app is a browser, so it has no chain access of its own. Before it can sign, it asks the runner to watch the pocket. The runner learns nothing it would not learn from the subscription anyway.

`POST /api/pockets` registers a pocket:

```json
{ "pocket_ufvk": "uview1…" }
```

The response is `201`. The runner refuses a UFVK with any transparent or Sapling part. While 1,000 registered pockets are neither funded nor forgotten, it answers `503` with `the runner is busy; try again later`.

```json
{ "pocket_id": "pkt_…", "birthday_height": 3529002, "tip": 3529001 }
```

A pocket that is never funded is forgotten after 2 hours. One that is funded but never given packages is forgotten after a week; its funds stay the payer's (`cadence sweep`).

`GET /api/pockets/:id` returns `funding` as `null` until the funding transaction is mined. `tx_hex` is the raw transaction; the app decrypts the note itself with `mandate::decrypt_funding`. `notes` lists the pocket's mined, unspent notes, each with the txid that created it. `syncing` is `true` while the runner's wallet has not yet scanned the block of the latest mined installment, so the change it left is not listed yet.

```json
{ "pocket_id": "pkt_…", "tip": 3529010, "syncing": false, "birthday_height": 3529002,
  "funding": { "txid": "…", "tx_hex": "…", "mined_height": 3529004, "value_zat": 330000 },
  "notes": [ { "nullifier": "…", "value_zat": 220000, "txid": "…", "mined_height": 3529009, "position": 123456 } ] }
```

When a subscription completes, is cancelled or is stopped, the runner deletes its copy of the pocket's viewing key and the funding transaction, so `tx_hex` is `""`. It also deletes the pocket's wallet account, so `notes` is empty whatever the pocket still holds, with two exceptions:

- **After a stop or a miss.** A runner that lists `refund_after_stop` keeps the wallet account after a merchant stop, and for a subscription that a missed or invalid installment has `stalled`, so that the payer can refund what is left from the browser. It deletes the account when it sees that refund, when nothing is left, or 30 days after the stop or the stall, whichever comes first.
- **After a sandbox cancel.** The testnet sandbox keeps a cancelled pocket's account for an hour (`charge_after_cancel`, below).

`GET /api/pockets/:id/witness?nullifier=<hex>` gives the payer what it needs to cancel and prove in the browser. `auth_path` is 32 hex sibling hashes, leaf first. It answers `400` until the note is 3 blocks deep. The payer checks `anchor` against an independent lightwalletd before using it.

```json
{ "target_height": 3529011, "anchor_height": 3529008, "anchor": "…", "position": 123456, "auth_path": ["…"] }
```

`POST /api/broadcast` relays a finished transaction. It is used for the browser's cancel. The runner learns of the cancel either way. The CLI broadcasts over Tor through a lightwalletd of the payer's choosing instead; it looks up the note's transaction through that same server, so its operator can link the cancel to the mandate.

```json
{ "tx_hex": "…" }
```

The response is `{ "txid": "…" }`.

### Testnet sandbox

These exist only when the runner was started with `--sandbox-funder` on testnet (`/api/status` then reports `"sandbox": true`), or on a local regtest chain. The sandbox wallet is the runner's own, and it is disclosed as custodial.

`POST /api/sandbox/offer` creates a short demo plan paying the sandbox wallet. `count` is 1–6, `period_secs` 60–900 and `amount_zat` 10,000–200,000. It takes `trial_secs` and `quote` as `POST /api/offers` does. The response is the same as `POST /api/offers`.

```json
{ "count": 3, "period_secs": 90, "amount_zat": 20000 }
```

`POST /api/sandbox/fund` pays a registered pocket from the sandbox wallet, once per pocket. Pass `pocket_id`, or the pocket's funding `ua`, and `amount_zat`.

- **With `offer_id`** (runners that list `fund_offer`): the sandbox offer the pocket is for, which must be one of the sandbox's own. `amount_zat` must then equal that offer's prepay, `count` × (`amount_zat` + 10,000).
- **Without it:** `amount_zat` is 1 to 440,000, the most the shipped app asks for.

```json
{ "pocket_id": "pkt_…", "amount_zat": 90000, "offer_id": "off_…" }
```

The response is `{ "txid": "…", "mined_height": null }`: the runner answers while the payment is still in the mempool.

The faucet funds at most 30 pockets in any rolling hour, and at most 6 for one client address. Past either limit it answers `429` with `Retry-After` and `{ "error": "the sandbox faucet is rate limited; try again in n min" }`. A request with the merchant token is held to these limits too. A request that is refused for another reason does not count.

`POST /api/sandbox/cheat` makes the runner attempt a real violation against one subscription, and reports which check stopped it. `kind` is one of:

- `open_early`: open installment `k`'s package, which must still be sealed, with the newest drand beacon instead of its own round's. tlock refuses: `InvalidBeacon`. Stage `tlock`.
- `tamper_amount`: rebuild installment `k`, which must have opened, for 1 zat more and attach the payer's spend authorization from the package. The PCZT signer refuses: `InvalidExternalSignature`. Stage `signature`.
- `rebroadcast`: broadcast the newest mined installment again, whose pocket note is already spent. The node refuses it; the log carries the node's error. Stage `double-spend`. No cancel is needed. The old name `replay_after_cancel` is still accepted. `k` is ignored.
- `stretch_schedule`: copy the subscription's own schedule with installment 2 (installment 1 if `count` is 1) a year later, and run the upload check of `POST /api/subscriptions` on the copy, as of the subscription's `created_at`. Stage `schedule`. `k` is ignored.
- `charge_after_cancel` (runners that list it): charge the payer after they cancelled. For an hour after a cancel, the sandbox keeps the packages of the installments the cancel voided, and the pocket's wallet account. `k` must be the first installment the cancel voided, the only one whose input note ever existed.
  - Before that installment's drand round, the answer is `409` with `installment k opens in n s`.
  - After it, the runner opens the package, takes the rung for the next block, proves it against a fresh anchor and broadcasts it, as its scheduler would have. The node refuses it, because the cancel already spent its note. Stage `node`; the log carries the node's error.

```json
{ "subscription_id": "sub_…", "kind": "tamper_amount", "k": 2 }
```

The response is `200` with a verdict. `outcome` is `rejected` when the check stopped it, and `not_applicable` when there was nothing to try yet (for example, no installment mined for `rebroadcast`); the log then says why. An unknown `kind` is `400`.

```json
{ "kind": "stretch_schedule", "k": 2, "outcome": "rejected", "stage": "schedule",
  "log": [ "runner: copying the schedule with installment 2 sealed for 2027-10-26 20:39 UTC, 365 days after #1; the offer says every 90 s",
           "runner: checking the copy as POST /api/subscriptions checks every upload",
           "schedule check: installment 2 releases 31536090 s after installment 1; the offer says every 90 s, give or take 45 s" ] }
```

## Payer: subscribing

`POST /api/subscriptions` is called by the payer app after it pre-signs the ladder.

```json
{ "offer_id": "off_…",
  "pocket_id": "pkt_…",
  "installments": [
    { "k": 1, "release_round": 23456789, "sealed": "<base64 tlock(age(zstd(ladder_k)))>" }
  ],
  "payer_auth_key": "<64 hex, optional>" }
```

`payer_auth_key` is the payer's public key for signed requests (see "Payer auth, access passes and re-signing"). The web app sends it only to a runner that lists `payer_auth`. `cadence subscribe` always sends it, and an older runner ignores it.

The response is `201`:

```json
{ "subscription_id": "sub_…", "status": "active" }
```

The runner cannot read a package before its round, so it checks the schedule it is given against the offer (`api.rs::check_schedule`):

- exactly `count` installments, numbered `k` = 1…`count` in order;
- a pocket that backs no other subscription, and whose funding the runner has seen mined, worth at least `count` × (`amount_zat` + 10,000) zats;
- installment 1 releasing no later than `trial_secs` + `period_secs` + 600 s after the upload;
- each later installment releasing `period_secs` after the one before, give or take `period_secs` / 2 (rounded down);
- each package's tlock header naming its `release_round`.

A failure is `400`, for example `{ "error": "installment 2 releases 31536090 s after installment 1; the offer says every 90 s, give or take 45 s" }`.

Both payers in this build schedule installment *k* at `signed_at + trial_secs + lead + (k − 1) × period_secs + jitter_k`, rounded up to a drand round:

- the lead is the CLI's `--first-in` (default 60 s), or min(`period_secs`, 60 s) in the web app;
- each `jitter_k` is drawn by the payer's own signer, uniformly from 0 to *J* = ⌊min(`period_secs` / 4, 21,600)⌋ seconds, so installments do not fall due at exact intervals.

Every gap then stays within `period_secs` ± *J*, inside what this check allows, so runners from before jitter accept these schedules too. A larger `--first-in` is refused if it puts installment 1 more than `trial_secs` + `period_secs` + 600 s after the upload reaches the runner. There is no lower bound: an installment already due is released at once.

## Dashboard: subscriptions

`GET /api/subscriptions` lists every subscription; it needs the merchant's bearer token, except on a testnet sandbox runner, whose merchant is its own demo wallet. `GET /api/subscriptions/:id` returns one, and like `GET /api/pockets/:id` needs no token: the ids are random, and the payer's app polls them.

```json
{ "subscription_id": "sub_…", "offer_id": "off_…", "status": "active | completed | cancelled | stopped | stalled",
  "created_at": 1792677856, "funding": { "txid": "…", "mined_height": 4529209, "amount_zat": 12500000 },
  "installments": [
    { "k": 1, "amount_zat": 100000, "release_round": 23456789, "release_at": 1792680000,
      "state": "sealed | due | broadcast | mined | cancelled | missed | invalid",
      "txid": "…", "target_height": 4529247, "expiry_height": 4529367, "mined_height": 4529248 }
  ],
  "refundable": false }
```

`funding` is `null` when the runner has no funding record for the pocket. `txid`, `target_height`, `expiry_height` and `mined_height` are `null` until they apply.

Two fields come from runners that list `refund_after_stop`:

- `refundable` is `true` while a `stopped` or `stalled` subscription's pocket account is kept and the runner has not seen it refunded.
- `refund`, `{ "txid": "…", "mined_height": 4529301 }`, appears once the runner sees a transaction that is not an installment spend the pocket's note. It sees that spend whatever made it, the browser or `cadence sweep`. For a `stalled` subscription the same spend also reads as a cancel, so its status becomes `cancelled`.

`GET /api/subscriptions/:id` needs no token, so whoever has the id sees the refund's txid next to the subscription.

Installment states:

| State | Meaning |
|---|---|
| `sealed` | Still time-locked. Not even the runner can read it. |
| `due` | The drand round has passed, the package is open, and the runner is waiting for anchor depth. |
| `broadcast` | Sent to the network, not yet mined. |
| `mined` | Confirmed on chain. |
| `cancelled` | The payer spent the pocket note first, so the next installment can never be valid. Also set on every unreleased installment when the merchant stops the subscription. |
| `missed` | No rung covers the current height, so nothing was broadcast. The payer can cancel or sweep, and subscribe again. |
| `invalid` | The package opened but is not what the offer says: wrong installment, amount, recipient or expiry, or it does not decrypt. Nothing was broadcast. |

Before broadcasting, the runner checks each opened rung against the offer: the installment index and amount, an output to the merchant's Orchard receiver whose note commitment matches that amount, the branch, `lock_time = 0`, and the default expiry for its height. A `missed` or `invalid` installment sets the subscription to `stalled` and sends `invoice.expired`.

`POST /api/subscriptions/:id/stop` is the merchant stopping the subscription. It needs the bearer token, on the sandbox too. The runner discards the remaining packages and their beacons, and deletes its copy of the viewing key and the funding transaction.

- **A runner that lists `refund_after_stop`** keeps the pocket's wallet account. The payer's cancel key can then refund what is left from /manage, with the same calls as a cancel (`GET /api/pockets/:id`, `…/witness`, `POST /api/broadcast`). The runner deletes the account once it sees the refund, once nothing is left, or after 30 days. It also records an installment that was already in flight at the stop, and mined after it, as `mined`, and sends `invoice.confirmed` for it.
- **Any other runner** deletes the account at once.

Either way, whatever the pocket still holds stays the payer's, and `cadence sweep` returns it without the runner.

## Payer auth, access passes and re-signing

These exist on a runner whose `GET /api/status` lists `payer_auth`, `pass` and `resign`.

**The payer auth key.** The payer's signer derives an Ed25519 key from the 32-byte pocket seed. The key's seed is HKDF-SHA256 of the pocket seed, with salt `cadence payer auth v1`, empty info and 32 bytes of output. The web app and `cadence subscribe` send the public key, 64 hex characters, as `payer_auth_key` in `POST /api/subscriptions`, and the runner stores it with the subscription. A subscription uploaded without one can never make signed requests. Every pocket has its own seed, so the key ties together nothing beyond the one subscription.

**Signed requests** carry two headers:

```
X-Cadence-Payer-Timestamp: <unix seconds>
X-Cadence-Payer-Signature: <128 hex: Ed25519 over the message below>
```

The message is UTF-8:

```
cadence-payer-v1\n{METHOD}\n{PATH}\n{TIMESTAMP}\n{lowercase hex SHA-256 of the raw body}
```

`PATH` has no origin and no query, for example `/api/subscriptions/sub_…/pass`. The runner answers `403` in each of these cases:

- the subscription has no key;
- the timestamp is more than 300 s from the runner's clock;
- the signature does not verify against the stored key;
- the request repeats a signature the runner already accepted.

**Getting a pass.** `POST /api/subscriptions/:id/pass` is signed, with the body `{}`. It answers:

```json
{ "pass": "<base64url(payload)>.<base64url(signature)>", "valid_until": 1793175400 }
```

The payload is JSON. The signature is Ed25519 over its exact bytes, with the runner's pass key:

```json
{ "v": 1, "iss": "main | test | regtest", "offer_id": "off_…", "sub": "sub_…", "paid": 2, "valid_until": 1793175400, "iat": 1793170000 }
```

- `iss` is the runner's network, and `paid` the number of installments mined.
- `valid_until` is half a period past *T*. *T* is the release time of the first installment not yet mined, or, once every installment is mined, the last one's release time plus a period. During a trial nothing is mined yet, so a pass lasts until installment 1's release plus half a period.
- Only an `active` or `completed` subscription gets a pass. Any other status, or a `valid_until` already past, is `409`. An unknown subscription is `404`.

**Checking a pass.** Neither call needs a token:

- `GET /api/passes/key` returns `{ "alg": "Ed25519", "public_key": "<64 hex>" }`, so a merchant's server can check passes itself.
- `POST /api/passes/verify` with `{ "pass": "…" }` returns `{ "valid", "reason", "offer_id", "sub", "paid", "valid_until" }`.
  - `valid` means the signature checks and `valid_until` has not passed.
  - `reason` is `null`, `"malformed"`, `"bad signature"` or `"expired"`.
  - An expired pass still reports what it was for. One whose signature does not check reports `null` for the rest.

The runner makes the pass key once, as `pass-key.txt` next to its age identity (`--identity`), readable by the runner's user only (0600). A pass names the offer and the subscription, which the merchant already knows, and never the payer. It is a bearer token until `valid_until`: anyone who holds it can show it.

**Re-signing.** `POST /api/subscriptions/:id/resign` is signed, over the raw body, and takes bodies up to 80 MiB like the upload. It replaces the packages of the installments still sealed with newly signed ones, for the same drand rounds:

```json
{ "installments": [ { "k": 2, "release_round": 23456819, "sealed": "<base64>" } ] }
```

- **What it accepts.** The subscription must be `active`. The `k` values must be exactly the installments still `sealed`, and each `release_round` must equal the round that installment already has; each package's tlock header must name that round.
- **What it does.** It replaces all of those packages or none of them, then rewrites the database file (`VACUUM`), so the old packages leave no copy in free pages. States, rounds and the schedule stay as they were, and no webhook is sent.
- **The answer** is `200` with `{ "subscription_id": "sub_…", "replaced": [2, 3] }`.
- **Refusals.** `403` for a missing or bad signature, or a subscription with no payer key. `409` when the subscription is not active, when an installment given is no longer sealed (including one that opened while the request was checked), or when nothing is sealed. `400` for a malformed body, a wrong set of `k`, or a changed round. `404` for an unknown subscription.

`cadence resign` is the payer's side of this; the web app has no re-sign button. The runner cannot see inside the new packages until they open, as at the upload, and checks each opened rung against the offer as always. A payer who uploads packages that do not open, or do not pay, harms only themselves: they could cancel at any time anyway. The signature keeps anyone else from replacing a payer's packages.

## Evidence

`GET /api/decode/:txid` returns the public shape of any transaction. Next to the shape it lists `ironwood_nullifiers`, one hex nullifier per Ironwood action: public data, which a payer's cancellation certificate checks for the note its cancel spent. The runner reads it, and up to 12 tree states to place the anchor, from the lightwalletd server it syncs from, so that server sees which transactions are decoded. Decodes have a connection of their own to it, apart from the scheduler's (over Tor, on a circuit isolated from the scheduler's, unless the runner runs with `--direct`), so a burst of decodes cannot hold up a release. At most 4 decodes ask lightwalletd at once. One that waits more than 15 s for its turn is answered `503` with `the decoder is busy; try again shortly`. The shapes of up to 1,024 transactions mined at least 10 blocks below the tip are kept in memory, oldest dropped first, and served without asking lightwalletd again. The fields are the same as `cadence-decode`. Fields that do not apply are `null`: `mined_height` and `expiry_minus_mined` for an unmined transaction, and the Ironwood fields when there is no Ironwood bundle. The Orchard-pool fields (`orchard_flags` and so on) appear only when there is an Orchard-pool bundle.

```json
{ "txid": "…", "version": "V6", "branch_id": "77190ad9", "lock_time": 0, "expiry_height": 0,
  "mined_height": 0, "expiry_minus_mined": 120, "transparent_inputs": 0, "transparent_outputs": 0,
  "sapling_spends": 0, "sapling_outputs": 0, "orchard_actions": 0, "ironwood_actions": 2,
  "ironwood_flags": 7, "ironwood_value_balance": 10000, "ironwood_anchor": "…",
  "anchor_heights": [0, 0], "anchor_depths": [3, 3], "ironwood_proof_bytes": 7264,
  "zero_ovk_recoverable": 0, "supplied_ovk_recoverable": 0 }
```

`GET /api/status` reports the runner's view of the chain:

```json
{ "network": "test", "tip": 4529263, "drand_round": 23456789, "sandbox": false,
  "features": ["trial", "quote", "payer_auth", "pass", "refund_after_stop", "resign"],
  "scheduler": { "last_tick_at": 1792677850, "healthy": true } }
```

`network` is `main`, `test`, or `regtest` for a runner on a local regtest chain (`scripts/regtest/`). A sandbox runner also reports its faucet, `"faucet": { "balance_zat": 7990000, "notes": 48 }`. A regtest runner started with `--sandbox-funder` serves the sandbox endpoints too, funded by its own miner, but reports `"sandbox": false` and only the features every runner lists.

`features` lists what this runner implements beyond build 7244e6a: `trial`, `quote`, `payer_auth`, `pass`, `refund_after_stop` and `resign`, and on the testnet sandbox also `charge_after_cancel` and `fund_offer`. A runner that sends no `features`, such as the mainnet runner's build 7244e6a, has none of them; the web app reads a missing list as empty and talks to that runner as it always did.

`scheduler.last_tick_at` is when the scheduler last finished a tick, 0 until the first has. `healthy` is `false` when no tick has finished for 180 s, or when the last tick could not reach the chain tip or sync the wallet. It is `false` before the first tick too.

How many subscriptions a merchant has is the merchant's to know, so `subscriptions` (a count) is included only for a request with the merchant's bearer token, or on a sandbox runner, whose merchant is its own demo wallet.

## Limits

This build limits what one client can ask of the runner. Build 7244e6a, which the mainnet runner runs, has none of these, and accepts bodies of up to 80 MiB on every route.

**Rate limits.** Each client address has a token bucket for each class of route. The buckets are held in memory, so a restart forgets them.

| Class | Routes | Burst | Then |
|---|---|---|---|
| Pockets | `POST /api/pockets` | 6 | 1 a minute |
| Writes | every other `POST`, and everything under `/api/sandbox/` | 20 | 1 every 6 s |
| Decode | `GET /api/decode/:txid` | 20 | 1 every 3 s |
| Reads | every other `GET` | 300 | 1 every 100 ms |

- **Past a limit** the runner answers `429` with `Retry-After` (seconds) and `{ "error": "too many requests; try again in n s" }`. The web app treats a 429 as busy, not broken: it says when to try again, its polls wait at least that long, and an upload or a cancel is sent again after the wait.
- **The merchant token.** A request with a valid merchant token is never rate limited. The sandbox faucet's hourly limits still apply to it.
- **The client** is the socket's peer. With `--trust-forwarded` (env `CADENCE_TRUST_FORWARDED=1`, which the Railway entrypoint sets) it is the first `X-Forwarded-For` hop instead, which a client can forge unless the proxy in front replaces that header; whether Railway's does has not been checked (`deploy/README.md`). An IPv6 client counts by its /64.

**Body limits.** 80 MiB on `/api/subscriptions` and `/api/subscriptions/:id/resign`, which carry sealed packages, and 64 KiB on every other route. A larger body is `413`.

**Busy answers.** `POST /api/pockets` answers `503` while 1,000 registered pockets are neither funded nor forgotten. The decoder answers `503` when no turn frees up within 15 s.

**At boot**, the runner retries lightwalletd until it answers, waiting 5 s after the first failure and twice as long after each one, up to 2 minutes.

## CORS

Off by default, which is all a web app the runner serves itself (`--web-dir`) needs. A web app hosted on another origin (`VITE_API=runners`, `web/README.md`) needs the runner started with `--app-url <URL>` (env `CADENCE_APP_URL`) or `--cors-origin <ORIGIN>` (repeatable; env `CADENCE_CORS_ORIGINS`, comma-separated). The app URL's origin is always allowed. Origins must be exact (`*`, a path, a query or credentials are refused at startup). Then `/api/*` answers exactly those origins:

- methods `GET`, `POST` and `OPTIONS`;
- request headers `Content-Type`, `Authorization`, `X-Cadence-Payer-Timestamp` and `X-Cadence-Payer-Signature`;
- `Retry-After` exposed, so the page can read how long a 429 asks it to wait;
- no credentials (the merchant token is a header, never a cookie);
- `Vary: Origin`, and a preflight `max-age` of 600 s;
- `Cross-Origin-Resource-Policy: cross-origin` on API responses, which the app's `require-corp` allows.

The runner's own web files keep `Cross-Origin-Resource-Policy: same-origin` and the rest of their headers.

## Webhooks

The runner POSTs each event to `--webhook-url`, if both it and `CADENCE_WEBHOOK_SECRET` are set. Every POST carries two signatures over the same raw body, made with that one secret:

```
X-Cadence-Signature:     t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
X-CipherPay-Signature:   <hex HMAC-SHA256(secret, "<X-CipherPay-Timestamp>.<body>")>
X-CipherPay-Timestamp:   <the same second as t, UTC ISO 8601, e.g. 2026-02-21T18:30:00Z>
X-CipherPay-Delivery-Id: <a random v4 UUID, the same on every retry of one event>
```

**What carries over from CipherPay, and what does not.** The three `X-CipherPay-*` headers are computed the way CipherPay's webhook docs compute them, so CipherPay's signature verification code accepts them unchanged. `event` carries CipherPay's event name, so a `switch` on it works. The body is Cadence's, not CipherPay's: an installment is `subscription_id` plus `k`, not an invoice. CipherPay's `invoice_id`, `timestamp`, `price_zec`, `received_zec`, `overpaid`, `price_id` and `immediate` are never sent, so a CipherPay handler that reads them needs changing.

Every body has this form. `delivery_id` equals the `X-CipherPay-Delivery-Id` header; this copy is covered by both signatures, the header is not.

```json
{ "type": "invoice.confirmed", "event": "confirmed", "delivery_id": "…", "offer_id": "off_…",
  "subscription_id": "sub_…", "k": 1, "txid": "…" | null, "amount_zat": 100000, "mined_height": 4529248 | null }
```

| `type` | `event` (CipherPay's name) | Sent when |
|---|---|---|
| `invoice.confirmed` | `confirmed` | An installment is mined. |
| `invoice.expired` | `expired` | An installment cannot be released: its rung window passed (`missed`), or its package was refused (`invalid`). Nothing was paid, and the subscription is `stalled`. CipherPay's nearest subscription-level event is `subscription.past_due`; a handler may treat `expired` the same way. |
| `invoice.cancelled` | `subscription.canceled` | The payer spent the pocket. Sent without `immediate`: the period already paid for still runs. |

CipherPay's `detected`, `underpaid`, `invoice.created`, `subscription.renewed`, `subscription.paused`, `subscription.resumed` and `subscription.past_due` are never sent. A merchant stop sends nothing, though an installment that was in flight at the stop and mined after it still sends `invoice.confirmed` on a runner that lists `refund_after_stop`.

**Delivery.** Each event is delivered in its own task, so the scheduler never waits on the merchant.

- At most 3 attempts: at once, then 30 s and 2 minutes after a failure. Each attempt is signed afresh with its own timestamp, over the same body.
- Each attempt is capped at 10 s, from the DNS lookup to the response. Only a `2xx` counts; redirects are not followed.
- This is not CipherPay's retry schedule.
- The POST goes straight to the URL, not over Tor.

**No outbox.** Pending retries live in the runner's memory, so a restart drops them. An event whose 3 attempts all fail is dropped, with a line in the runner's log. The durable record is the runner's store: reconcile with `GET /api/subscriptions/:id` (or the list) rather than relying on webhooks alone. An event can arrive twice, and out of order (a retried `confirmed` for #1 can land after #2): dedupe on `delivery_id`, or on (`subscription_id`, `k`, `type`).

`scripts/webhook-echo.py` is a dependency-free receiver that checks both signatures, each with a 5-minute window, prints which passed, and answers `200` only if both do.
