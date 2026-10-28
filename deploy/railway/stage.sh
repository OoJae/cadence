#!/bin/sh
# Assembles the upload for `railway up`: the Rust workspace, the built web app and
# this directory's Dockerfile, entrypoint and railway.json (restart always). Nothing
# else (no target/, no .cadence/, no pockets/) can be uploaded.
#   deploy/railway/stage.sh /tmp/cadence-stage && railway up /tmp/cadence-stage --path-as-root ...
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: stage.sh <out-dir>}"
[ -f "$ROOT/web/dist/index.html" ] || { echo "build the web app first (see deploy/README.md)" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT/web"
cp "$ROOT/Cargo.toml" "$ROOT/Cargo.lock" "$OUT/"
rsync -a --exclude target "$ROOT/crates" "$OUT/"
cp -R "$ROOT/web/dist" "$OUT/web/dist"
cp "$ROOT/deploy/railway/Dockerfile" "$ROOT/deploy/railway/entrypoint.sh" "$ROOT/deploy/railway/railway.json" "$OUT/"
du -sh "$OUT"
