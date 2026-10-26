/**
 * The cancel, as a loop over the runner's view of the pocket. The signer supplies
 * the steps (fetch the pocket, fetch a witness, sign and prove, broadcast); this
 * module decides what to spend and how to recover from the two ways a cancel
 * meets the live chain:
 *
 * - **The note is too fresh.** The runner answers the witness request with 400
 *   "not yet anchor-deep" until the note is ANCHOR_CONFIRMATIONS blocks deep. Retry
 *   every RETRY_MS, saying how many blocks are left, for at most WAIT_LIMIT_MS.
 * - **An installment got there first.** Installment k+1 spends C(k) while the cancel
 *   is being proved, so the broadcast is refused (lightwalletd: "another transaction
 *   in the mempool has already spent some of its inputs", or a duplicate nullifier
 *   once it is mined). Re-read the pocket: if installment k+1 left change C(k+1),
 *   cancel that instead, once. If it was the last installment, there is nothing left
 *   to cancel, which is an outcome, not an error.
 */
import { ApiError } from '../api/client';
import type { PocketNoteInfo, PocketState, PocketWitness } from '../api/types';
import { INSTALLMENT_FEE_ZAT } from '../lib/zat';
import { SignerError, type CancelReceipt, type CancelStatus } from './types';
import type { KitNote } from './kit';

/** Blocks a note needs before the runner can give a witness (cadence-chain's ANCHOR_CONFIRMATIONS). */
export const ANCHOR_CONFIRMATIONS = 3;
export const RETRY_MS = 15_000;
export const WAIT_LIMIT_MS = 5 * 60_000;

/** The cancel found nothing to spend: every installment was released first. */
export class NothingToCancelError extends SignerError {
  /** The installment that spent the last note, when known. */
  readonly k: number | null;
  constructor(message: string, k: number | null = null) {
    super(message);
    this.name = 'NothingToCancelError';
    this.k = k;
  }
}

export interface ProvedCancel {
  tx_hex: string;
  txid: string;
  refunded_zat: number;
  fee_zat: number;
  target_height: number;
}

export interface CancelSteps {
  pocket(signal?: AbortSignal): Promise<PocketState>;
  /** A note this signer created, by nullifier. */
  known(nullifier: string): KitNote | undefined;
  witness(nullifier: string, signal?: AbortSignal): Promise<PocketWitness>;
  /** Signs the refund of `note`, then proves it with `witness`. */
  prove(note: KitNote, witness: PocketWitness): Promise<ProvedCancel>;
  /** Not abortable: once sent, the runner may relay it whatever the page does. */
  broadcast(txHex: string): Promise<{ txid: string }>;
  /** Installments in the schedule, if known: installment `count` leaves no change. */
  count: number | null;
}

export interface CancelLoopOptions {
  signal?: AbortSignal;
  onStatus?: (s: CancelStatus) => void;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

const isHeight = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const HEX = /^[0-9a-f]+$/;

/** Once the subscription ends, the runner deletes the funding transaction: `tx_hex` is then "". */
export function checkPocketState(s: PocketState): PocketState {
  if (!s || !isHeight(s.tip) || !Array.isArray(s.notes)) throw new SignerError('the runner sent a malformed pocket status');
  if (s.funding && (typeof s.funding.tx_hex !== 'string' || (s.funding.tx_hex !== '' && !HEX.test(s.funding.tx_hex)) || !isHeight(s.funding.mined_height))) {
    throw new SignerError('the runner sent a malformed funding transaction');
  }
  for (const n of s.notes) {
    if (!n || typeof n.nullifier !== 'string' || !/^[0-9a-f]{64}$/i.test(n.nullifier) || !Number.isSafeInteger(n.value_zat) || !isHeight(n.mined_height)) {
      throw new SignerError('the runner sent a malformed pocket note');
    }
  }
  return s;
}

export function isNotAnchorDeep(e: unknown): boolean {
  return e instanceof ApiError && e.status === 400 && /anchor-deep/i.test(e.message);
}

/** The broadcast was refused because the note's nullifier is already spent, in the mempool or on chain. */
export function isSpendConflict(e: unknown): boolean {
  return e instanceof Error && /already spent|same effects|spent some of its inputs|duplicate .*nullifier|double.?spend|spend conflict/i.test(e.message);
}

export const noteName = (k: number): string => (k === 0 ? 'the funding note' : `the change from installment ${k}`);

export async function runCancel(steps: CancelSteps, opts: CancelLoopOptions = {}): Promise<CancelReceipt> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const status = opts.onStatus ?? (() => {});
  const started = now();
  const live = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new SignerError('stopped');
  };
  const wait = async () => {
    await sleep(RETRY_MS, opts.signal);
    live();
  };
  const expired = () => now() - started >= WAIT_LIMIT_MS;

  /** The note whose broadcast was refused, and why. */
  let refused = null as { note: KitNote; error: unknown } | null;
  let retried = false;

  for (;;) {
    live();
    status({ step: 'finding' });
    const state = await steps.pocket(opts.signal);
    live();
    const listed = state.notes.map((n) => ({ info: n, note: steps.known(String(n.nullifier).toLowerCase()) }));
    if (listed.length && listed.every((n) => !n.note)) throw new SignerError('the runner reports pocket notes this signer did not create');
    const after: number = refused ? refused.note.k : -1;
    const candidate: { info: PocketNoteInfo; note: KitNote | undefined } | undefined = listed.filter((n) => n.note && n.note.k > after).sort((a, b) => b.note!.k - a.note!.k)[0];

    if (!candidate && state.syncing && !expired()) {
      // An installment was just mined and the runner's wallet has not listed its change yet.
      status({ step: 'finding' });
      await wait();
      continue;
    }
    if (!candidate) {
      if (!refused) {
        throw new NothingToCancelError('The runner lists no unspent note for this pocket: every installment has been paid, or it was already cancelled.');
      }
      const next = refused.note.k + 1;
      const stillListed = listed.some((n) => n.note?.nullifier === refused!.note.nullifier);
      if (!stillListed && (steps.count === null || next >= steps.count)) {
        throw new NothingToCancelError(`Installment ${next} was released before your cancel landed: nothing is left to cancel.`, next);
      }
      // A refusal that is not a spend conflict, with the note still unspent, is a real
      // failure; and the one automatic retry is spent.
      if ((stillListed && !isSpendConflict(refused.error)) || retried) throw refused.error;
      if (expired()) {
        throw new SignerError(
          `The pocket note was spent before your cancel landed (by installment ${next}, or by a cancel sent from elsewhere), and no newer note has appeared in ${WAIT_LIMIT_MS / 60_000} minutes. Check the subscription's status, or try again later.`,
        );
      }
      // Installment `next` is in the mempool, or its change is not mined yet.
      status({ step: 'raced', k: next, retryAt: now() + RETRY_MS });
      await wait();
      continue;
    }

    const note: KitNote = candidate.note!;
    if (refused && retried) throw refused.error;
    if (note.value_zat <= INSTALLMENT_FEE_ZAT) throw new NothingToCancelError('Nothing is left in the pocket to refund.');

    let witness: PocketWitness;
    try {
      witness = await steps.witness(note.nullifier, opts.signal);
    } catch (e) {
      if (!isNotAnchorDeep(e)) throw e;
      if (expired()) {
        throw new SignerError(`The pocket's note is still not ${ANCHOR_CONFIRMATIONS} blocks deep after ${WAIT_LIMIT_MS / 60_000} minutes. Try again in a few minutes.`);
      }
      const blocks = Math.max(1, candidate.info.mined_height + ANCHOR_CONFIRMATIONS - 1 - state.tip);
      status({ step: 'waiting', k: note.k, blocks, retryAt: now() + RETRY_MS });
      await wait();
      continue;
    }
    live();

    if (refused) retried = true;
    status({ step: 'proving', k: note.k });
    const tx = await steps.prove(note, witness);
    // Proving takes tens of seconds; a stop while it ran must not broadcast.
    live();
    status({ step: 'broadcasting', k: note.k });
    let res: { txid: string };
    try {
      res = await steps.broadcast(tx.tx_hex);
    } catch (e) {
      // Unreachable, or timed out: the cancel may or may not have been relayed.
      if (!(e instanceof ApiError) || e.status === 0) throw e;
      // Refused: see what spent the note.
      refused = { note, error: e };
      continue;
    }
    if (!res || res.txid !== tx.txid) {
      throw new SignerError(`the runner reported txid ${res?.txid ?? '(none)'} for the cancel, whose txid is ${tx.txid}`);
    }
    return {
      txid: tx.txid,
      refunded_zat: tx.refunded_zat,
      fee_zat: tx.fee_zat,
      target_height: tx.target_height,
      spent: noteName(note.k),
      spent_k: note.k,
      spent_nullifier: note.nullifier,
    };
  }
}
