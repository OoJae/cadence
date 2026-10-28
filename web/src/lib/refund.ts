/**
 * What is left in the pocket once a plan ends early: the merchant stopped it, or an
 * installment was missed (contract v2 §6, `refund_after_stop`).
 *
 * A runner that lists the feature keeps such a pocket's view-only account, so the
 * cancel key refunds what is left from /manage with the cancel machinery; it says
 * `refundable: true` while a note is left, and `refund` once it has seen the refund.
 * Any other runner (the mainnet runner's build 7244e6a among them) deletes a stopped
 * pocket at once, and `cadence sweep` stays the way, as before.
 */
import type { RunnerStatus, Subscription } from '../api/types';

export const REFUND_AFTER_STOP = 'refund_after_stop';

export type RefundRoute =
  /** Refund it in this tab: the runner kept the pocket for it. */
  | { kind: 'refund' }
  /** The runner saw the refund. */
  | { kind: 'refunded'; txid: string; mined_height: number }
  /** Not an early end, or a runner that does not keep the pocket: the page does what it always did. */
  | { kind: 'none' };

const TXID = /^[0-9a-f]{64}$/;

/** A missed or invalid installment leaves the subscription stalled: nothing further pays. */
export const endedEarly = (sub: Pick<Subscription, 'status'>): boolean => sub.status === 'stopped' || sub.status === 'stalled';

/** What /manage offers for what is left in the pocket, from the runner's status and the subscription. */
export function refundRoute(status: Pick<RunnerStatus, 'features'> | undefined, sub: Subscription | undefined): RefundRoute {
  if (!status?.features?.includes(REFUND_AFTER_STOP) || !sub || !endedEarly(sub)) return { kind: 'none' };
  const r = sub.refund;
  if (r && typeof r.txid === 'string' && TXID.test(r.txid) && Number.isSafeInteger(r.mined_height) && r.mined_height > 0) {
    return { kind: 'refunded', txid: r.txid, mined_height: r.mined_height };
  }
  return sub.refundable === true ? { kind: 'refund' } : { kind: 'none' };
}
