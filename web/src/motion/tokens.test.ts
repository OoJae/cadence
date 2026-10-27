import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DUR, EASE_REVEAL, EASE_TOGGLE, STAGGER } from './tokens';

const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
const ms = (v: string | undefined) => (v?.endsWith('ms') ? parseFloat(v) : parseFloat(v ?? 'NaN') * 1000);

describe('motion tokens', () => {
  it('match the easing curves in app.css', () => {
    expect(token('ease-reveal')).toBe(EASE_REVEAL);
    expect(token('ease-toggle')).toBe(EASE_TOGGLE);
  });

  it('match the durations in app.css', () => {
    const pairs: Array<[string, number]> = [
      ['dur-press', DUR.press],
      ['dur-micro', DUR.micro],
      ['dur-roll', DUR.roll],
      ['dur-reveal', DUR.reveal],
      ['dur-reveal-l', DUR.revealLong],
      ['dur-page-out', DUR.pageOut],
      ['dur-page', DUR.page],
      ['dur-camera', DUR.camera],
      ['dur-moment', DUR.moment],
      ['stagger', STAGGER.base],
      ['stagger-tight', STAGGER.tight],
      ['stagger-loose', STAGGER.loose],
    ];
    for (const [name, value] of pairs) expect(ms(token(name)), name).toBeCloseTo(value);
  });

  it('stay inside the brief: micro 0.2-0.4 s, reveals 0.6-1.0 s, page and hero 0.9-1.4 s, stagger 0.05-0.12 s', () => {
    for (const v of [DUR.press, DUR.micro, DUR.roll]) expect(v).toBeGreaterThanOrEqual(200), expect(v).toBeLessThanOrEqual(400);
    for (const v of [DUR.reveal, DUR.revealLong]) expect(v).toBeGreaterThanOrEqual(600), expect(v).toBeLessThanOrEqual(1000);
    for (const v of [DUR.page, DUR.camera, DUR.moment]) expect(v).toBeGreaterThanOrEqual(900), expect(v).toBeLessThanOrEqual(1400);
    for (const v of Object.values(STAGGER)) expect(v).toBeGreaterThanOrEqual(50), expect(v).toBeLessThanOrEqual(120);
  });
});
