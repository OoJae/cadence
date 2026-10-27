import { describe, expect, it } from 'vitest';
import { cascadeBands, CASCADE_BANDS, hollowBands, HOLLOW_BANDS, ladderTop, PITCH, RELEASED, RUNG, RUNGS, SHEATH, TIP_RELEASE_Y, TOWER } from './geometry';

describe('stage geometry', () => {
  it('draws every sibling of the released rung exactly once, in eight bands', () => {
    const bands = cascadeBands();
    expect(bands).toHaveLength(CASCADE_BANDS);
    const all = bands.flat().sort((a, b) => a - b);
    expect(all).toHaveLength(RUNGS[0] - 1);
    expect(all).not.toContain(RELEASED);
    expect(new Set(all).size).toBe(all.length);
    // Outward from the released rung: each band is no closer than the one before.
    const near = bands.map((b) => Math.min(...b.map((i) => Math.abs(i - RELEASED))));
    expect([...near].sort((a, b) => a - b)).toEqual(near);
  });

  it('hollows ladders 2 and 3 from the top, every rung once', () => {
    for (const k of [1, 2]) {
      const bands = hollowBands(k);
      expect(bands).toHaveLength(HOLLOW_BANDS);
      expect(bands.flat().sort((a, b) => a - b)).toEqual([...Array(RUNGS[k]).keys()]);
      expect(Math.max(...bands[0]!)).toBe(RUNGS[k]! - 1);
    }
  });

  it('sizes every sheath for the tallest ladder (every package is the same 64 KiB)', () => {
    for (const n of RUNGS) expect(SHEATH.y).toBeLessThan(ladderTop(n));
  });

  it('sits the released rung on the tip line, and the tower at its true pitch', () => {
    expect(RUNG.y + RUNG.h).toBe(TIP_RELEASE_Y);
    expect(RUNG.h).toBe(PITCH);
    expect(TOWER.top).toBe(ladderTop(5844));
  });
});
