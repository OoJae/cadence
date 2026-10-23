// End-to-end privacy check and screenshots, against the production build.
//
//   pnpm build && pnpm verify
//   VERIFY_DIST=/tmp/dist-mock pnpm verify     # a build elsewhere (vite build --outDir …)
//
// Serves dist/ with `vite preview`, drives every page and both flows in headless
// Chromium, and fails if the page makes any request to another origin, triggers a
// Content-Security-Policy violation, logs a console error, or writes to browser
// storage. Screenshots land in screenshots/.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'screenshots');
mkdirSync(outDir, { recursive: true });
const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;
const S2 = '7ae2c96a9ca13ba42097236766582cab0c5c4809777c966c2bdb50e46597e790';

const dist = process.env.VERIFY_DIST ?? 'dist';
const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort', '--outDir', dist], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  server.on('exit', (code) => reject(new Error(`vite preview exited with ${code}`)));
  setTimeout(() => reject(new Error('vite preview did not start')), 15000);
});

const problems = [];
const requests = new Set();
const browser = await chromium.launch();

async function newPage({ width = 1440, height = 900, theme = 'dark', mobile = false } = {}) {
  // 1x on desktop keeps the committed screenshots small; phones are captured at 2x.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: theme, isMobile: mobile, hasTouch: mobile });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await ctx.newPage();
  // Runs before the app; CDP-injected, so it is not itself subject to the page CSP.
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('request', (r) => {
    requests.add(r.url());
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.origin !== ORIGIN) problems.push(`off-origin request: ${r.url()}`);
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

async function shot(page, name, fullPage = true) {
  // Scroll home first so the sticky header is drawn at the top of a full-page capture.
  if (fullPage) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
}

// ------------------------------------------------------------ static pages, dark + light
{
  const page = await newPage();
  for (const [path, name] of [
    ['/', '01-landing'],
    ['/merchant', '02-merchant'],
    [`/decode/${S2}`, '03-decoder'],
    ['/manage', '06-manage'],
  ]) {
    await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await shot(page, name);
    await audit(page, path);
  }
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Switch to light theme/ }).click();
  await page.waitForTimeout(300);
  await shot(page, '04-landing-light', false);
  await page.getByRole('link', { name: 'Merchant', exact: true }).first().click();
  await page.waitForTimeout(1500);
  await shot(page, '05-merchant-light', false);
  await audit(page, 'light mode');
  await page.context().close();
}

// ------------------------------------------------------------ payer flow from a merchant share link
{
  const page = await newPage({ width: 1360, height: 1000 });
  await page.goto(ORIGIN + '/merchant', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create offer and share link' }).click();
  await page.getByRole('link', { name: 'Open as payer' }).click();
  await page.getByText("Matches the runner's copy").waitFor();
  await shot(page, '10-subscribe-plan');
  await page.getByRole('button', { name: 'Create my pocket and continue' }).click();
  await page.getByRole('button', { name: /Simulate the payment/ }).waitFor();
  await shot(page, '11-subscribe-fund');
  await page.getByRole('button', { name: /Simulate the payment/ }).click();
  await page.getByText('Signing your schedule').waitFor();
  await page.waitForTimeout(900);
  await shot(page, '12-subscribe-signing');
  await page.getByText('You can close this tab now.').waitFor({ timeout: 30000 });
  await page.waitForTimeout(2200);
  await shot(page, '13-subscribe-done');
  await page.getByRole('button', { name: 'Manage or cancel' }).click();
  await page.getByText('Your subscription').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, '14-subscribe-manage');
  await audit(page, 'subscribe flow');
  await page.context().close();
}

// ------------------------------------------------------------ judge sandbox, end to end
{
  const page = await newPage({ width: 1440, height: 1000 });
  await page.goto(ORIGIN + '/sandbox', { waitUntil: 'networkidle' });
  await shot(page, '20-sandbox-start', false);
  await page.getByRole('button', { name: 'Create mandate and auto-fund' }).click();
  await page.getByRole('button', { name: 'Close the payer tab' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2200);
  await shot(page, '21-sandbox-close-the-tab', false);
  await page.getByRole('button', { name: 'Close the payer tab' }).click();

  // Cheat 1 while installment 3 is still sealed.
  const cheats = page.locator('.cheat');
  await cheats.nth(0).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(0).getByText(/Rejected · tlock/).waitFor();

  // Watch three installments land.
  await page.waitForFunction(() => document.querySelectorAll('.pane .tl-item[data-state="mined"]').length >= 3, null, { timeout: 120000 });
  await shot(page, '22-sandbox-three-landed');

  // Cheat 2: tamper with an opened installment.
  await cheats.nth(1).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(1).getByText(/Rejected · signature/).waitFor();

  // Decode one inline.
  await page.locator('.pane .tl-item[data-state="mined"]').first().getByRole('button', { name: 'Decode' }).click();
  await page.locator('#inline-decode table').waitFor();
  await page.waitForTimeout(600);
  await page.locator('#inline-decode').screenshot({ path: join(outDir, '23-sandbox-decode.png') });

  // Reopen, cancel.
  await page.getByRole('button', { name: /Reopen and unlock/ }).click();
  await page.getByRole('button', { name: 'Use a demo refund address' }).click();
  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  await page.getByRole('button', { name: 'Yes, cancel and refund' }).click();
  await page.getByText('Cancel broadcast.').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.pane .tl-item[data-state="cancelled"]').length >= 1, null, { timeout: 60000 });

  // Cheat 3: replay after cancel.
  await cheats.nth(2).getByRole('button', { name: /Try it/ }).click();
  await cheats.nth(2).getByText(/Rejected · double-spend/).waitFor();
  await page.waitForTimeout(800);
  await shot(page, '24-sandbox-cancelled-and-cheats');
  await page.locator('.cheat').first().locator('..').screenshot({ path: join(outDir, '25-sandbox-cheats.png') });
  await audit(page, 'sandbox');
  await page.context().close();
}

// ------------------------------------------------------------ mobile
{
  const page = await newPage({ width: 390, height: 844, mobile: true });
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '30-mobile-landing', false);
  await page.goto(ORIGIN + '/merchant', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot(page, '31-mobile-merchant', false);
  await page.goto(`${ORIGIN}/decode/${S2}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '32-mobile-decoder', false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`horizontal page overflow on mobile decoder: ${overflow}px`);
  await audit(page, 'mobile');
  await page.context().close();
}

await browser.close();
server.kill();

const origins = [...new Set([...requests].map((u) => new URL(u).origin))];
console.log(`requests: ${requests.size} (origins: ${origins.join(', ')})`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('OK: no off-origin requests, no CSP violations, no console errors, no browser storage.');
console.log(`screenshots in ${outDir}`);
