import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { firstRoundAtOrAfter, roundTime } from './drand';
import { drawJitter, drawJitters, firstReleaseLead, jitterMax, MAX_JITTER_SECS, planSchedule, releaseAt, type RandomU32 } from './schedule';

interface Vector {
  about: string;
  signed_at: number;
  trial_secs: number;
  lead_secs: number;
  period_secs: number;
  count: number;
  jitter_max: number;
  random_u32: number[];
  jitter: number[];
  release_at: number[];
}

/** The cross-language vectors, which crates/cadence-core/src/mandate.rs checks too. */
const VECTORS: Vector[] = JSON.parse(readFileSync(fileURLToPath(new URL('../../../crates/cadence-core/tests/schedule_vectors.json', import.meta.url)), 'utf8')).cases;

/** Hands out `values` in order, and fails a test that asks for more. */
function fixed(values: readonly number[]): RandomU32 & { left: () => number } {
  let i = 0;
  const next = () => {
    if (i >= values.length) throw new Error('out of random values');
    return values[i++]!;
  };
  return Object.assign(next, { left: () => values.length - i });
}

/** xorshift64, high 32 bits: a fair, repeatable stand-in for the CSPRNG. */
function xorshift(seed: bigint): RandomU32 {
  let x = seed;
  const mask = (1n << 64n) - 1n;
  return () => {
    x ^= (x << 13n) & mask;
    x ^= x >> 7n;
    x ^= (x << 17n) & mask;
    return Number(x >> 32n);
  };
}

/**
 * The runner's upload check (`check_schedule` in crates/cadence-runner/src/api.rs), on
 * its timing rules: installment 1 at most trial + period + 600 s after the upload, and
 * each gap within period ± ⌊period / 2⌋.
 */
function runnerScheduleProblem(offer: { period_secs: number; trial_secs?: number }, rounds: number[], now: number): string | null {
  const times = rounds.map((r) => roundTime(r));
  const latestFirst = now + (offer.trial_secs ?? 0) + offer.period_secs + 600;
  if (times[0]! > latestFirst) return `installment 1 releases ${times[0]! - now} s after the upload`;
  const slack = Math.floor(offer.period_secs / 2);
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap < 0 || Math.abs(gap - offer.period_secs) > slack) return `installment ${i + 1} releases ${gap} s after installment ${i}`;
  }
  return null;
}

describe('release jitter', () => {
  it('is a quarter period, at most 6 hours', () => {
    expect(jitterMax(10)).toBe(2);
    expect(jitterMax(20)).toBe(5);
    expect(jitterMax(300)).toBe(75);
    expect(jitterMax(86_399)).toBe(21_599);
    expect(jitterMax(86_400)).toBe(21_600);
    expect(jitterMax(30 * 86_400)).toBe(MAX_JITTER_SECS);
  });

  it('draws every value in [0, J] about equally often', () => {
    const random = xorshift(0x2545f4914f6cdd1dn);
    const seen = new Array<number>(76).fill(0);
    for (let i = 0; i < 76_000; i++) seen[drawJitter(75, random)]!++;
    // About 1,000 each; 800 and 1,200 are more than six standard deviations out.
    expect(seen.every((n) => n > 800 && n < 1200)).toBe(true);
  });

  it('draws again from the top of the 32-bit range, rather than favour small values', () => {
    // 2^32 = 56,512,727 × 76 + 44: the top 44 values would make 0 to 43 likelier.
    const random = fixed([2 ** 32 - 1, 2 ** 32 - 44, 2 ** 32 - 45]);
    expect(drawJitter(75, random)).toBe((2 ** 32 - 45) % 76);
    expect(random.left()).toBe(0);
  });

  it('uses the browser CSPRNG by default, a fresh draw per installment', () => {
    const jitter = drawJitters({ period_secs: 7 * 86_400, count: 12 });
    expect(jitter.every((j) => Number.isInteger(j) && j >= 0 && j <= MAX_JITTER_SECS)).toBe(true);
    // Twelve draws from 21,601 values all alike would be a broken source.
    expect(new Set(jitter).size).toBeGreaterThan(1);
  });
});

describe('release times', () => {
  it('match the vectors the Rust payer is checked against', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(5);
    for (const v of VECTORS) {
      const offer = { period_secs: v.period_secs, count: v.count, trial_secs: v.trial_secs };
      // The web signer's lead is min(period, 60 s); the vectors use it, so the CLI's
      // default --first-in 60 matches it from a 60 s period up.
      expect(firstReleaseLead(v.period_secs), v.about).toBe(v.lead_secs);
      expect(jitterMax(v.period_secs), v.about).toBe(v.jitter_max);
      const random = fixed(v.random_u32);
      const jitter = drawJitters(offer, random);
      expect(jitter, v.about).toEqual(v.jitter);
      expect(random.left(), `${v.about}: every draw is used`).toBe(0);
      expect(jitter.map((j, i) => releaseAt(offer, v.signed_at, i + 1, j)), v.about).toEqual(v.release_at);
      // Sealed to the first round at or after each time.
      const plan = planSchedule({ ...offer, amount_zat: 1 }, v.signed_at, jitter);
      expect(plan.map((p) => p.release_round), v.about).toEqual(v.release_at.map((t) => firstRoundAtOrAfter(t)));
    }
  });

  it('start after the trial, the lead and each installment’s own jitter', () => {
    const offer = { amount_zat: 1, period_secs: 3600, count: 3, trial_secs: 86_400 };
    expect(releaseAt(offer, 1_000, 1)).toBe(1_000 + 86_400 + 60);
    expect(releaseAt(offer, 1_000, 3, 900)).toBe(1_000 + 86_400 + 60 + 2 * 3600 + 900);
    // No trial on the offer is none.
    expect(releaseAt({ period_secs: 3600 }, 1_000, 2)).toBe(1_000 + 60 + 3600);
    // A preview has no jitter: the earliest each installment can fall due.
    expect(planSchedule(offer, 1_000).map((p) => p.release_at)).toEqual([1, 2, 3].map((k) => roundTime(firstRoundAtOrAfter(releaseAt(offer, 1_000, k)))));
  });

  it("always pass the runner's schedule check, from a 60 s period to 30 days, with and without a trial", () => {
    const now = 1_792_677_856;
    const random = xorshift(0x9e3779b97f4a7c15n);
    const periods = [...Array.from({ length: 141 }, (_, i) => 60 + i), 299, 300, 301, 3_599, 3_600, 86_399, 86_400, 86_401, 7 * 86_400, 30 * 86_400];
    for (const period_secs of periods) {
      const most = jitterMax(period_secs);
      for (const trial_secs of [undefined, 3_600, 30 * 86_400]) {
        for (const count of [1, 2, 4, 12]) {
          const offer = { amount_zat: 1, period_secs, count, trial_secs };
          // No jitter, the most, the most and none in turn (the widest and the narrowest
          // gaps), and random draws.
          const patterns = [
            () => new Array<number>(count).fill(0),
            () => new Array<number>(count).fill(most),
            () => Array.from({ length: count }, (_, i) => (i % 2 ? 0 : most)),
            () => Array.from({ length: count }, (_, i) => (i % 2 ? most : 0)),
            ...Array.from({ length: 4 }, () => () => drawJitters(offer, random)),
          ];
          for (const jitter of patterns) {
            // Signed well before the upload, or on a clock running a few minutes fast.
            for (const signedAt of [now - 600, now, now + 300]) {
              const rounds = planSchedule(offer, signedAt, jitter()).map((p) => p.release_round);
              const problem = runnerScheduleProblem(offer, rounds, now);
              if (problem) expect(problem, `period ${period_secs}, trial ${trial_secs}, count ${count}`).toBeNull();
            }
          }
        }
      }
    }
  });

  it('keep every gap within period ± J, which is at most half the runner allows', () => {
    for (const period_secs of [10, 60, 300, 86_400, 30 * 86_400]) {
      const most = jitterMax(period_secs);
      expect(most).toBeLessThanOrEqual(period_secs / 4);
      const offer = { amount_zat: 1, period_secs, count: 3 };
      const [a, b, c] = planSchedule(offer, 1_800_000_000, [most, 0, most]).map((p) => p.release_at);
      // Rounding up to a 3 s drand round moves each by at most 2 s.
      expect(Math.abs(b! - a! - (period_secs - most))).toBeLessThanOrEqual(2);
      expect(Math.abs(c! - b! - (period_secs + most))).toBeLessThanOrEqual(2);
    }
  });
});
