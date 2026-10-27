/**
 * A cancellation certificate: what a mined cancel proves about the rest of the plan.
 *
 * Installment k+1 spends the note the cancel spent (C(k), or the funding note for
 * k = 0), so once that nullifier is on chain no node accepts it. Every later
 * installment spends the change of the one before it, which can now never exist.
 * Both hold only once the cancel is mined, and that the cancel is mined is what the
 * runner's decoder reports: the certificate names that runner, and checks nothing else.
 */
import type { CancelReceipt } from '../signer/types';

export interface Certificate {
  kind: 'cadence-cancellation/1';
  network: 'main' | 'test';
  subscription_id: string | null;
  cancel_txid: string;
  mined_height: number;
  /** The pocket note the cancel spent: 0 is the funding note, k the change of installment k. */
  spent_k: number;
  spent_nullifier: string;
  /** Installments that can never be valid now, first to last (empty if none were left). */
  void_installments: number[];
  returned_zat: number;
  fee_zat: number;
  /** Unix seconds when this page saw the cancel mined. */
  confirmed_at: number;
  /** The runner whose decoder reported the cancel mined: the certificate rests on its word. */
  reported_by: string;
}

/** Installments k+1..count: the first spends the cancelled note, the rest its descendants. */
export function voidInstallments(spentK: number, count: number): number[] {
  const out: number[] = [];
  for (let k = spentK + 1; k <= count; k++) out.push(k);
  return out;
}

/** The certificate, once the decoder shows the cancel mined and revealing the spent nullifier; else null. */
export function certify(
  receipt: CancelReceipt,
  decoded: { mined_height?: number | null; ironwood_nullifiers?: string[] } | undefined,
  plan: { network: 'main' | 'test'; subscription_id: string | null; count: number; runner: string },
  now: number,
): Certificate | null {
  if (receipt.spent_k === undefined || !receipt.spent_nullifier) return null;
  if (!decoded?.mined_height || !decoded.ironwood_nullifiers?.includes(receipt.spent_nullifier.toLowerCase())) return null;
  return {
    kind: 'cadence-cancellation/1',
    network: plan.network,
    subscription_id: plan.subscription_id,
    cancel_txid: receipt.txid,
    mined_height: decoded.mined_height,
    spent_k: receipt.spent_k,
    spent_nullifier: receipt.spent_nullifier,
    void_installments: voidInstallments(receipt.spent_k, plan.count),
    returned_zat: receipt.refunded_zat,
    fee_zat: receipt.fee_zat,
    confirmed_at: now,
    reported_by: plan.runner,
  };
}

/** "3", "3 and 4", "3 to 6". */
export function installmentRange(ks: number[]): string {
  if (ks.length === 0) return '';
  if (ks.length === 1) return String(ks[0]);
  if (ks.length === 2) return `${ks[0]} and ${ks[1]}`;
  return `${ks[0]} to ${ks[ks.length - 1]}`;
}
