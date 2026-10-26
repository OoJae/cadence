/**
 * What the /status page derives from one `GET /api/subscriptions/:id`: progress, the
 * next installment due, what each state means for the payer's funds, and where a
 * mainnet mandate crosses NU7. Pure, and limited to what the runner reported.
 */
import type { Installment, NetworkId, Subscription, SubscriptionStatus } from '../api/types';
import { NU7_ACTIVATION } from './shape';
import { installmentStateInfo } from './states';

/** Mainnet blocks before NU7 (cadence-core PRE_NU7_BLOCK_SECS): only used for a labelled estimate. */
export const PRE_NU7_BLOCK_SECS = 75;

const SUB_ID = /^sub_[A-Za-z0-9_-]{1,76}$/;

/** The subscription id in a `#sub=sub_…` fragment, or null when there is none or it is malformed. */
export function subscriptionIdFromFragment(hash: string): string | null {
  const id = new URLSearchParams(hash.replace(/^#/, '')).get('sub')?.trim();
  return id && SUB_ID.test(id) ? id : null;
}

/** Whether a fragment names a subscription at all, valid or not. */
export function fragmentNamesSubscription(hash: string): boolean {
  return new URLSearchParams(hash.replace(/^#/, '')).has('sub');
}

export function byK(sub: Subscription): Installment[] {
  return [...sub.installments].sort((a, b) => a.k - b.k);
}

/** "k of n paid": an installment is paid once it is mined. */
export function paidOf(sub: Subscription): { paid: number; total: number } {
  return { paid: sub.installments.filter((i) => i.state === 'mined').length, total: sub.installments.length };
}

/**
 * The installment the runner is working towards: the first by k that is still sealed,
 * due or broadcast. Only an active subscription has one; a stalled, stopped,
 * cancelled or completed one pays nothing further.
 */
export function nextDue(sub: Subscription): Installment | null {
  if (sub.status !== 'active') return null;
  return byK(sub).find((i) => i.state === 'sealed' || i.state === 'due' || i.state === 'broadcast') ?? null;
}

const n = (x: number) => x.toLocaleString('en-US');

export const MISSED_NOTE = "Nothing was paid; the funds stay in the payer's pocket, recoverable with cadence sweep.";

/**
 * One plain sentence on an installment, from what the runner reported and nothing
 * more. `status` is the subscription's: once it is not active, nothing further pays.
 */
export function installmentNote(i: Installment, status: SubscriptionStatus = 'active'): string {
  switch (i.state) {
    case 'sealed':
      return status === 'active'
        ? `Opens at drand round ${n(i.release_round)} (the drand network's threshold assumption).`
        : `Sealed to drand round ${n(i.release_round)} (the drand network's threshold assumption), but the subscription is ${status}: the runner releases nothing further.`;
    case 'due':
      return `Its drand round ${n(i.release_round)} has passed and the runner opened it; it is waiting for anchor depth before it broadcasts.`;
    case 'broadcast':
      return i.target_height ? `Broadcast for target height ${n(i.target_height)}, not mined yet.` : 'Broadcast, not mined yet.';
    case 'mined':
      return i.mined_height ? `Paid: mined at height ${n(i.mined_height)}.` : 'Paid: mined.';
    case 'missed':
      return `Missed. ${MISSED_NOTE}`;
    case 'invalid':
      return `Invalid: the package did not match the offer, so it was never broadcast. ${MISSED_NOTE}`;
    default:
      return installmentStateInfo(i.state).description;
  }
}

export type Nu7Crossing =
  /** Testnet, or a mainnet mandate that does not reach across NU7 in what the runner reports. */
  | { kind: 'none' }
  /** Mainnet, the runner's tip is still before NU7, and installments are still to come. */
  | { kind: 'ahead'; nu7: number; tip: number; blocks: number; etaSecs: number }
  /** Something of this mandate was mined before NU7 and installment `k` is the first mined at or after it. */
  | { kind: 'crossed'; nu7: number; k: number; minedHeight: number };

/**
 * Where a mainnet mandate meets NU7 (height 3,543,405). It has crossed once its funding
 * or an installment was mined before NU7 and a later installment at or after it; that
 * later installment is the first Cadence installment after NU7.
 */
export function nu7Crossing(sub: Subscription, network: NetworkId | undefined, tip: number | undefined): Nu7Crossing {
  if (network !== 'main') return { kind: 'none' };
  const nu7 = NU7_ACTIVATION.main;
  const mined = byK(sub).filter((i) => i.state === 'mined' && !!i.mined_height);
  const before = [sub.funding?.mined_height, ...mined.map((i) => i.mined_height)].some((h) => !!h && h < nu7);
  const first = mined.filter((i) => i.mined_height! >= nu7).sort((a, b) => a.mined_height! - b.mined_height! || a.k - b.k)[0];
  if (first && before) return { kind: 'crossed', nu7, k: first.k, minedHeight: first.mined_height! };
  if (first || tip === undefined || tip >= nu7) return { kind: 'none' };
  const toCome = sub.installments.some((i) => i.state === 'sealed' || i.state === 'due' || i.state === 'broadcast');
  if (sub.status !== 'active' || !toCome) return { kind: 'none' };
  const blocks = nu7 - tip;
  return { kind: 'ahead', nu7, tip, blocks, etaSecs: blocks * PRE_NU7_BLOCK_SECS };
}
