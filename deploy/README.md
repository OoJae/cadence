# Deploying Cadence

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
- **Upgrades:** rebuild with `docker compose build runner-main runner-sandbox && docker compose up -d`. State lives in `/mnt/cadence`.
- **Zebra 7.0** is required through NU7 (mainnet height 3,543,405). Earlier releases stop at their end-of-support height.
