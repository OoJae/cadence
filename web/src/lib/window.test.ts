import { describe, expect, it } from 'vitest';
import { aheadFor, rungWindow } from './window';

describe('rungWindow', () => {
  it("matches the spec's table at 25 s blocks", () => {
    expect(rungWindow(aheadFor(60)).rungs).toBe(157);
    expect(rungWindow(aheadFor(86_400))).toMatchObject({ ahead: 3456, below: 279, above: 454, rungs: 734 });
    expect(rungWindow(aheadFor(30 * 86_400))).toMatchObject({ ahead: 103_680, below: 2333, above: 3510, rungs: 5844 });
    expect(rungWindow(aheadFor(330 * 86_400)).rungs).toBe(42_916);
  });

  it("gives testnet run 1's 157, 167 and 175 rungs for offsets of 60, 180 and 300 s", () => {
    expect([60, 180, 300].map((t) => rungWindow(aheadFor(t)).rungs)).toEqual([157, 167, 175]);
  });

  it('starts at the block after the signing tip when the window would reach below it', () => {
    expect(rungWindow(2).start).toBe(1);
  });
});
