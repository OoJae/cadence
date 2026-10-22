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

With no node of your own, drop `--direct` and point `--server` at a public lightwalletd. The runner then syncs and broadcasts over Tor.

## 2. Create an offer

```sh
curl -s -X POST https://pay.example.com/api/offers \
  -H "Authorization: Bearer $CADENCE_MERCHANT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Pro plan","amount_zat":5000000,"period_secs":2592000,"count":3,"merchant_ua":"u1…"}'
```

The response holds a `share_url`. The offer is encoded in its `#fragment`, so the link works from any page or message without telling your web server who clicked it.

## 3. Add a button

```html
<a href="https://pay.example.com/subscribe#offer=…" rel="noreferrer noopener">
  Subscribe with Zcash (Cadence)
</a>
```

The customer pays one QR code from Zodl or any Ironwood wallet, then closes the tab.

## 4. Handle webhooks

The events are `invoice.confirmed`, `invoice.expired` and `invoice.cancelled`. These are the same names CipherPay uses, so an existing handler keeps working. Every request carries:

```
X-Cadence-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

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
    case "invoice.expired":   /* the customer must re-sign; send a reminder */ break;
    case "invoice.cancelled": /* end access at the period boundary */ break;
  }
  res.sendStatus(200);
});
app.listen(8080);
```

`scripts/webhook-echo.py` is a dependency-free receiver for local testing.

## What you learn as a merchant

For each subscription you see:

- the prepaid balance of its single-use pocket;
- its schedule;
- each installment;
- whether the customer cancelled.

That is what any subscription merchant knows. You never see the customer's wallet, their other payments, or where a cancelled balance went. Every pocket output uses `OvkPolicy::Discard`. The full analysis is in [`threat-model.md`](threat-model.md).

## Operating notes

- **Liveness.** Each installment has a window of pre-signed heights. If the runner is offline for that whole window, the installment is marked `missed` and you receive `invoice.expired`.
- **Network upgrades.** Pre-signed transactions commit to the consensus branch. Cadence's windows skip the blocks just before NU7, and stop before the ZIP 2009 fee switch at height 3,590,000. Customers re-sign across such a boundary.
- **Cleanup.** When a subscription completes, is cancelled or is stopped (`POST /api/subscriptions/:id/stop`), the runner deletes the pocket's account and its sealed packages.
