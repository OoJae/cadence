// Outlines the wordmark: lowercase "cadence" in Bodoni Moda Italic at opsz 96, wght 500,
// tracked -0.005em, drawn as paths so no brand file depends on a font being installed.
//
//   node scripts/brand/outline-wordmark.mjs        # from web/
//
// Writes src/brand/wordmarkPaths.ts (for <Wordmark/> and <Lockup/>) and, in
// public/brand-assets/, wordmark.svg, wordmark-light.svg, lockup.svg and lockup-light.svg.
// The mark comes from public/brand-assets/mark.svg, so it is drawn in one place only.
//
// fontkit 2.0.4 opens WOFF2 but cannot vary it: getVariation() re-reads the compressed
// bytes as a plain TrueType font, and the transformed glyf table it decodes up front
// never passes through gvar. So this decompresses the WOFF2 with fontkit's own brotli
// decoder, re-encodes glyf and loca untransformed into a plain sfnt, and varies that.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fontkit = createRequire(join(root, 'package.json'))('fontkit');

const FONT = join(root, 'node_modules/@fontsource-variable/bodoni-moda/files/bodoni-moda-latin-opsz-italic.woff2');
const WORD = 'cadence';
const AXES = { opsz: 96, wght: 500 };
const TRACKING_EM = -0.005;
/** The wordmark is drawn at 100 units to the em: coordinates read as percent of the type size. */
const EM = 100;
/** Lockup rules: the mark is as tall as the d's ascender, then a gap of 0.35 x that height. */
const LOCKUP_GAP = 0.35;
const COLOURS = {
  dark: { ink: '#ECEAE3', rung: '#F4B728' },
  light: { ink: '#171917', rung: '#B07800' },
};

// ------------------------------------------------------------ WOFF2 -> plain TrueType

function glyfEntry(g) {
  const out = [];
  const i16 = (n) => out.push((n >> 8) & 0xff, n & 0xff);
  if (g.numberOfContours > 0) {
    const pts = g.points;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    i16(g.numberOfContours);
    i16(Math.min(...xs));
    i16(Math.min(...ys));
    i16(Math.max(...xs));
    i16(Math.max(...ys));
    pts.forEach((p, i) => p.endContour && i16(i));
    i16(0); // no instructions: hinting doesn't survive outlining anyway
    // One flag per point (on-curve bit only), then 16-bit deltas: simple and lossless.
    for (const p of pts) out.push(p.onCurve ? 1 : 0);
    pts.forEach((p, i) => i16(p.x - (i ? pts[i - 1].x : 0)));
    pts.forEach((p, i) => i16(p.y - (i ? pts[i - 1].y : 0)));
  } else if (g.numberOfContours < 0) {
    // Composite glyphs: the bbox only seeds phantom points, which HVAR overrides.
    i16(-1);
    i16(0);
    i16(0);
    i16(0);
    i16(0);
    const f2dot14 = (v) => i16(Math.round(v * 16384));
    g.components.forEach((c, i) => {
      const scaled = c.scale01 || c.scale10 ? 0x80 : c.scaleX !== c.scaleY ? 0x40 : c.scaleX !== 1 ? 0x08 : 0;
      i16(0x0001 | 0x0002 | scaled | (i < g.components.length - 1 ? 0x0020 : 0));
      i16(c.glyphID);
      i16(c.dx);
      i16(c.dy);
      if (scaled === 0x08) f2dot14(c.scaleX);
      if (scaled === 0x40) [c.scaleX, c.scaleY].forEach(f2dot14);
      if (scaled === 0x80) [c.scaleX, c.scale01, c.scale10, c.scaleY].forEach(f2dot14);
    });
  }
  while (out.length % 4) out.push(0);
  return out;
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])) >>> 0;
  return sum;
}

function woff2ToTtf(woff2) {
  const font = fontkit.create(woff2);
  font._decompress();
  font._transformGlyfTable();
  const data = font.stream.buffer;

  const glyf = [];
  const loca = [];
  for (const g of font._transformedGlyphs) {
    loca.push(glyf.length);
    glyf.push(...glyfEntry(g));
  }
  loca.push(glyf.length);
  const locaBytes = Buffer.alloc(loca.length * 4);
  loca.forEach((o, i) => locaBytes.writeUInt32BE(o, i * 4));

  const tables = {};
  for (const [tag, t] of Object.entries(font.directory.tables)) {
    if (tag === 'glyf') tables[tag] = Buffer.from(glyf);
    else if (tag === 'loca') tables[tag] = locaBytes;
    else tables[tag] = Buffer.from(data.subarray(t.offset, t.offset + t.length));
  }
  tables.head = Buffer.from(tables.head);
  tables.head.writeInt16BE(1, 50); // indexToLocFormat: long offsets

  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + 16 * n);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(n * 16 - pow * 16, 10);
  const bodies = [];
  let offset = header.length;
  tags.forEach((tag, i) => {
    const raw = tables[tag];
    const padded = Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
    header.write(tag.padEnd(4, ' '), 12 + i * 16, 'latin1');
    header.writeUInt32BE(checksum(padded), 16 + i * 16);
    header.writeUInt32BE(offset, 20 + i * 16);
    header.writeUInt32BE(raw.length, 24 + i * 16);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

// ------------------------------------------------------------ outlines

const num = (n) => {
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

/** fontkit path commands (font units, y up) to SVG path data (y down), scaled and offset. */
function svgPath(path, k, ox, oy) {
  const pt = (x, y) => `${num(x * k + ox)} ${num(oy - y * k)}`;
  return path.commands
    .map(({ command, args }) => {
      if (command === 'moveTo') return `M${pt(args[0], args[1])}`;
      if (command === 'lineTo') return `L${pt(args[0], args[1])}`;
      if (command === 'quadraticCurveTo') return `Q${pt(args[0], args[1])} ${pt(args[2], args[3])}`;
      if (command === 'bezierCurveTo') return `C${pt(args[0], args[1])} ${pt(args[2], args[3])} ${pt(args[4], args[5])}`;
      return 'Z';
    })
    .join('');
}

const ttf = fontkit.create(woff2ToTtf(readFileSync(FONT)));
const font = ttf.getVariation(AXES);
const k = EM / font.unitsPerEm;
const run = font.layout(WORD);

// Lay out on a baseline at y = 0, then measure the ink.
let pen = 0;
const placed = run.glyphs.map((glyph, i) => {
  const pos = run.positions[i];
  const at = { glyph, x: pen + pos.xOffset, y: pos.yOffset };
  pen += pos.xAdvance + TRACKING_EM * font.unitsPerEm;
  return at;
});
const ink = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
for (const { glyph, x, y } of placed) {
  const b = glyph.path.bbox;
  if (!Number.isFinite(b.minX)) continue;
  ink.minX = Math.min(ink.minX, (x + b.minX) * k);
  ink.maxX = Math.max(ink.maxX, (x + b.maxX) * k);
  ink.minY = Math.min(ink.minY, -(y + b.maxY) * k);
  ink.maxY = Math.max(ink.maxY, -(y + b.minY) * k);
}
const dGlyph = placed.find((p) => p.glyph.codePoints.includes('d'.codePointAt(0)));
if (!dGlyph) throw new Error('no d in the wordmark');

// Normalise so the ink's top-left corner is the origin.
const baseline = -ink.minY;
const ascender = (dGlyph.y + dGlyph.glyph.path.bbox.maxY) * k;
const width = ink.maxX - ink.minX;
const height = ink.maxY - ink.minY;
const d = placed.map(({ glyph, x, y }) => svgPath(glyph.path, k, x * k - ink.minX, baseline - y * k)).join('');

// The mark, from its one source file: bars and the pulled rung on a 48 grid, extent 4.5-43.5 x 8-40.
const markSvg = readFileSync(join(root, 'public/brand-assets/mark.svg'), 'utf8');
const bars = /<path[^>]*\sd="([^"]+)"/.exec(markSvg)?.[1];
const rungAttrs = /<rect([^>]*)\/>/.exec(markSvg)?.[1] ?? '';
const attr = (name) => Number(new RegExp(`\\s${name}="([^"]+)"`).exec(rungAttrs)?.[1]);
const rung = { x: attr('x'), y: attr('y'), width: attr('width'), height: attr('height') };
if (!bars || Object.values(rung).some((v) => !Number.isFinite(v))) throw new Error('could not read the mark from mark.svg');
const MARK_EXTENT = { x: 4.5, y: 8, width: 39, height: 32 };

const scale = ascender / MARK_EXTENT.height;
const markWidth = MARK_EXTENT.width * scale;
const lockup = {
  // The bars sit on the baseline; their tops meet the d's ascender.
  mark: { x: -MARK_EXTENT.x * scale, y: baseline - (MARK_EXTENT.y + MARK_EXTENT.height) * scale, scale },
  wordX: markWidth + LOCKUP_GAP * ascender,
};
if (baseline - ascender < -0.01) throw new Error('the d is not the tallest letter: the lockup needs a top offset');
lockup.width = lockup.wordX + width;
lockup.height = height;

// ------------------------------------------------------------ write

const r = (n) => Number(num(n));
const ts = `/**
 * The wordmark, outlined: "${WORD}" in Bodoni Moda Italic (opsz ${AXES.opsz}, wght ${AXES.wght}), tracked
 * ${TRACKING_EM}em, at ${EM} units to the em. Generated by scripts/brand/outline-wordmark.mjs; do not edit.
 */
export const WORDMARK = {
  /** viewBox "0 0 width height": the ink's bounding box. */
  width: ${r(width)},
  height: ${r(height)},
  /** Units to the em: an SVG drawn at size/${EM} scale matches live text at that font size. */
  em: ${EM},
  /** y of the baseline, from the top of the ink. */
  baseline: ${r(baseline)},
  /** Height of the d's ascender above the baseline: the mark is drawn exactly this tall. */
  ascender: ${r(ascender)},
  d: '${d}',
} as const;

/** The mark beside the wordmark: as tall as the d, bars on the baseline, a ${LOCKUP_GAP} x height gap. */
export const LOCKUP = {
  width: ${r(lockup.width)},
  height: ${r(lockup.height)},
  baseline: ${r(baseline)},
  /** Transform of the 48-grid mark: translate(x y) scale(scale). */
  mark: { x: ${r(lockup.mark.x)}, y: ${r(lockup.mark.y)}, scale: ${Number(scale.toFixed(5))} },
  /** x of the wordmark's ink. */
  wordX: ${r(lockup.wordX)},
} as const;

/** The mark on its 48 grid (public/brand-assets/mark.svg). */
export const MARK = {
  bars: '${bars}',
  rung: { x: ${rung.x}, y: ${rung.y}, width: ${rung.width}, height: ${rung.height} },
} as const;
`;
writeFileSync(join(root, 'src/brand/wordmarkPaths.ts'), ts);

const svgOpen = (w, h, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}"><title>${title}</title>`;
for (const [theme, c] of Object.entries(COLOURS)) {
  const suffix = theme === 'light' ? '-light' : '';
  const label = theme === 'light' ? ' (light)' : '';
  writeFileSync(join(root, `public/brand-assets/wordmark${suffix}.svg`), `${svgOpen(width, height, `Cadence wordmark${label}`)}<path fill="${c.ink}" d="${d}"/></svg>\n`);
  const m = lockup.mark;
  writeFileSync(
    join(root, `public/brand-assets/lockup${suffix}.svg`),
    `${svgOpen(lockup.width, lockup.height, `Cadence lockup${label}`)}<g transform="translate(${num(m.x)} ${num(m.y)}) scale(${scale.toFixed(5)})"><path fill="${c.ink}" d="${bars}"/><rect x="${rung.x}" y="${rung.y}" width="${rung.width}" height="${rung.height}" fill="${c.rung}"/></g><path fill="${c.ink}" transform="translate(${num(lockup.wordX)} 0)" d="${d}"/></svg>\n`,
  );
}

console.log(`${WORD}: ${run.glyphs.map((g) => g.name).join(' ')}; ink ${num(width)} x ${num(height)} at ${EM}/em; baseline ${num(baseline)}; d ascender ${num(ascender)}`);
console.log(`lockup ${num(lockup.width)} x ${num(lockup.height)}; mark scale ${scale.toFixed(4)}; word at x ${num(lockup.wordX)}`);
