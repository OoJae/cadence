/**
 * How many rungs an installment is signed for: the spec's window W_k
 * (spec/zip-draft-pre-authorized-mandates.md, "Window"; impl `mandate.rs::window`),
 * on a 25 s chain with no exclusions. The landing draws ladders at these real counts.
 */
export interface Window {
  /** Blocks from the signing tip to the predicted height p. */
  ahead: number;
  below: number;
  above: number;
  /** Lowest signed height, as an offset from the signing tip. */
  start: number;
  rungs: number;
}

export function rungWindow(ahead: number): Window {
  if (!Number.isSafeInteger(ahead) || ahead < 0) throw new RangeError(`bad ahead ${ahead}`);
  const s = Math.floor(4 * Math.sqrt(ahead));
  const below = 10 + s + Math.floor(ahead / 100);
  const above = 150 + s + Math.floor(ahead / 50);
  const start = Math.max(ahead - below, 1);
  return { ahead, below, above, start, rungs: ahead + above - start + 1 };
}

/** Blocks ahead for a release `secs` after signing, at 25 s blocks. */
export const aheadFor = (secs: number): number => Math.floor(secs / 25);
