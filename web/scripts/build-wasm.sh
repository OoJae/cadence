#!/usr/bin/env bash
# Builds the in-browser signer (crates/cadence-wasm) into web/src/wasm/, which a
# VITE_SIGNER=wasm build serves from this origin at /wasm/ (vite.config.ts):
#
#   src/wasm/signer/     cadence_wasm.js + cadence_wasm_bg.wasm   presign, seal, cancel (signing only)
#   src/wasm/prover/     cadence_wasm.js + cadence_wasm_bg.wasm   the same plus the Ironwood prover,
#                                                                 loaded only by the cancel's prover worker
#
# Needs: rustup (it installs the toolchain and wasm32 target rust-toolchain.toml pins),
# wasm-bindgen-cli 0.2.129 (it must match the wasm-bindgen crate exactly), and Homebrew
# LLVM (secp256k1-sys compiles C for wasm32; Apple clang has no wasm32 backend).
# wasm-opt (binaryen) is used if present.
#
#   pnpm build:wasm                 # both modules
#   pnpm build:wasm signer          # just one
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
web="$(dirname "$here")"
repo="$(dirname "$web")"
crate="$repo/crates/cadence-wasm"
out="$web/src/wasm"
target_dir="${CARGO_TARGET_DIR:-$repo/target}"
wasm="$target_dir/wasm32-unknown-unknown/release/cadence_wasm.wasm"
bindgen_version="0.2.129"

export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-/opt/homebrew/opt/llvm/bin/clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-/opt/homebrew/opt/llvm/bin/llvm-ar}"
# The workspace has no release profile of its own; the signer wants speed (it signs
# hundreds of rungs), so optimise fully and link once.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=3
export CARGO_PROFILE_RELEASE_LTO=true
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1

# Reproducible bytes: rustc embeds source paths (panic locations, file!()), so map
# every absolute path of this machine it could see to a fixed one. The same commit
# then builds the same modules in any checkout (web/README.md, "Build identity").
# Later prefixes win, so the target directory maps the same inside or outside the repo.
toml_str() {
  local s="${1//\\/\\\\}"
  printf '"%s"' "${s//\"/\\\"}"
}
remap=""
for map in "$repo=/cadence" "${CARGO_HOME:-$HOME/.cargo}=/cargo" "$(cd "$crate" && rustc --print sysroot)=/rust" "$target_dir=/target"; do
  remap="$remap${remap:+, }$(toml_str "--remap-path-prefix=$map")"
done
# Merged with the crate's own target rustflags (.cargo/config.toml), not replacing them.
remap_config="target.wasm32-unknown-unknown.rustflags=[$remap]"

if ! command -v wasm-bindgen >/dev/null; then
  echo "wasm-bindgen not found: cargo install wasm-bindgen-cli --version $bindgen_version" >&2
  exit 1
fi
if ! wasm-bindgen --version | grep -q " $bindgen_version"; then
  echo "wasm-bindgen $(wasm-bindgen --version) does not match the crate's =$bindgen_version" >&2
  exit 1
fi
if [ ! -x "$CC_wasm32_unknown_unknown" ]; then
  echo "no wasm32-capable clang at $CC_wasm32_unknown_unknown (brew install llvm, or set CC_wasm32_unknown_unknown)" >&2
  exit 1
fi

build() {
  local name="$1"
  shift
  echo "== cadence-wasm ($name)"
  # Run from the crate so its .cargo/config.toml (getrandom backend cfg) applies.
  (cd "$crate" && cargo build --release --target wasm32-unknown-unknown --lib --config "$remap_config" "$@")
  rm -rf "$out/$name"
  wasm-bindgen --target web --no-typescript --out-dir "$out/$name" --out-name cadence_wasm "$wasm"
  local bg="$out/$name/cadence_wasm_bg.wasm"
  if command -v wasm-opt >/dev/null; then
    if wasm-opt -O3 "$bg" -o "$bg.opt"; then
      mv "$bg.opt" "$bg"
    else
      echo "wasm-opt failed; keeping the unoptimised module" >&2
      rm -f "$bg.opt"
    fi
  else
    echo "(wasm-opt not found; skipping it)"
  fi
  printf '%s: wasm %s bytes (gzip -9 %s), js %s bytes\n' "$name" \
    "$(wc -c <"$bg" | tr -d ' ')" "$(gzip -9c "$bg" | wc -c | tr -d ' ')" \
    "$(wc -c <"$out/$name/cadence_wasm.js" | tr -d ' ')"
}

which="${1:-all}"
case "$which" in
  all) build signer && build prover --features prover ;;
  signer) build signer ;;
  prover) build prover --features prover ;;
  *) echo "usage: $0 [all|signer|prover]" >&2; exit 2 ;;
esac
