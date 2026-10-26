# Cadence runner HTTP API (v0)

The runner serves JSON over HTTP behind a TLS proxy (Caddy, or Railway's edge), and can also be published as a Tor onion service (`deploy/torrc`). The payer CLI reaches it over Tor unless the runner is on a loopback address or `--direct` is given. Amounts are zatoshis (integers). Heights are block heights. Times are unix seconds. A drand `round` is a drand quicknet round number. Errors are `{ "error": "…" }` with a 4xx or 5xx status.

## Merchant: offers (plans)

`POST /api/offers` creates a plan. The merchant authenticates with a bearer token.

```json
{ "name": "Shielded Press monthly", "amount_zat": 500000, "period_secs": 2592000,
  "count": 3, "merchant_ua": "u1…" }
```

`count` is 1–12, `amount_zat` and `period_secs` must be positive, and `merchant_ua` must be a unified address with an Orchard receiver on the runner's network. The response is `201`. The share URL carries the offer in its **fragment**, so it never reaches a server:

```json
{ "offer_id": "off_…", "share_url": "https://pay.example/subscribe#offer=<base64url(offer json)>" }
```

The share URL's base is `--app-url` when the runner was started with one, and `--public-url` otherwise. `runner_endpoint` in the offer is always `--public-url`.

`GET /api/offers/:id` returns the offer the payer app signs against:

```json
{ "offer_id": "off_…", "name": "…", "amount_zat": 500000, "period_secs": 2592000, "count": 3,
  "merchant_ua": "u1…", "runner_age_recipient": "age1…", "runner_endpoint": "https://… | http://….onion",
  "network": "main | test", "drand_chain": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971" }
```

## Payer: pockets

The payer app is a browser, so it has no chain access of its own. Before it can sign, it asks the runner to watch the pocket. The runner learns nothing it would not learn from the subscription anyway.

`POST /api/pockets` registers a pocket:

```json
{ "pocket_ufvk": "uview1…" }
```

The response is `201`. The runner refuses a UFVK with any transparent or Sapling part.

```json
{ "pocket_id": "pkt_…", "birthday_height": 3529002, "tip": 3529001 }
```

A pocket that is never funded is forgotten after a day. One that is funded but never given packages is forgotten after a week; its funds stay the payer's (`cadence sweep`).

`GET /api/pockets/:id` returns `funding` as `null` until the funding transaction is mined. `tx_hex` is the raw transaction; the app decrypts the note itself with `mandate::decrypt_funding`. `notes` lists the pocket's mined, unspent notes, each with the txid that created it. `syncing` is `true` while the runner's wallet has not yet scanned the block of the latest mined installment, so the change it left is not listed yet.

```json
{ "pocket_id": "pkt_…", "tip": 3529010, "syncing": false, "birthday_height": 3529002,
  "funding": { "txid": "…", "tx_hex": "…", "mined_height": 3529004, "value_zat": 330000 },
  "notes": [ { "nullifier": "…", "value_zat": 220000, "txid": "…", "mined_height": 3529009, "position": 123456 } ] }
```

Once the subscription ends, the runner deletes the pocket's account, viewing key and funding transaction: `notes` is then empty and `tx_hex` is `""`, whatever the pocket still holds.

`GET /api/pockets/:id/witness?nullifier=<hex>` gives the payer what it needs to cancel and prove in the browser. `auth_path` is 32 hex sibling hashes, leaf first. It answers `400` until the note is 3 blocks deep. The payer checks `anchor` against an independent lightwalletd before using it.

```json
{ "target_height": 3529011, "anchor_height": 3529008, "anchor": "…", "position": 123456, "auth_path": ["…"] }
```

`POST /api/broadcast` relays a finished transaction. It is used for the browser's cancel. The runner learns of the cancel either way. The CLI broadcasts over Tor through an independent lightwalletd instead.

```json
{ "tx_hex": "…" }
```

The response is `{ "txid": "…" }`.

### Testnet sandbox

These exist only when the runner was started with `--sandbox-funder` on testnet (`/api/status` then reports `"sandbox": true`). The sandbox wallet is the runner's own, and it is disclosed as custodial.

`POST /api/sandbox/offer` creates a short demo plan paying the sandbox wallet. `count` is 1–6, `period_secs` 60–900 and `amount_zat` 10,000–200,000. The response is the same as `POST /api/offers`.

```json
{ "count": 3, "period_secs": 90, "amount_zat": 20000 }
```

`POST /api/sandbox/fund` pays a registered pocket once, at most 2,000,000 zats, from the sandbox wallet. Pass `pocket_id`, or the pocket's funding `ua`.

```json
{ "pocket_id": "pkt_…", "amount_zat": 330000 }
```

The response is `{ "txid": "…", "mined_height": null }`: the runner answers while the payment is still in the mempool.

`POST /api/sandbox/cheat` makes the runner attempt a real violation against one subscription, and reports which check stopped it. `kind` is one of:

- `open_early`: open installment `k`'s package, which must still be sealed, with the newest drand beacon instead of its own round's. tlock refuses: `InvalidBeacon`. Stage `tlock`.
- `tamper_amount`: rebuild installment `k`, which must have opened, for 1 zat more and attach the payer's spend authorization from the package. The PCZT signer refuses: `InvalidExternalSignature`. Stage `signature`.
- `rebroadcast`: broadcast the newest mined installment again, whose pocket note is already spent. The node refuses it; the log carries the node's error. Stage `double-spend`. No cancel is needed. The old name `replay_after_cancel` is still accepted. `k` is ignored.
- `stretch_schedule`: copy the subscription's own schedule with installment 2 (installment 1 if `count` is 1) a year later, and run the upload check of `POST /api/subscriptions` on the copy, as of the subscription's `created_at`. Stage `schedule`. `k` is ignored.

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
  ] }
```

The response is `201`:

```json
{ "subscription_id": "sub_…", "status": "active" }
```

The runner cannot read a package before its round, so it checks the schedule it is given against the offer (`api.rs::check_schedule`):

- exactly `count` installments, numbered `k` = 1…`count` in order;
- a pocket that backs no other subscription, and whose funding the runner has seen mined, worth at least `count` × (`amount_zat` + 10,000) zats;
- installment 1 releasing no later than `period_secs` + 600 s after the upload;
- each later installment releasing `period_secs` after the one before, give or take `period_secs` / 2 (rounded down);
- each package's tlock header naming its `release_round`.

A failure is `400`, for example `{ "error": "installment 2 releases 31536090 s after installment 1; the offer says every 90 s, give or take 45 s" }`. The CLI's default `--first-in 60` and the web app's schedule pass. A larger `--first-in` is refused if it puts installment 1 more than `period_secs` + 600 s after the upload reaches the runner. There is no lower bound: an installment already due is released at once.

## Dashboard: subscriptions

`GET /api/subscriptions` lists every subscription; it needs the merchant's bearer token, except on a testnet sandbox runner, whose merchant is its own demo wallet. `GET /api/subscriptions/:id` returns one, and like `GET /api/pockets/:id` needs no token: the ids are random, and the payer's app polls them.

```json
{ "subscription_id": "sub_…", "offer_id": "off_…", "status": "active | completed | cancelled | stopped | stalled",
  "created_at": 1792677856, "funding": { "txid": "…", "mined_height": 4529209, "amount_zat": 12500000 },
  "installments": [
    { "k": 1, "amount_zat": 100000, "release_round": 23456789, "release_at": 1792680000,
      "state": "sealed | due | broadcast | mined | cancelled | missed | invalid",
      "txid": "…", "target_height": 4529247, "expiry_height": 4529367, "mined_height": 4529248 }
  ] }
```

`funding` is `null` when the runner has no funding record for the pocket. `txid`, `target_height`, `expiry_height` and `mined_height` are `null` until they apply.

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

`POST /api/subscriptions/:id/stop` is the merchant stopping the subscription (bearer token). The runner discards the remaining packages and deletes the pocket's account, viewing key and funding transaction. Whatever the pocket still holds stays the payer's; `cadence sweep` returns it without the runner.

## Evidence

`GET /api/decode/:txid` returns the public shape of any transaction. The runner reads it, and up to 12 tree states to place the anchor, through its own sync connection to lightwalletd, so that server sees which transactions are decoded (over Tor, unless the runner runs with `--direct`). The shapes of up to 256 transactions mined at least 10 blocks below the tip are kept in memory, oldest dropped first, and served without asking lightwalletd again. The fields are the same as `cadence-decode`. Fields that do not apply are `null`: `mined_height` and `expiry_minus_mined` for an unmined transaction, and the Ironwood fields when there is no Ironwood bundle. The Orchard-pool fields (`orchard_flags` and so on) appear only when there is an Orchard-pool bundle.

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
{ "network": "test", "tip": 4529263, "drand_round": 23456789, "sandbox": false }
```

How many subscriptions a merchant has is the merchant's to know, so `subscriptions` (a count) is included only for a request with the merchant's bearer token, or on a sandbox runner, whose merchant is its own demo wallet.

## CORS

Off by default, which is all a web app the runner serves itself (`--web-dir`) needs. A web app hosted on another origin (`VITE_API=runners`, `web/README.md`) needs the runner started with `--app-url <URL>` (env `CADENCE_APP_URL`) or `--cors-origin <ORIGIN>` (repeatable; env `CADENCE_CORS_ORIGINS`, comma-separated). The app URL's origin is always allowed. Origins must be exact (`*`, a path, a query or credentials are refused at startup). Then `/api/*` answers exactly those origins:

- methods `GET`, `POST` and `OPTIONS`; request headers `Content-Type` and `Authorization`; no credentials (the merchant token is a header, never a cookie);
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

CipherPay's `detected`, `underpaid`, `invoice.created`, `subscription.renewed`, `subscription.paused`, `subscription.resumed` and `subscription.past_due` are never sent. A merchant stop sends nothing.

**Delivery.** Each event is delivered in its own task, so the scheduler never waits on the merchant.

- At most 3 attempts: at once, then 30 s and 2 minutes after a failure. Each attempt is signed afresh with its own timestamp, over the same body.
- Each attempt is capped at 10 s, from the DNS lookup to the response. Only a `2xx` counts; redirects are not followed.
- This is not CipherPay's retry schedule.
- The POST goes straight to the URL, not over Tor.

**No outbox.** Pending retries live in the runner's memory, so a restart drops them. An event whose 3 attempts all fail is dropped, with a line in the runner's log. The durable record is the runner's store: reconcile with `GET /api/subscriptions/:id` (or the list) rather than relying on webhooks alone. An event can arrive twice, and out of order (a retried `confirmed` for #1 can land after #2): dedupe on `delivery_id`, or on (`subscription_id`, `k`, `type`).

`scripts/webhook-echo.py` is a dependency-free receiver that checks both signatures, each with a 5-minute window, prints which passed, and answers `200` only if both do.
