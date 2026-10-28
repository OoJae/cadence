# Deploying Cadence

## Railway (no node of our own)

The live demo runs on Railway, one service per runner, each serving the web app on its own origin:

| Service | Network | Variables |
|---|---|---|
| `sandbox` | testnet | `CADENCE_NETWORK=test`, `CADENCE_DATA=/data`, `PORT=8080`, `CADENCE_MERCHANT_TOKEN`, `SANDBOX_FUNDER_SEED`, `SANDBOX_FUNDER_BIRTHDAY` |
| `main` | mainnet | `CADENCE_NETWORK=main`, `CADENCE_DATA=/data`, `PORT=8080`, `CADENCE_MERCHANT_TOKEN` |

Each service has a volume at `/data` (wallet, records, age identity, Tor state, and from this build the access-pass key `pass-key.txt`) and a generated `*.up.railway.app` domain on port 8080. `deploy/railway/entrypoint.sh` initialises the runner on first boot. Without a node, both runners reach public lightwalletd servers and drand over Tor.

`deploy/railway/railway.json`, which `stage.sh` copies into the upload, sets the restart policy to `ALWAYS`, so Railway restarts a runner that exits. At boot this build retries lightwalletd until it answers, waiting 5 s, then twice as long after each failure, up to 2 minutes, so a runner restarted while lightwalletd is down comes back once it is up.

Optional variables, read by the entrypoint:

| Variable | Effect |
|---|---|
| `CADENCE_LIGHTWALLETD` | The lightwalletd to sync from (default `zec.rocks`, or `testnet.zec.rocks`). |
| `CADENCE_BROADCAST_LIGHTWALLETD` | A second lightwalletd for broadcasts (default: the sync server). Broadcasts use their own Tor state either way. |
| `CADENCE_WEBHOOK_URL`, `CADENCE_WEBHOOK_SECRET` | Where to POST signed webhooks (`docs/api.md`, "Webhooks"). Both are needed. |
| `CADENCE_APP_URL` | Where the web app is hosted, when not by this runner: share links point there, and its origin may call the API. |
| `CADENCE_CORS_ORIGINS` | Further origins that may call the API, comma-separated, exact (no `*`, no path). |
| `CADENCE_TRUST_FORWARDED` | The entrypoint sets it to `1` unless it is set already. The rate limits (`docs/api.md`, "Limits") then count each client by the first `X-Forwarded-For` hop, because Railway's proxy is the socket peer of every request. |

A client cannot choose the address it is counted as on Railway. This was checked on Oct 28 against the sandbox, with deliberately invalid `POST /api/pockets` requests:
- Six requests with `X-Forwarded-For: 203.0.113.7` used up the burst, and the seventh got `429`.
- Eight more, each claiming a different address (`198.51.100.1` to `.8`), all got `429` too.

So Railway's proxy puts the client's real address first, whatever the client sends. Behind another proxy, check this before setting `CADENCE_TRUST_FORWARDED`. The limits that are not per client hold regardless: the faucet's 30 fundings an hour, the 1,000 pending pockets, and the 4 decodes at once.

Railway terminates TLS in front of each service, so it sees the IP address and request paths of every visitor (`docs/threat-model.md`, §5).

Deploy from a checkout with the web app built:

```sh
deploy/railway/stage.sh /tmp/cadence-stage        # code, web/dist and the Dockerfile only
railway up /tmp/cadence-stage --path-as-root --service sandbox --detach
railway up /tmp/cadence-stage --path-as-root --service main --detach
```

> **The `main` service is frozen until the weekly mainnet mandate completes on 17 Nov 2026.** Do not redeploy it or change its variables: it holds the sealed packages of a live mandate (`evidence/mainnet.md`). Deploy only `app`, and `sandbox` only if you must. `main` stays on build 7244e6a: nothing in `features` (`docs/api.md`, "Status"), the rate limits or the kept pockets after a stop applies to it.

> **Rolling back after an upgrade.** On its first start, a runner of this build adds columns to the state database (`store.rs::migrate`). An older build can still open the migrated file, but its inserts name no columns, so it can no longer create offers or subscriptions. Take a backup of the volume before deploying, and roll back by restoring that backup, not by redeploying the old build.

Only one process may use a given sandbox funder seed at a time: stop any local sandbox runner first.

## App host (the web app on an origin of its own)

When a runner serves the web app, the merchant serves the code that holds the payer's pocket key (`docs/threat-model.md`, §6). An app host serves the same app from an origin of its own, and the runners keep only the API. This mode is built, tested (`cd web && pnpm verify:app-host`) and deployed for the demo at https://app-production-be97.up.railway.app, talking to the sandbox and mainnet runners.

1. Build a `VITE_API=runners` app. It talks to exactly the runners listed, and its CSP `connect-src` is `'self'` plus those origins:

   ```sh
   cd web && pnpm build:wasm
   VITE_SIGNER=wasm VITE_API=runners \
     VITE_RUNNERS="https://<sandbox domain>,https://<main domain>" \
     VITE_DEFAULT_RUNNER="https://<sandbox domain>" pnpm build && cd ..
   ```

2. Stage and deploy it on a Railway service of its own, with a generated domain and no volume:

   ```sh
   deploy/railway-app/stage.sh /tmp/cadence-app-stage        # web/dist, the Dockerfile and the Caddyfile only
   railway up /tmp/cadence-app-stage --path-as-root --service app --detach
   ```

   `stage.sh` builds nothing, and refuses a dist that is not a `runners` build. The image is `caddy:2.11.4-alpine` running as uid 10001, with no access log and no admin endpoint. It sends the build's own CSP from `dist/csp.txt`, and the same COOP, COEP, CORP, Referrer-Policy and Permissions-Policy headers as `deploy/Caddyfile`. Content-hashed files under `/assets/` are cached for a year as immutable. Everything else, including `index.html`, `build.json` and the WebAssembly, is `no-cache`, so a redeploy takes effect on the next load. A missing `/assets/` file is a plain 404 with the same headers, never `index.html`.

3. Set `CADENCE_APP_URL=https://<app domain>` on each runner and redeploy it. Share links then point at the app host, and the runners answer its origin's requests (`docs/api.md`, "CORS"). Without this, the browser blocks the app's API calls.

4. Check what the host serves against a build you made or trust: `web/README.md`, "Build identity". The footer shows the commit and the bundle's sha256 from the host's `build.json`, which is only the host's claim until you compare it.

## A server with our own node

This section describes the design target. It is written for a server of your own and has not yet been run end to end: the live demo runs on Railway, above, without a node.

One server runs everything: a Zebra mainnet node with lightwalletd, the mainnet runner, the testnet judge sandbox, Caddy for TLS, and a Tor onion service for the mainnet runner.

## 1. Server

- Ubuntu 24.04, 4 or more vCPUs, 16 GB RAM.
- About 400 GB of disk for Zebra's mainnet state, mounted at `/mnt/cadence`. The disk should be encrypted (see the threat model, §2).
- Open inbound ports 22, 80, 443 and 8233 (Zebra P2P). Nothing else.

```sh
curl -fsSL https://get.docker.com | sh
mkdir -p /mnt/cadence/{zebra,lwd,runner-main,runner-sandbox,caddy}
chown -R 10001:10001 /mnt/cadence/runner-main /mnt/cadence/runner-sandbox   # the runner image's uid
# Zebra runs as its own user; give it its cache directory:
chown -R "$(docker run --rm --entrypoint id zfnd/zebra:7.0.0 -u):$(docker run --rm --entrypoint id zfnd/zebra:7.0.0 -g)" /mnt/cadence/zebra
```

## 2. Code and web app

Build the web app on a development machine, where the wasm toolchain already is, then copy the repository over:

```sh
cd web && pnpm build:wasm && VITE_SIGNER=wasm VITE_API=self pnpm build && cd ..
rsync -a --exclude target --exclude node_modules --exclude .cadence --exclude pockets \
  ./ root@SERVER:/opt/cadence/
```

## 3. Secrets and names

```sh
cd /opt/cadence/deploy
cp .env.example .env
# Set CADENCE_MERCHANT_TOKEN and CADENCE_WEBHOOK_SECRET with: openssl rand -hex 24
# Set PUBLIC_HOST, SANDBOX_HOST, PUBLIC_URL and SANDBOX_URL from the server's IP:
# 203.0.113.7 becomes 203-0-113-7.sslip.io, so no domain purchase is needed.
```

## 4. Runners

```sh
docker compose run --rm runner-main init --network main
docker compose run --rm runner-sandbox init --network test
# The sandbox wallet's dev pocket file (testnet only):
scp pockets/sandbox-funder.json root@SERVER:/mnt/cadence/runner-sandbox/
chown 10001:10001 /mnt/cadence/runner-sandbox/sandbox-funder.json
```

## 5. Start

```sh
docker compose up -d zebra lightwalletd   # mainnet sync takes a day or more
```

Until Zebra has synced, the mainnet runner can sync from a public server over Tor. Set this in `.env`, and remove it once the node is at the tip:

```sh
MAIN_LIGHTWALLETD=https://zec.rocks:443
MAIN_DIRECT=
```

Then start the rest:

```sh
docker compose up -d
docker compose exec tor cat /var/lib/tor/cadence/hostname    # the onion address
curl -s https://$PUBLIC_HOST/api/status
curl -s https://$SANDBOX_HOST/api/status                      # "sandbox": true
```

## Operating

- **Logs:** `docker compose logs -f runner-main runner-sandbox`. The runner logs subscription ids, heights and txids, never keys.
- **Upgrades:** back up `/mnt/cadence/runner-main` and `/mnt/cadence/runner-sandbox`, then rebuild with `docker compose build runner-main runner-sandbox && docker compose up -d`. State lives in `/mnt/cadence`. To roll back, restore the backup: an older build cannot add offers or subscriptions to a database this build has migrated (above).
- **Zebra 7.0** is required through NU7 (mainnet height 3,543,405). Earlier releases stop at their end-of-support height.
- **Rate limits:** `docker-compose.yml` does not set `CADENCE_TRUST_FORWARDED`, so behind Caddy every client counts as Caddy's address and shares one set of buckets. Set it only once you have checked that Caddy replaces a client's own `X-Forwarded-For` (`docs/api.md`, "Limits").
