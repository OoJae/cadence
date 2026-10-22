// Module worker: runs the wasm signer (and optionally the prover) off the main thread.
self.onmessage = async ({ data }) => {
  const pkg = data.prove ? '../pkg-web/cadence_wasm_signer.js' : '../pkg-web-signer/cadence_wasm_signer.js';
  const t0 = performance.now();
  const w = await import(pkg);
  await w.default();
  const out = { init_ms: performance.now() - t0, crossOriginIsolated: self.crossOriginIsolated };
  w.bench_rungs(1); // warm-up
  out.ms_per_rung = w.bench_rungs(data.n);
  out.report = JSON.parse(w.bench_rungs_report(data.n));
  if (data.prove) out.prove = JSON.parse(w.bench_prove());
  out.wasm_memory_mb = w.wasm_memory_bytes() / 1048576;
  self.postMessage(out);
};
