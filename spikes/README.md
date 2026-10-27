# Spikes

`wasm-signer/` is the Oct 22 feasibility spike that showed the rung signer could run in WebAssembly before the build committed to it. `vendor/cadence-core` there is a frozen early copy of the crate, not shipped code, and is out of date. The signer that ships is `crates/cadence-wasm`, built by `web/scripts/build-wasm.sh`.
