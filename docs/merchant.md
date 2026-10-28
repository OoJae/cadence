# Accepting Cadence subscriptions

A merchant runs `cadence-runner` next to their own Zcash node, creates offers, and links customers to them. Cadence never holds the merchant's funds. Installments pay the merchant's unified address directly, as ordinary shielded transactions.

## 1. Run the runner

```sh
cadence-runner init --network main
CADENCE_MERCHANT_TOKEN=$(openssl rand -hex 24) \
CADENCE_WEBHOOK_SECRET=$(openssl rand -hex 24) \
cadence-runner serve --network main \
  --server http://127.0.0.1:9067 --direct \
  --public-url https://pay.example.com \
  --webhook-url https://shop.example.com/cadence/webhook
```

`deploy/docker-compose.yml` describes the whole stack: Zebra 7, lightwalletd, the runner, Caddy and an onion service. It is written for a server of your own and has not yet been run end to end; the live demo runs on Railway without a node (`deploy/README.md`).

With no node of your own, drop `--direct` and point `--server` at a public lightwalletd. The runner then syncs and broadcasts over Tor. drand beacons are fetched over Tor either way.

To serve the payer app from your runner, add `--web-dir web/dist`. To have it served from another origin instead (a `VITE_API=runners` build on an app host, `deploy/README.md`), add `--app-url https://app.example`: share links then point there, and that origin may call the API (`docs/api.md`, "CORS").

## 2. Create an offer

```sh
curl -s -X POST https://pay.example.com/api/offers \
  -H "Authorization: Bearer $CADENCE_MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Pro plan","amount_zat":5000000,"period_secs":604800,"count":4,"merchant_ua":"u1…"}'
```

`merchant_ua` must be a unified address with an Orchard receiver on the runner's network: `u1…` on mainnet, `utest1…` on testnet. The runner refuses anything else, and the dashboard checks the address against the network `GET /api/status` reports. Keep the last installment within about 45 days of signing, counting any trial: longer plans exceed the sealed package's 64 MiB cap and cannot be signed yet (`docs/api.md`).

A runner that lists `trial` and `quote` in `GET /api/status` (this build; the mainnet runner's build 7244e6a does not) also takes a free trial and a price label:

```sh
curl -s -X POST https://pay.example.com/api/offers \
  -H "Authorization: Bearer $CADENCE_MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Pro plan","amount_zat":11876485,"period_secs":604800,"count":4,"merchant_ua":"u1…",
       "trial_secs":604800,
       "quote":{"currency":"USD","amount_minor":500,"zec_rate_minor":4210,"set_at":1793170000}}'
```

Here a week's trial comes first, and US$5.00 at your rate of US$42.10 per ZEC is 11,876,485 zats.

- **`trial_secs`** delays installment 1, and so every later one, by up to 30 days. The trial counts towards the 45 days, and the dashboard counts it when it says how many installments fit.
- **`quote`** is your own label: a price per installment in a currency of your choice, and the rate you used. The payer's page shows it next to the ZEC amount the payer signs, and warns the payer when the two disagree by more than 1% at your rate. `amount_zat` is what is paid. Nothing checks the label against a market price, and nothing in Cadence fetches a price feed.
- **The dashboard's form** takes the price and your rate, and computes `amount_zat = round(amount_minor / zec_rate_minor × 100,000,000)` once, when you create the offer.

The response holds a `share_url`. The offer is encoded in its `#fragment`, so the link works from any page or message without telling your web server who clicked it.

## 3. Add a button

```html
<a href="https://pay.example.com/subscribe#offer=…" rel="noreferrer noopener">
  Subscribe with Zcash (Cadence)
</a>
```

The customer pays one QR code from Zodl or any Ironwood wallet, saves a cancel key and checks that it opens (or chooses to go without one), then closes the tab.

## 4. Handle webhooks

The runner sends webhooks only when both `--webhook-url` and `CADENCE_WEBHOOK_SECRET` are set. Every POST carries two signatures over the same raw body, with that one secret:

```
X-Cadence-Signature:     t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
X-CipherPay-Signature:   <hex HMAC-SHA256(secret, "<X-CipherPay-Timestamp>.<raw body>")>
X-CipherPay-Timestamp:   <the same second, UTC ISO 8601, e.g. 2026-02-21T18:30:00Z>
X-CipherPay-Delivery-Id: <a random v4 UUID, the same on every retry>
```

The body is `{ "type", "event", "delivery_id", "offer_id", "subscription_id", "k", "txid" | null, "amount_zat", "mined_height" | null }`:

| `type` | `event` | Sent when |
|---|---|---|
| `invoice.confirmed` | `confirmed` | An installment is mined. |
| `invoice.expired` | `expired` | An installment was missed or refused; nothing was paid, and the subscription is `stalled`. |
| `invoice.cancelled` | `subscription.canceled` | The payer spent the pocket. The period already paid for still runs. |

**Coming from CipherPay.** Two things carry over unchanged: CipherPay's signature verification, because the `X-CipherPay-*` headers are computed as CipherPay computes them, and a `switch` on `event`, which carries CipherPay's event names. Nothing else does. There is no `invoice_id`: an installment is `subscription_id` plus `k`. CipherPay's `timestamp`, `price_zec`, `received_zec`, `overpaid`, `price_id` and `immediate` are not sent, and neither are its other events (`detected`, `underpaid`, `invoice.created`, `subscription.renewed`, `subscription.paused`, `subscription.resumed`, `subscription.past_due`). A handler that treats `subscription.past_due` as "this period went unpaid" can treat `expired` the same way.

**Delivery is best-effort.** At most 3 attempts: at once, then 30 s and 2 minutes after a failure, each capped at 10 s. Only a `2xx` counts, and redirects are not followed. Retries live in the runner's memory, so a restart drops them, and an event whose attempts all fail is dropped, with a line in the runner's log. There is no outbox. Reconcile from `GET /api/subscriptions/:id`, which is durable, and dedupe on `delivery_id`, or on (`subscription_id`, `k`, `type`): an event can arrive twice, or after a later one.

Verifying `X-Cadence-Signature`:

```js
// Express. Verify against the raw body, before JSON parsing.
import crypto from "node:crypto";
import express from "express";

const app = express();
app.post("/cadence/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = Object.fromEntries(
    String(req.get("X-Cadence-Signature") ?? "").split(",").map((p) => p.split("=")),
  );
  const expected = crypto
    .createHmac("sha256", process.env.CADENCE_WEBHOOK_SECRET)
    .update(`${sig.t}.`)
    .update(req.body)
    .digest("hex");
  const ok =
    typeof sig.v1 === "string" &&
    sig.v1.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig.v1), Buffer.from(expected));
  if (!ok || Math.abs(Date.now() / 1000 - Number(sig.t)) > 300) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  switch (event.type) {
    case "invoice.confirmed": /* extend access for event.subscription_id */ break;
    case "invoice.expired":   /* nothing was paid; ask the customer to subscribe again */ break;
    case "invoice.cancelled": /* end access at the period boundary */ break;
  }
  res.sendStatus(200);
});
app.listen(8080);
```

`scripts/webhook-echo.py` is a dependency-free receiver for local testing. It checks both signatures and answers `200` only if both pass.

## 5. Check access passes (optional)

A runner that lists `pass` in `GET /api/status` gives a payer an **access pass** when they ask for one ("Get an access pass" on the payer's done screen and on /manage). The payer's browser signs the request with a key derived from the pocket seed, and the runner answers with a token it signs itself: `<base64url(payload)>.<base64url(signature)>`, the payload `{ v, iss, offer_id, sub, paid, valid_until, iat }` (`docs/api.md`, "Payer auth, access passes and re-signing").

- **What it says.** The pass names your offer and the subscription, and how many installments are paid. It never names the payer.
- **How long it holds.** `valid_until` is half a period past the next installment's release. A payer who stops paying keeps an old pass only until then, and the runner issues no new pass to a subscription that is not `active` or `completed`.
- **It is a bearer token.** Until `valid_until`, anyone who holds it can show it.

Your site can check a pass with the runner's public key from `GET /api/passes/key`, with no call to the runner per pass. In Node:

```js
import { createPublicKey, verify } from "node:crypto";
// RUNNER_PASS_KEY: public_key from GET /api/passes/key. MY_OFFER_ID: your offer.
const key = createPublicKey({ key: Buffer.from("302a300506032b6570032100" + RUNNER_PASS_KEY, "hex"), format: "der", type: "spki" });
const [payload, signature] = pass.split(".").map((part) => Buffer.from(part, "base64url"));
const claims = JSON.parse(payload);
const ok = verify(null, payload, key, signature) && claims.valid_until >= Date.now() / 1000 && claims.offer_id === MY_OFFER_ID;
```

Or ask the runner: `POST /api/passes/verify` with `{ "pass": "…" }`. The web app's `/pass` page checks a pass both ways and shows the same example.

## What you learn as a merchant

For each subscription you see:

- the prepaid balance of its single-use pocket;
- its schedule;
- each installment;
- whether the customer cancelled;
- after a stop or a missed installment, the transaction that refunds what was left, while your runner keeps the pocket for it (this build; see "Cleanup" below).

That is what any subscription merchant knows. You never see the customer's wallet, their other payments, or where a cancelled or refunded balance went. Every pocket output uses `OvkPolicy::Discard`. The full analysis is in [`threat-model.md`](threat-model.md).

## Operating notes

- **Liveness.** Each installment has a window of pre-signed heights. If the runner is offline for that whole window, the installment is marked `missed` and you receive `invoice.expired`.
- **Schedules are checked on upload.** The runner accepts a subscription only with exactly the offer's count, a pocket it has seen funded for every installment and its fee, installment 1 due within the trial plus one period plus 10 minutes, and each later one a period after the last, give or take half a period. A customer cannot hand you a plan stretched over a year. The payer's signer moves each installment up to a quarter period later at random (at most 6 hours), so payments arrive near, not exactly at, the period.
- **Packages are checked before release.** The runner broadcasts an installment only if it pays your address exactly the offer's amount, with the default expiry for its height. Anything else is marked `invalid`, and you receive `invoice.expired`.
- **Your subscriber count is yours.** `GET /api/status` includes it only with your bearer token, and `GET /api/subscriptions` needs the token.
- **Stopping needs your token.** `POST /api/subscriptions/:id/stop` needs the bearer token. The dashboard sends the one you enter; on the public sandbox, whose token the demo does not hand out, its Stop button is disabled.
- **Rate limits.** This build limits each client address per class of route, and answers `429` with `Retry-After` past a limit; a request with your bearer token is never limited (`docs/api.md`, "Limits"). Behind a proxy, every client has the proxy's address unless you set `CADENCE_TRUST_FORWARDED=1`. The limits then count the first `X-Forwarded-For` hop, which a client can forge unless your proxy replaces that header rather than appending to it.
- **Health.** `GET /api/status` reports `scheduler.healthy`, which is `false` when no scheduler tick has finished for 180 s or the last chain sync failed. It is a good thing to alert on.
- **Who serves the payer app.** If your runner serves it (`--web-dir`), you serve the code that holds your customers' pocket keys, and customers have to trust you with that. An app host you do not control (`VITE_API=runners`, `deploy/README.md`), whose build identity customers can check, removes that, and so does the CLI.
- **Memos.** Each installment carries a text memo your wallet shows, such as "Cadence · Pro plan (pkt_…) · payment 2 of 3".
- **Network upgrades.** Pre-signed transactions commit to the consensus branch and the fee. Cadence's windows skip the blocks just before NU7, and from the ZIP 2009 fee switch (height 3,590,000) installments pay the new 2,000-zat fee, as ZIP 2009 tells wallets to. An upgrade that was not scheduled when the customer signed would void the installments past it. On a runner that lists `resign`, the customer can sign those again with a `cadence resign` built with the new rules, for the same dates, while the subscription is active and before the installments open (`docs/api.md`). Otherwise, and for a subscription made without a payer key, it needs a new subscription. A missed or invalid installment cannot be re-signed: the subscription is `stalled`, and the customer cancels or sweeps and subscribes again.
- **Cleanup.** When a subscription completes or is cancelled, the runner deletes the pocket's wallet account, its copy of the viewing key, the raw funding transaction and the sealed packages. A stop (`POST /api/subscriptions/:id/stop`) deletes the packages, the copy of the viewing key and the funding transaction at once. A runner that lists `refund_after_stop` keeps the pocket's wallet account after a stop, and after a missed installment, so the customer can refund what is left from the browser; it deletes the account when it sees the refund, when nothing is left, or after 30 days. While it keeps the account it sees any spend of the pocket, the refund included, and shows the refund's txid in the subscription. Older runners delete the account at once, and the customer recovers what is left with `cadence sweep`. The funding txid and amount and the installment txids stay, as the record of what was paid. On the sandbox, a cancelled subscription's voided packages and its pocket's account are kept for an hour, for the "Charge me after I cancel" demo.
- **Before upgrading a runner.** A runner of this build adds columns to the state database when it first opens it. After that, an older build can still open the file, but can no longer create offers or subscriptions in it. Back the database up before the upgrade, and roll back by restoring that backup, not by starting the old build on the migrated file (`deploy/README.md`).
