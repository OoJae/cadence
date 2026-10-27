// The judge path, against the deployed app host and the live testnet sandbox runner.
//
//   pnpm verify:judge
//   JUDGE_ORIGIN=https://… JUDGE_RUNNER=https://… pnpm verify:judge
//   JUDGE_REFUND_UA=utest1… pnpm verify:judge      # also cancel with the key on /manage
//
// Walks what a judge does: landing → sandbox → create and auto-fund → save and check the
// cancel key → close the payer tab → the cheats → a mined installment decoded inline,
// then every other page at 1440 and 375 px. It spends testnet TAZ from the sandbox
// faucet and takes several minutes: run it once per deploy, not in a loop.
//
// Fails on any request to an origin other than the app host and the runner, any CSP
// violation, console error, browser storage write, or a step that doesn't complete.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const APP = process.env.JUDGE_ORIGIN ?? 'https://app-production-be97.up.railway.app';
const RUNNER = process.env.JUDGE_RUNNER ?? 'https://sandbox-production-1e16.up.railway.app';
const REFUND_UA = process.env.JUDGE_REFUND_UA;
const out = process.env.JUDGE_OUT ?? mkdtempSync(join(tmpdir(), 'cadence-judge-'));
mkdirSync(out, { recursive: true });
const MIN = 60_000;

const problems = [];
const step = (what) => console.log(`${new Date().toISOString().slice(11, 19)}  ${what}`);
const browser = await chromium.launch({ headless: !process.env.JUDGE_HEADED });

async function newPage({ width = 1440, height = 1000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.origin !== APP && u.origin !== RUNNER) problems.push(`off-origin request: ${r.url()}`);
  });
  page.on('console', (m) => m.type() === 'error' && problems.push(`console error on ${page.url()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error on ${page.url()}: ${e.message}`));
  return page;
}

async function audit(page, label) {
  const csp = await page.evaluate(() => window.__csp);
  for (const v of csp) problems.push(`CSP violation on ${label}: ${v}`);
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
  if (storage.local || storage.session || storage.cookies) problems.push(`browser storage written on ${label}: ${JSON.stringify(storage)}`);
}

try {
  const page = await newPage();
  step(`landing on ${APP}`);
  await page.goto(APP + '/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Subscribe once.' }).waitFor();
  await page.getByRole('link', { name: /Try the judge sandbox/ }).first().click();
  await page.getByRole('button', { name: 'Create mandate and auto-fund' }).waitFor();
  await page.screenshot({ path: join(out, 'sandbox-start.png') });

  step('create and auto-fund (the faucet pays, then the browser signs)');
  await page.getByRole('button', { name: 'Create mandate and auto-fund' }).click();
  await page.locator('#kit-pass').waitFor({ timeout: 10 * MIN });

  step('save the cancel key, then check it opens');
  const pass = `judge path ${Date.now().toString(36)} ${Math.random().toString(36).slice(2)}`;
  await page.locator('#kit-pass').fill(pass);
  await page.locator('#kit-pass-2').fill(pass);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download cancel key/ }).click()]);
  const keyFile = join(out, download.suggestedFilename() || 'cancel-key.json');
  await download.saveAs(keyFile);
  await page.locator('#kit-check-file').setInputFiles(keyFile);
  await page.locator('#kit-check-pass').fill(pass);
  await page.getByRole('button', { name: /Check the key/ }).click();
  await page.getByText('Verified: this key opens your pocket.').waitFor({ timeout: 2 * MIN });

  step('close the payer tab');
  await page.getByRole('button', { name: 'Close the payer tab' }).click();
  const cheats = page.locator('.cheat');
  await cheats.nth(0).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(0).getByText(/Rejected · tlock/).waitFor({ timeout: 2 * MIN });
  step('open early: refused by tlock');

  step('waiting for the runner to release and mine an installment');
  await page.waitForFunction(() => document.querySelectorAll('.pane .tl-item[data-state="mined"]').length >= 1, null, { timeout: 15 * MIN });
  await page.locator('.pane .tl-item[data-state="mined"]').first().getByRole('button', { name: 'Decode' }).click();
  await page.locator('#inline-decode table').waitFor({ timeout: 2 * MIN });
  step('decoded inline');

  await cheats.nth(1).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(1).getByText(/Rejected · signature/).waitFor({ timeout: 2 * MIN });
  step('tamper: refused by the signature check');
  await cheats.nth(2).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(2).getByText(/Rejected · double-spend/).waitFor({ timeout: 2 * MIN });
  step('rebroadcast: refused by the node');
  await cheats.nth(3).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(3).getByText(/Rejected · /).waitFor({ timeout: 2 * MIN });
  step('stretch: refused by the schedule check');
  await page.screenshot({ path: join(out, 'sandbox-cheats.png'), fullPage: true });
  await audit(page, 'sandbox');

  if (REFUND_UA) {
    step('cancel with the key on /manage');
    await page.goto(APP + '/manage', { waitUntil: 'networkidle' });
    await page.locator('#kit-file').setInputFiles(keyFile);
    await page.locator('#kit-open-pass').fill(pass);
    await page.getByRole('button', { name: /Open cancel key/ }).click();
    await page.locator('#refund-ua').fill(REFUND_UA);
    await page.getByRole('button', { name: 'Cancel subscription' }).click();
    await page.getByRole('button', { name: 'Yes, cancel and refund' }).click();
    await page.getByText(/Cancelled at block/).waitFor({ timeout: 15 * MIN });
    await page.screenshot({ path: join(out, 'manage-certificate.png'), fullPage: true });
    await audit(page, 'manage');
  }
  await page.context().close();

  step('every page at 1440 and 375');
  for (const [width, height] of [
    [1440, 900],
    [375, 812],
  ]) {
    const p = await newPage({ width, height });
    for (const path of ['/', '/sandbox', '/merchant', '/decode', '/manage', '/status', '/brand']) {
      await p.goto(APP + path, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1200);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`horizontal overflow on ${path} at ${width}px: ${overflow}px`);
      await p.screenshot({ path: join(out, `${width}${path.replace(/\//g, '-') || '-home'}.png`) });
      await audit(p, `${path} at ${width}px`);
    }
    await p.context().close();
  }
} catch (e) {
  problems.push(`step failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
}

await browser.close();
console.log(`screenshots and the cancel key in ${out}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('OK: the judge path completed, with no off-origin requests, CSP violations, console errors or browser storage.');
