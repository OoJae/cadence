// Smoke test of an app host of its own (VITE_API=runners), in headless Chromium.
//
//   pnpm build:wasm && pnpm verify:app-host
//
// 1. Builds the app with VITE_SIGNER=wasm, VITE_API=runners and two local runners in
//    VITE_RUNNERS, into a temporary directory.
// 2. Serves it on one origin with exactly the headers deploy/railway-app/Caddyfile
//    declares (its CSP read from the build's csp.txt, as Caddy does), and plays two
//    runners on two other origins, with CORS for the app origin only and the real
//    runner's Cross-Origin-Resource-Policy. A third origin plays a runner the build
//    does not know.
// 3. Checks the response headers, cross-origin isolation, the footer, that /subscribe
//    talks to the runner the offer names (offer check, POST /api/pockets from the WASM
//    signer's worker) and only to it, that an offer naming an unknown runner is
//    refused without a request, and that the CSP blocks a fetch to that runner.
//
// Fails on any request to an origin other than the app and its two runners, any CSP
// violation other than the deliberate one, console error, browser storage write, or a
// check below.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const APP_PORT = 4175;
const APP = `http://localhost:${APP_PORT}`;
const A = 'http://localhost:4176'; // the default runner
const B = 'http://localhost:4177';
const C = 'http://localhost:4178'; // a runner this build does not know
const TIP = 4_600_000;
const QUICKNET = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
async function until(cond, ms) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  return cond();
}

for (const f of ['signer/cadence_wasm.js', 'signer/cadence_wasm_bg.wasm', 'prover/cadence_wasm.js', 'prover/cadence_wasm_bg.wasm']) {
  if (!existsSync(join(web, 'src/wasm', f))) {
    console.error(`missing src/wasm/${f}: run pnpm build:wasm first`);
    process.exit(1);
  }
}

// ------------------------------------------------------------ build
console.log(`building the app (VITE_SIGNER=wasm, VITE_API=runners, VITE_RUNNERS=${A},${B})…`);
Object.assign(process.env, { VITE_SIGNER: 'wasm', VITE_API: 'runners', VITE_RUNNERS: `${A},${B}`, VITE_DEFAULT_RUNNER: A });
const tmp = mkdtempSync(join(tmpdir(), 'cadence-app-host-'));
const dist = join(tmp, 'dist');
await build({ configFile: join(web, 'vite.config.ts'), root: web, mode: 'production', logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } });
const info = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
const cspHeader = readFileSync(join(dist, 'csp.txt'), 'utf8');

// ------------------------------------------------------------ the static host, as the Caddyfile declares it
const caddyfile = readFileSync(join(repo, 'deploy/railway-app/Caddyfile'), 'utf8');
const HEADERS = {};
for (const line of /\theader \{\n([\s\S]*?)\n\t\}/.exec(caddyfile)[1].split('\n')) {
  const l = line.trim();
  if (!l || l.startsWith('#') || l.startsWith('-')) continue;
  const [, name, value] = /^(\S+)\s+(.*)$/.exec(l);
  HEADERS[name] = value.replace(/^"(.*)"$/, '$1').replace('{file./srv/web/csp.txt}', cspHeader);
}
check(HEADERS['Content-Security-Policy'] === cspHeader, 'the Caddyfile sends the build’s csp.txt as the CSP header');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const app = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, APP).pathname);
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html'); // try_files {path} /index.html
  res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

// ------------------------------------------------------------ the runners
const fake = (prefix, n) => prefix + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(8).slice(0, n);
const offerOn = (endpoint, id) => ({
  offer_id: id,
  name: 'App host smoke',
  amount_zat: 100_000,
  period_secs: 600,
  count: 2,
  merchant_ua: fake('utest1', 104),
  runner_age_recipient: fake('age1', 58),
  runner_endpoint: endpoint,
  network: 'test',
  drand_chain: QUICKNET,
});
const fragment = (offer) => `#offer=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`;
const hits = { [A]: [], [B]: [], [C]: [] };

function runner(origin) {
  const offer = offerOn(origin, `off_smoke${origin.slice(-1)}`);
  return createServer((req, res) => {
    const url = new URL(req.url, origin);
    hits[origin].push(`${req.method} ${url.pathname}`);
    // CORS for exactly the app origin, and the real runner's CORP on every response.
    const headers = { 'Cross-Origin-Resource-Policy': 'same-origin', Vary: 'Origin' };
    if (req.headers.origin === APP) headers['Access-Control-Allow-Origin'] = APP;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const json = (status, body) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && url.pathname === '/api/status') return json(200, { network: 'test', tip: TIP, drand_round: 1, subscriptions: 0, sandbox: false });
      if (req.method === 'GET' && url.pathname === `/api/offers/${offer.offer_id}`) return json(200, offer);
      if (req.method === 'POST' && url.pathname === '/api/pockets') return json(201, { pocket_id: 'pkt_smoke1', birthday_height: TIP, tip: TIP });
      if (req.method === 'GET' && url.pathname === '/api/pockets/pkt_smoke1') return json(200, { pocket_id: 'pkt_smoke1', tip: TIP, birthday_height: TIP, funding: null, notes: [] });
      json(404, { error: 'not found' });
    });
  });
}

const servers = [app.listen(APP_PORT), runner(A).listen(4176), runner(B).listen(4177), runner(C).listen(4178)];
await Promise.all(servers.map((s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)))));

// ------------------------------------------------------------ the browser
const browser = await chromium.launch();
const allowed = new Set([APP, A, B]);
let deliberate = false;
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    // The deliberate fetch below is reported, then blocked (C's own log shows it never arrives).
    if (deliberate && u.origin === C) return;
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && !allowed.has(u.origin)) problems.push(`request to another origin: ${r.url()}`);
  });
  page.on('console', (m) => m.type() === 'error' && !(deliberate && m.text().includes(C)) && problems.push(`console error on ${page.url()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

  // Headers, isolation, footer.
  const res = await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
  const h = res.headers();
  check(h['content-security-policy'] === cspHeader, 'the page is served with the build’s CSP header');
  check(h['content-security-policy'].includes(`connect-src 'self' ${A} ${B};`) && !h['content-security-policy'].includes('*'), `connect-src is exactly 'self' ${A} ${B}`);
  check(h['content-security-policy'].endsWith("frame-ancestors 'none'"), "the header adds frame-ancestors 'none'");
  check(h['cross-origin-opener-policy'] === 'same-origin' && h['cross-origin-embedder-policy'] === 'require-corp' && h['cross-origin-resource-policy'] === 'same-origin', 'COOP same-origin, COEP require-corp, CORP same-origin');
  check(h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer' && h['permissions-policy'] === 'camera=(), microphone=(), geolocation=(), browsing-topics=()', 'nosniff, no-referrer, Permissions-Policy');
  check(await page.evaluate(() => crossOriginIsolated), 'the page is cross-origin isolated');
  const meta = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'));
  check(`${meta}; frame-ancestors 'none'` === cspHeader, 'the meta CSP is the header minus frame-ancestors');
  const footer = await page.locator('.site-footer').innerText();
  check(footer.includes(`Talks to: ${A}, ${B}`), `the footer's "Talks to" lists exactly ${A}, ${B}`);
  await page.getByText('Built from commit').waitFor();
  const buildLine = await page.getByText('Built from commit').innerText();
  check(buildLine.includes(info.commit ?? 'unknown') && buildLine.includes(info.bundle_sha256.slice(0, 12)), `the footer shows commit ${info.commit} and bundle sha256 ${info.bundle_sha256.slice(0, 12)}…`);
  check(!/reproducib/i.test(footer), 'the footer does not claim a reproducible build');

  // /subscribe with an offer from the second runner: it talks to that runner, not the default.
  const offerB = offerOn(B, 'off_smoke7');
  hits[A].length = 0;
  await page.goto(`${APP}/subscribe${fragment(offerB)}`, { waitUntil: 'networkidle' });
  await page.getByText("Matches the runner's copy").waitFor({ timeout: 15000 });
  check(hits[B].includes('GET /api/offers/off_smoke7'), 'the offer is checked against the runner it names');
  check(!hits[A].some((x) => x.startsWith('GET /api/offers')), 'the default runner is not asked about it');
  check((await page.locator('aside').innerText()).includes('Talks to: localhost:4177'), 'the page says it talks to that runner');
  await page.getByRole('button', { name: 'Create my pocket and continue' }).click();
  // The signer's workers load the wasm and make the pocket, then register it.
  check(await until(() => hits[B].includes('POST /api/pockets'), 90000), 'the WASM signer registers the pocket with that runner');
  check(hits[B].indexOf('OPTIONS /api/pockets') >= 0 && hits[B].indexOf('OPTIONS /api/pockets') < hits[B].indexOf('POST /api/pockets'), 'after a CORS preflight');
  check(await until(() => hits[B].includes('GET /api/pockets/pkt_smoke1'), 15000), 'and waits for the funding there');
  await page.getByText('One payment covers every installment').waitFor();
  check(!hits[A].some((x) => /pockets/.test(x)), 'the default runner hears nothing of the pocket');

  // An offer naming a runner this build does not know: refused, no request.
  await page.goto(`${APP}/`, { waitUntil: 'networkidle' });
  await page.goto(`${APP}/subscribe${fragment(offerOn(C, 'off_smoke8'))}`, { waitUntil: 'networkidle' });
  await page.getByText(`this app talks only to ${A} and ${B}`).waitFor({ timeout: 10000 });
  check(true, 'an offer naming an unknown runner is refused, with the known runners listed');
  check((await page.getByText(`${C}/subscribe`).count()) > 0, "and points to that runner's own app");
  check(!(await page.getByRole('button', { name: 'Create my pocket and continue' }).count()), 'and offers no way to continue');

  // /manage says which runners a key may belong to.
  await page.goto(`${APP}/manage`, { waitUntil: 'networkidle' });
  check((await page.locator('main').innerText()).includes(`the key's runner, if it is ${A} or ${B}`), '/manage names the runners a key may belong to');

  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violation while using the app${csp.length ? `: ${csp.join(', ')}` : ''}`);
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
  check(!storage.local && !storage.session && !storage.cookies, 'nothing written to browser storage');

  // The CSP itself: a fetch to the unknown runner never leaves the browser.
  deliberate = true;
  const outcome = await page.evaluate((url) => fetch(url).then(() => 'sent', (e) => `blocked: ${e.message}`), `${C}/api/status`);
  await page.waitForTimeout(300);
  const violations = await page.evaluate(() => window.__csp);
  check(outcome.startsWith('blocked') && violations.some((v) => v.startsWith('connect-src') && v.includes(C)), `the CSP blocks a fetch to ${C} (${outcome})`);
  check(hits[C].length === 0, `the unknown runner received no request at all`);

  // Static files: wasm content type, headers on worker scripts too.
  const wasmPath = Object.keys(info.files).find((p) => p.endsWith('.wasm'));
  const workerPath = Object.keys(info.files).find((p) => /Worker-.*\.js$/.test(p));
  const wasmRes = await fetch(`${APP}/${wasmPath}`);
  const workerRes = await fetch(`${APP}/${workerPath}`);
  check(wasmRes.headers.get('content-type') === 'application/wasm', `${wasmPath} is application/wasm`);
  check(workerRes.headers.get('content-security-policy') === cspHeader, `${workerPath} carries the CSP header too`);
  const spa = await fetch(`${APP}/manage`);
  check(spa.status === 200 && (await spa.text()).includes('<div id="root">'), 'unknown paths fall back to index.html');
} finally {
  await browser.close();
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nrunner ${A}: ${[...new Set(hits[A])].join(', ')}`);
console.log(`runner ${B}: ${[...new Set(hits[B])].join(', ')}`);
console.log(`runner ${C}: ${hits[C].length ? hits[C].join(', ') : 'nothing'}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\napp host smoke test passed');
