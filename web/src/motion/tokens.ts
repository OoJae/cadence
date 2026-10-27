/**
 * The motion tokens of app.css, for code that animates with the Web Animations API.
 * tokens.test.ts keeps the two in step.
 */
export const EASE_REVEAL = 'cubic-bezier(0.16, 1, 0.3, 1)';
export const EASE_TOGGLE = 'cubic-bezier(0.65, 0, 0.35, 1)';

/** Milliseconds. */
export const DUR = {
  press: 200,
  micro: 240,
  roll: 360,
  reveal: 800,
  revealLong: 1000,
  pageOut: 280,
  page: 900,
  camera: 1200,
  moment: 1400,
} as const;

export const STAGGER = { tight: 50, base: 80, loose: 120 } as const;

/** drand quicknet's period, the page's only repeating rhythm. */
export const BEAT_MS = 3000;

/** Read once per call, never at module load: Node tests import this. */
export function motionOk(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: no-preference)').matches;
}
