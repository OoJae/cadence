#!/bin/sh
# Railway entrypoint. State (wallet, records, age identity, Tor) lives on the
# service's volume at $CADENCE_DATA. No telemetry: the only egress is Tor (to
# lightwalletd and drand) and webhook POSTs, if configured.
set -eu

DATA="${CADENCE_DATA:-/data}"
NET="${CADENCE_NETWORK:?set CADENCE_NETWORK to main or test}"
case "$NET" in
  main) DEFAULT_LWD="https://zec.rocks:443" ;;
  test) DEFAULT_LWD="https://testnet.zec.rocks:443" ;;
  *) echo "CADENCE_NETWORK must be main or test" >&2; exit 1 ;;
esac
: "${CADENCE_MERCHANT_TOKEN:?set CADENCE_MERCHANT_TOKEN}"
: "${RAILWAY_PUBLIC_DOMAIN:?generate a public domain for this service}"

mkdir -p "$DATA"
chown -R 10001:10001 "$DATA"
as_runner() { setpriv --reuid=10001 --regid=10001 --init-groups "$@"; }
PATHS="--network $NET --wallet-db $DATA/wallet.sqlite --state-db $DATA/state.sqlite --identity $DATA/identity.txt"

if [ ! -f "$DATA/identity.txt" ]; then
  # shellcheck disable=SC2086
  as_runner cadence-runner init $PATHS
fi

# shellcheck disable=SC2086
set -- serve $PATHS \
  --server "${CADENCE_LIGHTWALLETD:-$DEFAULT_LWD}" \
  --broadcast-server "${CADENCE_BROADCAST_LIGHTWALLETD:-${CADENCE_LIGHTWALLETD:-$DEFAULT_LWD}}" \
  --tor-dir "$DATA/tor" \
  --listen "0.0.0.0:${PORT:-8737}" \
  --public-url "https://$RAILWAY_PUBLIC_DOMAIN" \
  --web-dir /srv/web

if [ -n "${CADENCE_WEBHOOK_URL:-}" ]; then
  set -- "$@" --webhook-url "$CADENCE_WEBHOOK_URL"
fi

# A web app hosted elsewhere: share links point there, and its origin (and any
# in CADENCE_CORS_ORIGINS, comma-separated) may call the API.
if [ -n "${CADENCE_APP_URL:-}" ]; then
  set -- "$@" --app-url "$CADENCE_APP_URL"
fi
if [ -n "${CADENCE_CORS_ORIGINS:-}" ]; then
  set -- "$@" --cors-origin "$CADENCE_CORS_ORIGINS"
fi

# Testnet sandbox only: the faucet wallet, from a secret variable.
if [ -n "${SANDBOX_FUNDER_SEED:-}" ]; then
  [ "$NET" = test ] || { echo "the sandbox funder is testnet only" >&2; exit 1; }
  umask 077
  printf '{"network":"test","seed_hex":"%s"}\n' "$SANDBOX_FUNDER_SEED" > "$DATA/sandbox-funder.json"
  chown 10001:10001 "$DATA/sandbox-funder.json"
  set -- "$@" --sandbox-funder "$DATA/sandbox-funder.json" \
    --sandbox-funder-birthday "${SANDBOX_FUNDER_BIRTHDAY:?set SANDBOX_FUNDER_BIRTHDAY}"
fi

exec setpriv --reuid=10001 --regid=10001 --init-groups cadence-runner "$@"
