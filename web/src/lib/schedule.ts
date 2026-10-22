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

/** Installment k releases at the first drand round at or after signedAt + lead + (k-1)·period. */
export function planSchedule(offer: Pick<Offer, 'amount_zat' | 'period_secs' | 'count'>, signedAt: number): PlannedInstallment[] {
  const lead = firstReleaseLead(offer.period_secs);
  return Array.from({ length: offer.count }, (_, i) => {
    const release_round = firstRoundAtOrAfter(signedAt + lead + i * offer.period_secs);
    return { k: i + 1, amount_zat: offer.amount_zat, release_round, release_at: roundTime(release_round) };
  });
}
