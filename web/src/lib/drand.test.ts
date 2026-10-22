import { describe, expect, it } from 'vitest';
import { firstRoundAtOrAfter, QUICKNET, roundAt, roundTime } from './drand';
import { planSchedule } from './schedule';

describe('drand quicknet round ↔ time', () => {
  const g = QUICKNET.genesisTime;

  it('matches drand’s CurrentRound and TimeOfRound', () => {
    expect(roundAt(g - 1)).toBe(0);
    expect(roundAt(g)).toBe(1);
    expect(roundAt(g + 2.9)).toBe(1);
    expect(roundAt(g + 3)).toBe(2);
    expect(roundTime(1)).toBe(g);
    expect(roundTime(1001)).toBe(g + 3000);
  });

  it('inverts cleanly', () => {
    for (const r of [1, 2, 33_291_496, 40_000_000]) expect(roundAt(roundTime(r))).toBe(r);
  });

  it('time-locks to the first round at or after a time', () => {
    for (const t of [g + 0.5, g + 3, g + 100_000.2, 1_792_677_856]) {
      const r = firstRoundAtOrAfter(t);
      expect(roundTime(r)).toBeGreaterThanOrEqual(t);
      expect(roundTime(r - 1)).toBeLessThan(t);
    }
  });

  it('schedules installments one period apart on round boundaries', () => {
    const plan = planSchedule({ amount_zat: 1, period_secs: 2_592_000, count: 3 }, 1_792_677_856);
    expect(plan.map((p) => p.k)).toEqual([1, 2, 3]);
    expect(plan[0]!.release_at - 1_792_677_856).toBeGreaterThanOrEqual(60);
    expect(plan[1]!.release_at - plan[0]!.release_at).toBeGreaterThan(2_592_000 - 3);
    expect(plan[1]!.release_at - plan[0]!.release_at).toBeLessThan(2_592_000 + 3);
    for (const p of plan) expect(roundTime(p.release_round)).toBe(p.release_at);
  });
});
