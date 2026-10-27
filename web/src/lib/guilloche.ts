/**
 * Guilloché rosettes, as on banknotes and certificates: hypotrochoids whose radii come
 * from the bytes of a transaction id or nullifier, so each certificate's engraving is
 * its own and anyone can redraw it. Pure maths; the output is SVG path data.
 */

export interface Rosette {
  d: string;
  /** 0 for the outermost band. */
  band: number;
}

const BANDS = 4;
const STEPS = 720;

function bytesOf(seed: string): number[] {
  const hex = seed.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 16) throw new RangeError('guilloche seed needs at least 8 bytes of hex');
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Rosette paths in a 200 × 200 box centred on the origin (viewBox "-100 -100 200 200"). */
export function guilloche(seed: string): Rosette[] {
  const b = bytesOf(seed);
  const at = (i: number) => b[i % b.length]!;
  const rosettes: Rosette[] = [];
  for (let band = 0; band < BANDS; band++) {
    const scale = 96 - band * 19;
    // Integer petal counts keep every curve closed after one turn of t.
    const petals = 7 + (at(band * 3) % 13);
    const R = 1;
    const r = R / petals;
    const d = r * (2 + (at(band * 3 + 1) % 9) / 2.5);
    const twist = (at(band * 3 + 2) / 255) * Math.PI;
    const pts: string[] = [];
    let maxRadius = 0;
    const raw: Array<[number, number]> = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = (i / STEPS) * 2 * Math.PI;
      const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
      const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
      const xr = x * Math.cos(twist) - y * Math.sin(twist);
      const yr = x * Math.sin(twist) + y * Math.cos(twist);
      raw.push([xr, yr]);
      maxRadius = Math.max(maxRadius, Math.hypot(xr, yr));
    }
    const k = scale / maxRadius;
    for (const [x, y] of raw) pts.push(`${(x * k).toFixed(2)} ${(y * k).toFixed(2)}`);
    rosettes.push({ band, d: `M${pts.join('L')}Z` });
  }
  return rosettes;
}
