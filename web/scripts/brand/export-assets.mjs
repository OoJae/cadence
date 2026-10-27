// Exports the raster brand files from a built mock dist: the social card and the app icon.
//
//   env -u VITE_API -u VITE_SIGNER -u VITE_RUNNERS -u VITE_DEFAULT_RUNNER \
//     pnpm exec vite build --outDir /tmp/cadence-mock --emptyOutDir
//   EXPORT_DIST=/tmp/cadence-mock node scripts/brand/export-assets.mjs     # from web/
//   EXPORT_PORT=4364 …                                                    # another port
//
// Builds nothing itself. Serves the dist with `vite preview`, screenshots #og-card on
// /brand at its true 1200 x 630 and DPR 1 into public/og.jpg (JPEG, at most 120 kB, so
// the quality steps down from 85 if the grain makes it heavier), and renders
// public/brand-assets/app-icon.svg as an <img> at 512 and 180 into PNGs beside it. The
// PNGs are for the README and the submission; nothing in the app links them.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.EXPORT_PORT ?? 4363);
const ORIGIN = `http://localhost:${PORT}`;
const dist = process.env.EXPORT_DIST ?? 'dist';
const OG = { width: 1200, height: 630, maxBytes: 120 * 1024 };

const server = spawn(join(root, 'node_modules/.bin/vite'), ['preview', '--port', String(PORT), '--strictPort', '--outDir', dist], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve());
  server.on('exit', (code) => reject(new Error(`vite preview exited with ${code}`)));
  setTimeout(() => reject(new Error('vite preview did not start')), 15000);
});

const problems = [];
const browser = await chromium.launch();
try {
  // ---------------------------------------------------------- og.jpg
  // Reduced motion: the page settles at once, so nothing is caught mid-entrance.
  const ctx = await browser.newContext({ viewport: { width: OG.width, height: OG.height }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(`${ORIGIN}/brand`, { waitUntil: 'networkidle' });
  await page.locator('#og-card').waitFor();
  await page.evaluate(async () => {
    await Promise.all(
      ['400 92px "Bodoni Moda Variable"', 'italic 400 92px "Bodoni Moda Variable"', '400 18px "JetBrains Mono Variable"'].map((f) => document.fonts.load(f)),
    );
    await document.fonts.ready;
    // brand.css pins the card, unscaled, to the top-left corner of the viewport.
    document.documentElement.classList.add('og-export');
  });
  await page.waitForTimeout(300);
  const box = await page.locator('#og-card').boundingBox();
  if (!box || box.x !== 0 || box.y !== 0 || box.width !== OG.width || box.height !== OG.height) {
    throw new Error(`#og-card is not at true size in the corner: ${JSON.stringify(box)}`);
  }
  let quality = 85;
  let jpeg;
  for (;;) {
    jpeg = await page.screenshot({ type: 'jpeg', quality, clip: { x: 0, y: 0, width: OG.width, height: OG.height } });
    if (jpeg.length <= OG.maxBytes || quality <= 50) break;
    quality -= 5;
  }
  if (jpeg.length > OG.maxBytes) problems.push(`og.jpg is ${jpeg.length} bytes even at quality ${quality}`);
  writeFileSync(join(root, 'public/og.jpg'), jpeg);
  console.log(`og.jpg: ${OG.width} x ${OG.height}, quality ${quality}, ${(jpeg.length / 1024).toFixed(1)} kB`);
  await ctx.close();

  // ---------------------------------------------------------- app icon PNGs
  for (const size of [512, 180]) {
    const iconCtx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const icon = await iconCtx.newPage();
    await icon.setContent(`<img id="icon" src="${ORIGIN}/brand-assets/app-icon.svg" width="${size}" height="${size}" alt="">`);
    await icon.waitForFunction(() => {
      const img = document.getElementById('icon');
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    });
    const png = await icon.locator('#icon').screenshot({ type: 'png', omitBackground: true });
    writeFileSync(join(root, `public/brand-assets/app-icon-${size}.png`), png);
    console.log(`app-icon-${size}.png: ${(png.length / 1024).toFixed(1)} kB`);
    await iconCtx.close();
  }
} finally {
  await browser.close();
  server.kill();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
