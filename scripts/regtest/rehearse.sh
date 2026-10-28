#!/usr/bin/env bash
# The NU7 rehearsal on a local regtest chain: a payer signs a 3-installment mandate
# while NU7 is still pending, with every rung of installment 3 signed for NU7's
# branch, then the chain mines through activation and the runner releases each one.
#
#   scripts/regtest/rehearse.sh
#
# Needs Docker (zfnd/zebra:7.0.0, run with zebrad.toml beside this script), curl and
# jq. Zebra serves the light-client gRPC itself. The runner fetches drand quicknet
# beacons directly over the internet. Everything lands in $WORK: the logs, the
# pocket and subscription files, and one decode per transaction.
#
# Timing. The funding block is mined alone, and nothing else is mined until the
# subscription is active, so the payer signs at tip FUND_AT exactly. Cadence predicts
# 75 s blocks until NU7 and 25 s after, so installment 3, due FIRST_IN + 2 * PERIOD
# seconds later, gets a window that starts past height 200: all its rungs carry
# NU7's branch ID, signed 7 blocks before activation. Installment 1 is released once
# the funding is anchor-deep, 3 blocks later, before NU7. The clock below then mines
# at those block times, and at once when the mempool holds a transaction.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/cadence-regtest}"
RPC_PORT="${RPC_PORT:-18232}"
LWD_PORT="${LWD_PORT:-9067}"
RUNNER_PORT="${RUNNER_PORT:-8790}"
FUND_AT="${FUND_AT:-193}"
FIRST_IN="${FIRST_IN:-60}"
PERIOD="${PERIOD:-720}"
AMOUNT="${AMOUNT:-100000}"
# zebrad.toml and cadence_chain::params::REGTEST_NU7.
NU7=200
CONTAINER=cadence-regtest
TOKEN=regtest-merchant-token-not-a-secret

BIN="$ROOT/target/debug"
LWD="http://127.0.0.1:$LWD_PORT"
RUNNER="http://127.0.0.1:$RUNNER_PORT"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$WORK/rehearsal.log"; }
die() { log "FAILED: $*"; exit 1; }

rpc() {
  curl -sf -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" \
    "http://127.0.0.1:$RPC_PORT/" | jq -c '.result'
}
tip() { rpc getblockcount; }
mine() { rpc generate "[$1]" >/dev/null; }
mined_height() { rpc getrawtransaction "[\"$1\", 1]" | jq -r '.height // 0 | if . < 0 then 0 else . end'; }

# wait_for FILE PATTERN [SECONDS]
wait_for() {
  local i=0
  until grep -q -- "$2" "$1" 2>/dev/null; do
    sleep 1
    i=$((i + 1))
    [ "$i" -lt "${3:-300}" ] || die "no '$2' in $1 after ${3:-300} s"
  done
}

cleanup() {
  [ -n "${SUBSCRIBE_PID:-}" ] && kill "$SUBSCRIBE_PID" 2>/dev/null || true
  [ -n "${RUNNER_PID:-}" ] && kill "$RUNNER_PID" 2>/dev/null || true
  [ -n "${KEEP:-}" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/runner"
log "work directory $WORK"

(cd "$ROOT" && cargo build -q -p cadence-cli -p cadence-runner -p cadence-decode)
log "built $(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo '+changes')"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:$RPC_PORT:18232" -p "127.0.0.1:$LWD_PORT:9067" \
  -v "$ROOT/scripts/regtest/zebrad.toml:/etc/zebrad.toml:ro" -e CONFIG_FILE_PATH=/etc/zebrad.toml \
  zfnd/zebra:7.0.0 zebrad start >/dev/null
for _ in $(seq 60); do mine 1 2>/dev/null && break; sleep 1; done
[ "$(tip)" -ge 1 ] || die "zebrad did not mine"
log "zebrad $(docker exec "$CONTAINER" zebrad --version | awk '{print $2}') on regtest; NU7 $(rpc getblockchaininfo | jq -c '.upgrades["77190ad9"]')"

# The sandbox funder receives 4 coinbase notes; the merchant only receives installments.
pocket() { "$BIN/cadence" pocket new --network regtest --out "$WORK/$1.json" > "$WORK/$1.txt"; }
pocket funder
pocket merchant
FUNDER_UA=$(awk '/^funding address:/ {print $3}' "$WORK/funder.txt")
MERCHANT_UA=$(awk '/^funding address:/ {print $3}' "$WORK/merchant.txt")
MERCHANT_UFVK=$(awk '/^pocket ufvk:/ {print $3}' "$WORK/merchant.txt")
mine $((9 - $(tip)))
rpc generatetoaddress "[4, \"$FUNDER_UA\"]" >/dev/null
log "coinbase at heights 10-13 paid the funder $FUNDER_UA"
mine $((FUND_AT - 1 - $(tip)))
log "tip $(tip)"

"$BIN/cadence-runner" init --network regtest \
  --wallet-db "$WORK/runner/wallet.sqlite" --state-db "$WORK/runner/state.sqlite" \
  --identity "$WORK/runner/identity.txt" >> "$WORK/runner.log"
"$BIN/cadence-runner" serve --network regtest \
  --wallet-db "$WORK/runner/wallet.sqlite" --state-db "$WORK/runner/state.sqlite" \
  --identity "$WORK/runner/identity.txt" --tor-dir "$WORK/runner/tor" \
  --server "$LWD" --direct --drand-direct --tick 5 \
  --listen "127.0.0.1:$RUNNER_PORT" --public-url "$RUNNER" --merchant-token "$TOKEN" \
  --sandbox-funder "$WORK/funder.json" --sandbox-funder-birthday 9 >> "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
wait_for "$WORK/runner.log" "runner listening" 120
for _ in $(seq 120); do
  [ "$(curl -sf "$RUNNER/api/status" | jq '.faucet.balance_zat // 0')" -gt 0 ] && break
  sleep 1
done
log "runner $(curl -sf "$RUNNER/api/status" | jq -c '{network, tip, faucet}')"

OFFER=$(curl -sf -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"NU7 rehearsal\",\"amount_zat\":$AMOUNT,\"period_secs\":$PERIOD,\"count\":3,\"merchant_ua\":\"$MERCHANT_UA\"}" \
  "$RUNNER/api/offers" | jq -r .offer_id)
log "offer $OFFER: 3 x $AMOUNT zats, every $PERIOD s, to merchant $MERCHANT_UA"

"$BIN/cadence" subscribe --runner "$RUNNER" --offer "$OFFER" --out "$WORK/subscription.json" \
  --first-in "$FIRST_IN" --sandbox-fund --direct > "$WORK/subscribe.log" 2>&1 &
SUBSCRIBE_PID=$!
wait_for "$WORK/subscribe.log" "sandbox wallet funded the pocket in" 120
FUNDING=$(sed -n 's/.*funded the pocket in \([0-9a-f]*\).*/\1/p' "$WORK/subscribe.log")
until rpc getrawmempool | jq -e --arg t "$FUNDING" 'index($t)' >/dev/null; do sleep 1; done
sleep 2
until [ "$(mined_height "$FUNDING")" -gt 0 ]; do mine 1; done
log "funding $FUNDING mined at $(mined_height "$FUNDING"); tip $(tip)"

wait_for "$WORK/subscribe.log" "active" 900
SUB=$(jq -r .subscription_id "$WORK/subscription.json")
log "subscription $SUB signed and uploaded at tip $(tip); NU7 $(rpc getblockchaininfo | jq -c '.upgrades["77190ad9"]')"
grep -e "rungs for heights" -e "sealed to drand" "$WORK/subscribe.log" | while read -r line; do log "  payer: $line"; done

# The chain clock: 75 s blocks before NU7, 25 s from it, and a block as soon as the
# mempool holds a transaction (after a moment, so Zebra's template includes it).
last=$(date +%s)
deadline=$(( last + FIRST_IN + 2 * PERIOD + 900 ))
seen=""
while :; do
  sub=$(curl -sf "$RUNNER/api/subscriptions/$SUB" || echo '{}')
  states=$(jq -c '[.installments[]? | {k, state, target_height, mined_height}]' <<<"$sub")
  if [ "$states" != "$seen" ]; then
    log "installments $states"
    seen=$states
  fi
  status=$(jq -r '.status // ""' <<<"$sub")
  case "$status" in completed | stalled | cancelled | stopped) break ;; esac
  [ "$(date +%s)" -lt "$deadline" ] || die "the subscription is still $status"

  h=$(tip)
  gap=75
  [ $((h + 1)) -ge "$NU7" ] && gap=25
  pending=$(rpc getrawmempool | jq -r 'join(",")')
  if [ -n "$pending" ]; then
    sleep 2
  elif [ $(( $(date +%s) - last )) -lt "$gap" ]; then
    sleep 1
    continue
  fi
  mine 1
  last=$(date +%s)
  block=$(rpc getblock "[\"$((h + 1))\", 1]")
  log "mined $((h + 1)) ($(rpc getblockchaininfo | jq -r '.consensus.chaintip')) with $(jq '.tx | length' <<<"$block") tx${pending:+; mempool had $pending}"
done
log "subscription $status"
cp "$WORK/subscription.json" "$WORK/subscription-file.json"
curl -sf "$RUNNER/api/subscriptions/$SUB" | jq . > "$WORK/subscription-final.json"

decode() {
  "$BIN/cadence-decode" decode --network regtest --server "$LWD" --direct "$1" --view "$MERCHANT_UFVK" > "$WORK/decode-$2.json"
  log "$2: $(jq -c '{txid, mined_height, branch_id, version, expiry_height, ironwood_actions, received: [.received[]? | {value_zat, memo}]}' "$WORK/decode-$2.json")"
}
decode "$FUNDING" funding
for k in 1 2 3; do
  txid=$(jq -r ".installments[] | select(.k == $k) | .txid // empty" "$WORK/subscription-final.json")
  [ -n "$txid" ] && decode "$txid" "installment-$k"
done
log "done; logs in $WORK"
