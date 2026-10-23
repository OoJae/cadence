# Cadence runner HTTP API (v0)

The runner serves JSON over HTTPS, and can also be published as a Tor onion service (`deploy/torrc`). The payer CLI reaches it over Tor unless it runs on the same machine. Amounts are zatoshis (integers). Heights are block heights. Times are unix seconds. A drand `round` is a drand quicknet round number.

## Merchant: offers (plans)

`POST /api/offers` creates a plan. The merchant authenticates with a bearer token.

```json
{ "name": "Shielded Press monthly", "amount_zat": 500000, "period_secs": 2592000,
  "count": 3, "merchant_ua": "u1…" }
```

The response is `201`. The share URL carries the offer in its **fragment**, so it never reaches a server:

```json
{ "offer_id": "off_…", "share_url": "https://pay.example/subscribe#offer=<base64url(offer json)>" }
```

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

`GET /api/pockets/:id` returns `funding` as `null` until the funding transaction is mined. `tx_hex` is the raw transaction; the app decrypts the note itself with `mandate::decrypt_funding`. `notes` lists the pocket's mined, unspent notes.

```json
{ "pocket_id": "pkt_…", "tip": 3529010, "birthday_height": 3529002,
  "funding": { "txid": "…", "tx_hex": "…", "mined_height": 3529004, "value_zat": 330000 },
  "notes": [ { "nullifier": "…", "value_zat": 220000, "mined_height": 3529009, "position": 123456 } ] }
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

The response is `{ "txid": "…" }`.

`POST /api/sandbox/cheat` makes the runner attempt a real violation against one installment, and reports which check stopped it. `kind` is one of:

- `open_early`: open the package before its drand round. tlock refuses: `InvalidBeacon`.
- `tamper_amount`: rebuild the installment for 1 zat more and reuse the payer's signature. The transaction extractor refuses: `InvalidExternalSignature`.
- `replay`: rebroadcast an installment that is already mined. The node refuses the double-spend.

```json
{ "subscription_id": "sub_…", "kind": "tamper_amount", "k": 2 }
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

## Dashboard: subscriptions

`GET /api/subscriptions` lists every subscription; it needs the merchant's bearer token. `GET /api/subscriptions/:id` returns one, and like `GET /api/pockets/:id` needs no token: the ids are random, and the payer's app polls them.

```json
{ "subscription_id": "sub_…", "offer_id": "off_…", "status": "active | completed | cancelled | stopped | stalled",
  "created_at": 1792677856, "funding": { "txid": "…", "mined_height": 4529209, "amount_zat": 12500000 },
  "installments": [
    { "k": 1, "amount_zat": 100000, "release_round": 23456789, "release_at": 1792680000,
      "state": "sealed | due | broadcast | mined | cancelled | missed | invalid",
      "txid": "…", "target_height": 4529247, "mined_height": 4529248 }
  ] }
```

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

`GET /api/decode/:txid` returns the public shape of any transaction, read through the runner's lightwalletd. The fields are the same as `cadence-decode`:

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
{ "network": "test", "tip": 4529263, "drand_round": 23456789, "subscriptions": 3, "sandbox": true }
```

## Webhooks

The names and shape match CipherPay, so existing handlers work unchanged. The runner POSTs to the merchant's URL with the header `X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`:

| Event | Sent when |
|---|---|
| `invoice.confirmed` | An installment is mined. |
| `invoice.expired` | An installment cannot be released: its rung window passed, or its package was refused. Nothing was paid. |
| `invoice.cancelled` | The payer spent the pocket. |

Every body has the form `{ "type": "<event>", "subscription_id": "…", "k": 1, "txid": "…" | null, "amount_zat": 100000, "mined_height": 4529248 | null }`.
