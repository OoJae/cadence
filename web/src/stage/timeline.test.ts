import { describe, expect, it } from 'vitest';
import { BEAT_ORDER, BEATS, RELEASE, RELEASE_STAGE_END } from './timeline';

describe('stage timeline', () => {
  it('defines every beat', () => {
    expect(Object.keys(BEATS).sort()).toEqual([...BEAT_ORDER].sort());
  });

  it("keeps the release inside the brief's ranges", () => {
    for (const s of RELEASE) {
      if (s.ease === 'toggle') expect(s.dur, s.id).toBeGreaterThanOrEqual(200), expect(s.dur, s.id).toBeLessThanOrEqual(400);
      else expect(s.dur, s.id).toBeGreaterThanOrEqual(600), expect(s.dur, s.id).toBeLessThanOrEqual(1000);
      if (s.stagger !== undefined) expect(s.stagger).toBeGreaterThanOrEqual(50), expect(s.stagger).toBeLessThanOrEqual(120);
    }
    // The stage moment is about 1.4 s.
    expect(RELEASE_STAGE_END).toBeGreaterThanOrEqual(1300);
    expect(RELEASE_STAGE_END).toBeLessThanOrEqual(1450);
  });

  it('keeps the states in range', () => {
    for (const b of Object.values(BEATS)) {
      for (const v of [b.dim, b.sheaths, b.tower, b.cancel]) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(1);
    }
  });
});
