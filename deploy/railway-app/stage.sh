#!/bin/sh
# Assembles the upload for the app host's `railway up`: a prebuilt web app and this
# directory's Dockerfile and Caddyfile. It builds nothing: build the app first with
# VITE_API=runners (see deploy/README.md). Nothing else can be uploaded.
#   deploy/railway-app/stage.sh /tmp/cadence-app-stage [web/dist] && railway up /tmp/cadence-app-stage --path-as-root ...
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:?usage: stage.sh <out-dir> [<dist-dir>]}"
DIST="${2:-$ROOT/web/dist}"
for f in index.html csp.txt build.json; do
  [ -s "$DIST/$f" ] || { echo "$DIST/$f is missing: build the web app first (see deploy/README.md)" >&2; exit 1; }
done
grep -q '"api": "runners"' "$DIST/build.json" || { echo "$DIST is not a VITE_API=runners build" >&2; exit 1; }
DIST="$(cd "$DIST" && pwd)"
OUT_ABS="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
case "$DIST/" in "$OUT_ABS"/*) echo "the out dir must not contain the dist (it is emptied first)" >&2; exit 1 ;; esac
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$DIST" "$OUT/dist"
cp "$ROOT/deploy/railway-app/Dockerfile" "$ROOT/deploy/railway-app/Caddyfile" "$OUT/"
du -sh "$OUT"
