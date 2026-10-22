# Cadence runner HTTP API (v0)

The runner serves JSON over HTTPS and, in production, over a Tor onion service. Amounts are zatoshis (integers). Heights are block heights. Times are unix seconds. A drand `round` is a drand quicknet round number.

## Merchant: offers (plans)

`POST /api/offers` creates a plan. The merchant authenticates with a bearer token.

```json
{ "name": "Shielded Press monthly", "amount_zat": 500000, "period_secs": 2592000,
  "count": 3, "merchant_ua": "u1…" }
```

The response is `201`. The share URL carries the offer in its **fragment**, so it never reaches a server:

```json
{ "offer_id": "off_…", "share_url": "https://pay.example/#offer=<base64url(offer json)>" }
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

The response is `201`:

```json
{ "pocket_id": "pkt_…", "birthday_height": 3529000, "tip": 3529001 }
```

`GET /api/pockets/:id` returns `funding` as `null` until the funding transaction is mined. `tx_hex` is the raw transaction; the app decrypts the note itself with `mandate::decrypt_funding`.

```json
{ "pocket_id": "pkt_…", "tip": 3529010, "funding": { "txid": "…", "tx_hex": "…", "mined_height": 3529004, "value_zat": 330000 },
  "notes": [ { "nullifier": "…", "value_zat": 220000, "mined_height": 3529009, "position": 123456 } ] }
```

`GET /api/pockets/:id/witness?nullifier=<hex>` gives the payer what it needs to cancel and prove in the browser. `auth_path` is 32 hex sibling hashes, leaf first.

```json
{ "target_height": 3529011, "anchor_height": 3529008, "anchor": "…", "position": 123456, "auth_path": ["…"] }
```

`POST /api/broadcast` relays a finished transaction. It is used for the browser's cancel. The runner learns of the cancel either way; the CLI and Tauri builds broadcast over Tor through a different server instead.

```json
{ "tx_hex": "…" }
```

The response is `{ "txid": "…" }`.

`POST /api/sandbox/fund` is testnet only and rate-limited. The runner's sandbox wallet pays `amount_zat` (plus fees) to the pocket.

```json
{ "pocket_id": "pkt_…", "amount_zat": 330000 }
```

The response is `{ "txid": "…" }`.

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

`GET /api/subscriptions` lists subscriptions. `GET /api/subscriptions/:id` returns one:

```json
{ "subscription_id": "sub_…", "offer_id": "off_…", "status": "active | completed | cancelled | stalled",
  "created_at": 1792677856, "funding": { "txid": "…", "mined_height": 4529209, "amount_zat": 12500000 },
  "installments": [
    { "k": 1, "amount_zat": 100000, "release_round": 23456789, "release_at": 1792680000,
      "state": "sealed | due | broadcast | mined | cancelled | missed",
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
| `cancelled` | The payer spent the pocket note first, so the next installment can never be valid. |
| `missed` | No rung covers the current height. The payer must re-sign. |

`POST /api/subscriptions/:id/stop` is the merchant stopping the subscription. The runner discards the remaining packages, deletes the pocket account and crypto-shreds its data.

## Evidence

`GET /api/decode/:txid` returns the public shape of any transaction, read from the runner's own node. The fields are the same as `cadence-decode`:

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
{ "network": "test", "tip": 4529263, "drand_round": 23456789, "subscriptions": 3 }
```

## Webhooks

The names and shape match CipherPay, so existing handlers work unchanged. The runner POSTs to the merchant's URL with the header `X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`:

| Event | Sent when |
|---|---|
| `invoice.confirmed` | An installment is mined. |
| `invoice.expired` | An installment window passes with no rung, so the payer must re-sign. |
| `invoice.cancelled` | The payer spent the pocket. |

Every body has the form `{ "type": "<event>", "subscription_id": "…", "k": 1, "txid": "…", "amount_zat": 100000 }`.
