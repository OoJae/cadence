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

`deploy/docker-compose.yml` runs the whole stack: Zebra 7, lightwalletd, the runner, Caddy and an onion service.

With no node of your own, drop `--direct` and point `--server` at a public lightwalletd. The runner then syncs and broadcasts over Tor. drand beacons are fetched over Tor either way.

To serve the payer app from your runner, add `--web-dir web/dist`. To have it served from another origin instead (a `VITE_API=runners` build on an app host, `deploy/README.md`), add `--app-url https://app.example`: share links then point there, and that origin may call the API (`docs/api.md`, "CORS").

## 2. Create an offer

```sh
curl -s -X POST https://pay.example.com/api/offers \
  -H "Authorization: Bearer $CADENCE_MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Pro plan","amount_zat":5000000,"period_secs":2592000,"count":3,"merchant_ua":"u1…"}'
```

`merchant_ua` must be a unified address with an Orchard receiver on the runner's network: `u1…` on mainnet, `utest1…` on testnet. The runner refuses anything else, and the dashboard checks the address against the network `GET /api/status` reports.

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

## What you learn as a merchant

For each subscription you see:

- the prepaid balance of its single-use pocket;
- its schedule;
- each installment;
- whether the customer cancelled.

That is what any subscription merchant knows. You never see the customer's wallet, their other payments, or where a cancelled balance went. Every pocket output uses `OvkPolicy::Discard`. The full analysis is in [`threat-model.md`](threat-model.md).

## Operating notes

- **Liveness.** Each installment has a window of pre-signed heights. If the runner is offline for that whole window, the installment is marked `missed` and you receive `invoice.expired`.
- **Schedules are checked on upload.** The runner accepts a subscription only with exactly the offer's count, a pocket it has seen funded for every installment and its fee, installment 1 due within one period plus 10 minutes, and each later one a period after the last, give or take half a period. A customer cannot hand you a plan stretched over a year.
- **Packages are checked before release.** The runner broadcasts an installment only if it pays your address exactly the offer's amount, with the default expiry for its height. Anything else is marked `invalid`, and you receive `invoice.expired`.
- **Your subscriber count is yours.** `GET /api/status` includes it only with your bearer token, and `GET /api/subscriptions` needs the token.
- **Who serves the payer app.** If your runner serves it (`--web-dir`), you serve the code that holds your customers' pocket keys, and customers have to trust you with that. An app host you do not control (`VITE_API=runners`, `deploy/README.md`), whose build identity customers can check, removes that, and so does the CLI.
- **Memos.** Each installment carries a text memo your wallet shows, such as "Cadence · Pro plan (pkt_…) · payment 2 of 3".
- **Network upgrades.** Pre-signed transactions commit to the consensus branch and the fee. Cadence's windows skip the blocks just before NU7, and from the ZIP 2009 fee switch (height 3,590,000) installments pay the new 2,000-zat fee, as ZIP 2009 tells wallets to. An upgrade that was not scheduled when the customer signed needs a new subscription.
- **Cleanup.** When a subscription completes, is cancelled or is stopped (`POST /api/subscriptions/:id/stop`), the runner deletes the pocket's account, viewing key, funding transaction and sealed packages. If you stop a subscription early, what is left in the pocket stays the customer's, and they recover it with `cadence sweep`.
