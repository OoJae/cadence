// Smoke test of the real in-browser signer (VITE_SIGNER=wasm), in headless Chromium.
//
//   pnpm build:wasm && pnpm verify:wasm [--no-cancel] [--count N] [--pool N]
//
// 1. Builds scripts/wasm-smoke/ (a harness page over src/signer/) with the app's own
//    vite.config.ts, VITE_SIGNER=wasm and VITE_API=self, so it ships the production
//    meta CSP, and serves it with the production response headers (README), CSP
//    included, so the workers run under the same policy.
// 2. Plays the runner for docs/api.md's payer endpoints. A native helper
//    (crates/cadence-wasm/examples/smoke_fixture.rs) mints the funding transaction,
//    opens what the browser sealed, and parses the cancel the browser proved.
// 3. Engine run: one installment over 20 heights from a synthetic funding note,
//    sealed to a past drand round; the helper opens it with that round's public
//    beacon and verifies every rung's signatures.
// 4. Signer run: WasmSigner end to end. createPocket (POST /api/pockets),
//    awaitFunding (GET /api/pockets/:id, decrypting the relayed tx), presign over
//    every installment's real window (~330 rungs for 2 installments), upload
//    (POST /api/subscriptions), save the cancel key (age scrypt, in a worker),
//    destroy the signer, restore a fresh one from the key, then cancel with it:
//    build, witness, prove in the browser, POST /api/broadcast. The key is also
//    opened with the cadence CLI, if target/release/cadence is built.
//
// Fails on any request to another origin, CSP violation, console error, browser
// storage write, or a check below.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { parseApiSetting } from '../src/config/apiSetting.ts';
import { buildCsp } from '../src/config/csp.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const args = process.argv.slice(2);
const withCancel = !args.includes('--no-cancel');
const opt = (name) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : NaN);
const count = opt('--count') || 2;
const poolSize = opt('--pool') || null;
const PORT = 4174;
const ORIGIN = `http://localhost:${PORT}`;
const NETWORK = 'test';
const TIP = 4_600_000;
const BUCKETS = Array.from({ length: 10 }, (_, i) => (64 * 1024) << i);
const QUICKNET = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

// ------------------------------------------------------------ prerequisites
for (const f of ['signer/cadence_wasm.js', 'signer/cadence_wasm_bg.wasm', 'prover/cadence_wasm.js', 'prover/cadence_wasm_bg.wasm']) {
  if (!existsSync(join(web, 'src/wasm', f))) {
    console.error(`missing src/wasm/${f}: run pnpm build:wasm first`);
    process.exit(1);
  }
}
console.log('building the native fixture helper…');
execFileSync('cargo', ['build', '--release', '-q', '-p', 'cadence-wasm', '--features', 'prover', '--example', 'smoke_fixture'], { cwd: repo, stdio: 'inherit' });
const helperBin = join(process.env.CARGO_TARGET_DIR ?? join(repo, 'target'), 'release/examples/smoke_fixture');
const tmp = mkdtempSync(join(tmpdir(), 'cadence-wasm-smoke-'));
function helper(...a) {
  const r = spawnSync(helperBin, a, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`smoke_fixture ${a[0]}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}
const runnerKey = helper('age-identity');

console.log('building the harness (VITE_SIGNER=wasm, VITE_API=self)…');
process.env.VITE_SIGNER = 'wasm';
process.env.VITE_API = 'self';
const outDir = join(tmp, 'dist');
await build({
  configFile: join(web, 'vite.config.ts'),
  root: join(web, 'scripts/wasm-smoke'),
  mode: 'production',
  logLevel: 'warn',
  build: { outDir, emptyOutDir: true },
});

// ------------------------------------------------------------ fake runner + static server
const HEADERS = {
  'Content-Security-Policy': `${buildCsp(parseApiSetting('self'), 'build', 'wasm')}; frame-ancestors 'none'`,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml' };
const pockets = new Map();
const subscriptions = [];
const broadcasts = [];
let nextPocket = 1;

function sealedInfo(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const m = /-> tlock (\d+) ([0-9a-f]{64})/.exec(bytes.subarray(0, 300).toString('latin1'));
  return { bytes: bytes.length, round: m ? Number(m[1]) : null, chain: m?.[2] ?? null };
}

async function api(req, body) {
  const url = new URL(req.url, ORIGIN);
  const seg = url.pathname.split('/').filter(Boolean);
  const json = body ? JSON.parse(body) : undefined;
  if (req.method === 'POST' && url.pathname === '/api/pockets') {
    const id = `pkt_smoke${nextPocket++}`;
    const p = { id, ufvk: json.pocket_ufvk, funding: null, notes: [], spent: false };
    pockets.set(id, p);
    // "Mine" the funding payment a moment later, as a wallet would.
    setTimeout(() => {
      try {
        const f = helper('fund', NETWORK, p.ufvk, String(p.expected ?? 0), String(TIP - 5));
        p.funding = { txid: f.txid, tx_hex: f.tx_hex, mined_height: TIP - 5, value_zat: f.value_zat };
        p.notes = [{ nullifier: f.nullifier, value_zat: f.value_zat, mined_height: TIP - 5, position: f.witness.position }];
        p.witness = f.witness;
      } catch (e) {
        problems.push(`funding failed: ${e.message}`);
      }
    }, 300);
    p.expected = fundAmount;
    return [201, { pocket_id: id, birthday_height: TIP - 10, tip: TIP }];
  }
  if (seg[0] === 'api' && seg[1] === 'pockets' && seg[2]) {
    const p = pockets.get(seg[2]);
    if (!p) return [404, { error: 'unknown pocket' }];
    if (req.method === 'GET' && !seg[3]) return [200, { pocket_id: p.id, tip: TIP, funding: p.funding, notes: p.spent ? [] : p.notes }];
    if (req.method === 'GET' && seg[3] === 'witness') {
      const nf = url.searchParams.get('nullifier');
      if (!p.witness || p.notes[0]?.nullifier !== nf) return [404, { error: 'no such note' }];
      return [200, { target_height: TIP + 1, anchor_height: TIP - 2, ...p.witness }];
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/subscriptions') {
    subscriptions.push(json);
    return [201, { subscription_id: `sub_smoke${subscriptions.length}`, status: 'active' }];
  }
  if (req.method === 'POST' && url.pathname === '/api/broadcast') {
    const file = join(tmp, `tx-${broadcasts.length}.hex`);
    writeFileSync(file, json.tx_hex);
    const shape = helper('inspect', NETWORK, String(TIP + 1), file);
    broadcasts.push(shape);
    for (const p of pockets.values()) p.spent = true;
    return [200, { txid: shape.txid }];
  }
  return [404, { error: `no route for ${req.method} ${url.pathname}` }];
}

let fundAmount = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    try {
      if (req.url.startsWith('/api/')) {
        const [status, value] = await api(req, body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
        return;
      }
      const path = normalize(decodeURIComponent(new URL(req.url, ORIGIN).pathname)).replace(/^(\.\.[/\\])+/, '');
      const file = join(outDir, path === '/' ? 'index.html' : path);
      if (!file.startsWith(outDir) || !existsSync(file) || path === '/favicon.ico') {
        res.writeHead(404, HEADERS);
        res.end();
        return;
      }
      res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});
await new Promise((r) => server.listen(PORT, 'localhost', r));

// ------------------------------------------------------------ browser
const browser = await chromium.launch();
async function run(query, timeoutMs) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.origin !== ORIGIN) problems.push(`off-origin request: ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    if (m.text().includes('Content Security Policy')) problems.push(`CSP: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('worker', (w) => w.on('console', (m) => m.type() === 'error' && problems.push(`worker console error: ${m.text()}`)));
  await page.goto(`${ORIGIN}/?${query}`);
  await page.waitForFunction(() => window.__smoke || window.__smokeError, null, { timeout: timeoutMs, polling: 250 });
  const result = await page.evaluate(() => ({ ok: window.__smoke, error: window.__smokeError, csp: window.__csp, log: document.getElementById('out').textContent }));
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
  if (storage.local || storage.session || storage.cookies) problems.push(`browser storage written: ${JSON.stringify(storage)}`);
  for (const v of result.csp) problems.push(`CSP violation: ${v}`);
  await ctx.close();
  if (result.error) throw new Error(`${query}: ${result.error}\n${result.log}`);
  return result.ok;
}

const summary = {};
try {
  // ---- engine: 1 installment, 20 heights, synthetic funding, sealed to a past round
  console.log('\n== engine: 1 installment × 20 heights, sealed, opened natively');
  const e = await run(`mode=engine&heights=20&recipient=${runnerKey.recipient}`, 120_000);
  check(e.rungs === 20, `20 rungs signed (${e.rungs}) across a pool of ${e.pool_size}`);
  check(BUCKETS.includes(e.sealed_bytes) && e.sealed_len_check === e.sealed_bytes, `sealed package is a bucket (${e.sealed_bytes} bytes)`);
  check(e.header?.round === 33_000_000 && e.header?.chain === QUICKNET, 'tlock header names quicknet round 33,000,000');
  check(e.spends_nullifier === e.funding_nullifier && e.change_is_null, 'spends the funding note and leaves no change (final installment)');
  check(e.done_events === 1 && e.progress_phases.includes('sign') && e.progress_phases.includes('seal'), `progress reported (${e.progress_phases.join(', ')})`);
  writeFileSync(join(tmp, 'sealed.b64'), e.sealed);
  const opened = helper('open', runnerKey.identity, join(tmp, 'sealed.b64'));
  check(opened.k === 1 && opened.rungs === 20 && opened.first_height === TIP + 1 && opened.last_height === TIP + 20, 'the runner opens it with the round beacon: k=1, 20 rungs, heights in order');
  check(opened.all_signed && opened.distinct_sighashes === 20, 'every rung carries valid spend authorizations over its own sighash');
  check(opened.spends_nullifier === e.funding_nullifier, 'the ladder names the spent note');
  summary.engine = { rungs: e.rungs, pool: e.pool_size, presign_ms: Math.round(e.presign_ms), per_rung_ms: +e.per_rung_ms.toFixed(1), sealed_bytes: e.sealed_bytes, plaintext_bytes: e.plaintext_bytes, worker_memory_mb: Math.round(e.worker_memory_mb) };

  // ---- signer: the real WasmSigner against the fake runner
  console.log(`\n== signer: WasmSigner end to end, ${count} installments over real windows${withCancel ? ', then cancel' : ''}`);
  fundAmount = count * (50_000 + 10_000);
  const s = await run(`mode=signer&count=${count}&recipient=${runnerKey.recipient}${withCancel ? '&cancel=1' : ''}${poolSize ? `&pool=${poolSize}` : ''}`, 600_000);
  check(s.funding.value_zat === fundAmount && s.funding.status === 'mined', `funding decrypted in the browser: ${s.funding.value_zat} zats`);
  check(s.installments.length === count && s.sealed.length === count, `${count} installments signed and sealed`);
  check(s.sealed.every((x, i) => x.k === i + 1 && BUCKETS.includes(x.bytes) && x.header?.round === x.release_round && x.header?.chain === QUICKNET), 'every package is a bucket, time-locked to its own quicknet round');
  check(s.sealed.every((x, i) => i === 0 || x.release_round > s.sealed[i - 1].release_round), 'release rounds increase');
  const sub = subscriptions.at(-1);
  check(sub?.pocket_id === s.pocket_id && sub?.installments?.length === count, 'POST /api/subscriptions carried the pocket id and every package');
  check(sub?.installments?.every((x) => { const i = sealedInfo(x.sealed); return BUCKETS.includes(i.bytes) && i.round === x.release_round; }), 'the uploaded packages match');
  if (withCancel) {
    const tx = broadcasts.at(-1);
    check(!!s.cancel && tx?.txid === s.cancel.txid, `cancel broadcast; the native parse agrees on its txid (${s.cancel?.txid})`);
    check(tx?.ironwood_actions === 2 && tx?.ironwood_value_balance === 10_000 && !tx.transparent && !tx.sapling && !tx.orchard, 'cancel is a 2-action Ironwood-only transaction paying the 10,000-zat fee');
    check(s.cancel?.refunded_zat === fundAmount - 10_000 && s.cancel?.target_height === TIP + 1, `refunds ${s.cancel?.refunded_zat} zats at height ${s.cancel?.target_height}`);
  }
  const k = s.kit;
  check(k.file_name === `cadence-cancel-key-${s.pocket_id}.age` && k.restored_ua === k.pocket_ua, `cancel key saved (${k.bytes} bytes, ${Math.round(k.seal_ms)} ms) and restored into a fresh signer (${Math.round(k.open_ms)} ms)`);
  check(/wrong passphrase/.test(k.wrong_passphrase), 'the key refuses a wrong passphrase');
  check(
    k.fields.kind === 'cadence-kit/1' && k.fields.subscription_id === s.subscription.subscription_id && k.fields.count === count && k.fields.funding_height === TIP - 5 && /^[0-9a-f]{32}$/.test(k.fields.mandate_id) && /^[0-9a-f]+$/.test(k.fields.funding_tx_hex),
    'the key carries the schedule, the mandate id and the funding transaction',
  );
  check(k.notes.length === count && k.notes[0].k === 0 && k.notes[0].nullifier === pockets.get(s.pocket_id)?.notes[0]?.nullifier, `the key carries the pocket's ${k.notes.length} notes, the funding note first`);
  const cli = join(process.env.CARGO_TARGET_DIR ?? join(repo, 'target'), 'release/cadence');
  if (existsSync(cli)) {
    const file = join(tmp, k.file_name);
    writeFileSync(file, Buffer.from(k.b64, 'base64'));
    const r = spawnSync(cli, ['pocket', 'show', '--pocket', file], { encoding: 'utf8', env: { ...process.env, CADENCE_KIT_PASSPHRASE: 'smoke test passphrase' } });
    const ua = /funding address: (\S+)/.exec(r.stdout ?? '')?.[1];
    check(r.status === 0 && ua === k.pocket_ua, `the cadence CLI opens the key: ${ua ? `${ua.slice(0, 20)}…` : r.stderr.trim()}`);
  } else {
    console.log(`skip the CLI check (no ${cli})`);
  }
  check(/destroyed/.test(s.after_destroy), 'destroy() leaves a signer that refuses to act');
  summary.signer = {
    pool: s.pool_size,
    rungs: s.rungs,
    presign_ms: Math.round(s.presign_ms),
    per_rung_ms: +s.per_rung_ms.toFixed(1),
    installments: s.installments.map((x) => `${x.k}: ${x.rungs} rungs ${x.window[0]}-${x.window[1]} → ${x.sealed_bytes} B`),
    kit: { bytes: k.bytes, seal_ms: Math.round(k.seal_ms), open_ms: Math.round(k.open_ms) },
    cancel_ms: s.cancel ? Math.round(s.cancel.ms) : null,
  };
} catch (e) {
  problems.push(e.message);
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + JSON.stringify(summary, null, 2));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nwasm smoke test passed');
