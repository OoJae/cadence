/**
 * Subscribing again to the same plan. A signed schedule cannot be paused: its
 * installments are signed for fixed rounds. Pausing is cancelling now and subscribing
 * again later, which is a fresh pocket, a schedule signed from then, and one payment.
 */
import type { Offer, Subscription } from '../api/types';
import { encodeOfferPayload, OFFER_PARAM } from './offer';

/** Whether nothing further pays, so the payer may want the same plan again: completed, cancelled, stopped, or stalled by a missed or invalid installment. */
export const planEnded = (sub: Pick<Subscription, 'status'>): boolean =>
  sub.status === 'completed' || sub.status === 'cancelled' || sub.status === 'stopped' || sub.status === 'stalled';

/** The offer's share link on this app, as a path: the offer in the fragment, naming its own runner. */
export function subscribeAgainPath(offer: Offer): string {
  return `/subscribe#${OFFER_PARAM}=${encodeOfferPayload(offer)}`;
}
