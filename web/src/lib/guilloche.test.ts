import { describe, expect, it } from 'vitest';
import { guilloche } from './guilloche';

const A = '6594ea6cf9d773b9afc11a8e8628328393eace24c5297f33bdb3dd637df56de3';
const B = '2f1154c7f02916d5c2f36a5091ca39077eb9ba01a3f7b3a29f6aee0540c7006e';

describe('guilloche', () => {
  it('is deterministic for a seed', () => {
    expect(guilloche(A)).toEqual(guilloche(A));
  });
  it('draws a different engraving for a different seed', () => {
    expect(guilloche(A).map((r) => r.d)).not.toEqual(guilloche(B).map((r) => r.d));
  });
  it('stays inside its 200 × 200 box', () => {
    for (const r of guilloche(A)) {
      for (const n of r.d.match(/-?\d+\.\d+/g)!) expect(Math.abs(Number(n))).toBeLessThanOrEqual(96.01);
    }
  });
  it('refuses a seed too short to engrave', () => {
    expect(() => guilloche('abcd')).toThrow(RangeError);
  });
});
