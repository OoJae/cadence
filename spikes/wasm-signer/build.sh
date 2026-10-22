#!/usr/bin/env bash
# Reproduces the wasm-signer spike. Run from anywhere.
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli 0.2.129,
#        Homebrew LLVM (CC/AR for secp256k1-sys; set in .cargo/config.toml [env]).
set -euo pipefail
cd "$(dirname "$0")"
export CC_wasm32_unknown_unknown=${CC_wasm32_unknown_unknown:-/opt/homebrew/opt/llvm/bin/clang}
export AR_wasm32_unknown_unknown=${AR_wasm32_unknown_unknown:-/opt/homebrew/opt/llvm/bin/llvm-ar}
WASM=target/wasm32-unknown-unknown/release/cadence_wasm_signer.wasm

# 1. Signer only (build + sign + redact + serialize).
cargo build --release --target wasm32-unknown-unknown --lib
wasm-bindgen --target nodejs --out-dir pkg-node-signer "$WASM"
wasm-bindgen --target web    --out-dir pkg-web-signer  "$WASM"

# 2. Signer + Ironwood prover bench.
cargo build --release --target wasm32-unknown-unknown --lib --features prove
wasm-bindgen --target nodejs --out-dir pkg-node "$WASM"
wasm-bindgen --target web    --out-dir pkg-web  "$WASM"

# 3. Native comparison (same code), single-threaded halo2.
cargo build --release --bin native --features prove

for f in pkg-node-signer/cadence_wasm_signer_bg.wasm pkg-node/cadence_wasm_signer_bg.wasm; do
  echo "$f raw=$(wc -c <"$f" | tr -d ' ') gzip9=$(gzip -9c "$f" | wc -c | tr -d ' ')"
done

echo "== wasm (node)";   node run-node.mjs 50 --prove
echo "== native";        ./target/release/native 50
echo "== parallel wasm"; node run-node-parallel.mjs 8 50
# Browser: python3 -m http.server 8765 --bind 127.0.0.1, then open
#   http://127.0.0.1:8765/web/index.html?n=50          (signer)
#   http://127.0.0.1:8765/web/index.html?n=5&prove     (signer + prover)
