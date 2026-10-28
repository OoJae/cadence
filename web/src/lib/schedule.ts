import type { Offer } from '../api/types';
import { firstRoundAtOrAfter, roundTime } from './drand';

export interface PlannedInstallment {
  k: number;
  amount_zat: number;
  release_round: number;
  release_at: number;
}

/**
 * The first installment releases shortly after signing (the funding note needs a few
 * blocks of depth before it can be spent anyway); each later one follows one period
 * after the previous.
 */
export function firstReleaseLead(periodSecs: number): number {
  return Math.min(periodSecs, 60);
}

/** The most any installment's release is moved, however long the period: 6 hours. */
export const MAX_JITTER_SECS = 21_600;

/**
 * J, the most an installment's release is moved later at random: a quarter period, at
 * most 6 hours. Releases at exact intervals, to the second, would mark the installments
 * as a subscription, so the payer's signer moves each one later by its own draw in
 * [0, J]. Every gap then stays within period ± J, inside the period ± period/2 that
 * runners accept, including runners that predate jitter.
 */
export function jitterMax(periodSecs: number): number {
  return Math.floor(Math.min(periodSecs / 4, MAX_JITTER_SECS));
}

/** Uniform 32-bit integers: the browser's CSPRNG, or a fixed sequence in tests. */
export type RandomU32 = () => number;

export const cryptoRandomU32: RandomU32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!;

/**
 * A uniform integer in [0, max]. A value at the top of the 32-bit range, which would
 * favour small results, is drawn again. crates/cadence-core draws the same way, value
 * for value (`mandate::draw_jitter`).
 */
export function drawJitter(max: number, random: RandomU32 = cryptoRandomU32): number {
  const span = max + 1;
  const limit = 2 ** 32 - (2 ** 32 % span);
  for (;;) {
    const r = random();
    if (r < limit) return r % span;
  }
}

/** Every installment's jitter, installment 1's first, each its own draw. */
export function drawJitters(offer: Pick<Offer, 'period_secs' | 'count'>, random: RandomU32 = cryptoRandomU32): number[] {
  const max = jitterMax(offer.period_secs);
  return Array.from({ length: offer.count }, () => drawJitter(max, random));
}

/**
 * When installment k falls due, before rounding up to a drand round:
 * signedAt + trial + lead + (k − 1)·period + its jitter. A trial delays installment 1,
 * and so every later one.
 */
export function releaseAt(offer: Pick<Offer, 'period_secs' | 'trial_secs'>, signedAt: number, k: number, jitter = 0): number {
  return signedAt + (offer.trial_secs ?? 0) + firstReleaseLead(offer.period_secs) + (k - 1) * offer.period_secs + jitter;
}

/**
 * Installment k releases at the first drand round at or after releaseAt(k), with the
 * jitter drawn at signing. Before signing there is none yet: no jitter is the earliest
 * each can fall due, and a jitter of jitterMax the latest.
 */
export function planSchedule(offer: Pick<Offer, 'amount_zat' | 'period_secs' | 'count' | 'trial_secs'>, signedAt: number, jitter: readonly number[] = []): PlannedInstallment[] {
  return Array.from({ length: offer.count }, (_, i) => {
    const release_round = firstRoundAtOrAfter(releaseAt(offer, signedAt, i + 1, jitter[i]));
    return { k: i + 1, amount_zat: offer.amount_zat, release_round, release_at: roundTime(release_round) };
  });
}
