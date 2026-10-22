// Runs the wasm signer bench under Node. Usage: node run-node.mjs [n] [--prove]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const w = require('./pkg-node/cadence_wasm_signer.js');

const n = Number(process.argv[2] ?? 20);
const prove = process.argv.includes('--prove');

let t = performance.now();
w.bench_rungs(1); // warm-up (one-time generator/table setup)
console.log(`warmup (1 rung incl. first-call setup): ${(performance.now() - t).toFixed(1)} ms`);

t = performance.now();
const perRung = w.bench_rungs(n);
console.log(`bench_rungs(${n}) = ${perRung.toFixed(2)} ms/rung (wall ${(performance.now() - t).toFixed(0)} ms)`);

console.log('report:', w.bench_rungs_report(n));

if (prove) {
  if (!w.bench_prove) { console.log('built without --features prove'); process.exit(0); }
  t = performance.now();
  console.log('prove:', w.bench_prove(), `(wall ${(performance.now() - t).toFixed(0)} ms)`);
}
