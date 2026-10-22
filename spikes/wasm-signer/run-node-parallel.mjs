// Rung-signing throughput with K independent wasm instances (worker_threads),
// mirroring a browser pool of Web Workers. Usage: node run-node-parallel.mjs [K] [rungsPerWorker]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

if (isMainThread) {
  const K = Number(process.argv[2] ?? 4), per = Number(process.argv[3] ?? 50);
  const t0 = performance.now();
  const res = await Promise.all([...Array(K)].map(() => new Promise((ok, err) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { per } });
    w.once('message', ok); w.once('error', err);
  })));
  const wall = performance.now() - t0, total = K * per;
  console.log(`K=${K} workers x ${per} rungs: wall ${wall.toFixed(0)} ms (incl. instantiate), ` +
    `${(wall / total).toFixed(2)} ms/rung effective, per-worker ms/rung: ${res.map(r => r.toFixed(1)).join(', ')}`);
} else {
  const w = createRequire(import.meta.url)('./pkg-node-signer/cadence_wasm_signer.js');
  parentPort.postMessage(w.bench_rungs(workerData.per));
}
