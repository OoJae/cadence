/**
 * Pre-signing a whole schedule across a worker pool.
 *
 * Each installment's candidate heights are cut into chunks and spread over the
 * pool. Every chunk of installment k signs with the same builder seed and input
 * note, so all its rungs share byte-identical actions and the same change note
 * C(k); the engine checks that every chunk agrees (spent nullifier, actions
 * digest, change note) before it seals the ladder.
 *
 * C(k) is known as soon as the first chunk of k returns, so installment k+1 starts
 * then instead of waiting for all of k: the pool never idles between
 * installments. Queue priorities keep the order sensible: k's chunks, then k's
 * sealing, then k+1's chunks.
 */
import type { NetworkId } from '../lib/zat';
import type { PresignPhase, PresignProgress } from './types';
import { SignerError } from './types';
import type { WorkerPool } from './wasmPool';
import type { InstallmentLadder, ShardOut, ShardTerms, SignerOps, WasmNote } from './wasmTypes';

export interface InstallmentPlan {
  k: number;
  release_round: number;
  /** Candidate target heights (`cadence_core::mandate::window`), ascending. */
  heights: number[];
}

export interface SignedInstallment {
  k: number;
  release_round: number;
  /** base64 tlock(age(zstd(ladder))). */
  sealed: string;
  sealed_bytes: number;
  plaintext_bytes: number;
  rungs: number;
  window: [number, number];
  /** The pocket note this installment spends. */
  spends: WasmNote;
  /** C(k), or null after the final installment. */
  change: WasmNote | null;
}

/** What the engine needs from a pool (a WorkerPool, or a fake in tests). */
export type SignerPool = Pick<WorkerPool<SignerOps>, 'call' | 'size'>;

export interface PresignScheduleInput {
  pool: SignerPool;
  network: NetworkId;
  seed: Uint8Array;
  funding: WasmNote;
  terms: ShardTerms;
  /** 16 bytes hex. */
  mandateId: string;
  plans: InstallmentPlan[];
  /** The runner's age X25519 recipient. */
  recipient: string;
  signal?: AbortSignal;
  onProgress?: (p: PresignProgress) => void;
  /** Heights per chunk; defaults to about three chunks per worker, between 4 and 32. */
  chunkSize?: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  // Rejections are always surfaced through the installment that awaits it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function defaultChunkSize(heights: number, workers: number): number {
  return Math.min(32, Math.max(4, Math.ceil(heights / (workers * 3))));
}

function sameShard(a: ShardOut, b: ShardOut): boolean {
  return (
    a.k === b.k &&
    a.spends_nullifier === b.spends_nullifier &&
    a.actions_digest === b.actions_digest &&
    (a.change?.note ?? null) === (b.change?.note ?? null)
  );
}

export async function presignSchedule(input: PresignScheduleInput): Promise<SignedInstallment[]> {
  const { pool, plans, terms } = input;
  const count = plans.length;
  if (count === 0) throw new SignerError('nothing to sign');
  plans.forEach((p, i) => {
    if (p.k !== i + 1) throw new SignerError('installments must be numbered 1, 2, …');
    if (!p.heights.length) throw new SignerError(`installment ${p.k} has no candidate heights`);
  });

  // One failure stops everything still queued.
  const stop = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  /** Started requests run to completion in their worker; nothing new starts after an abort. */
  const live = () => {
    if (signal.aborted) throw signal.reason ?? new SignerError('aborted');
  };

  const inputs = plans.map(() => deferred<WasmNote>());
  inputs[0]!.resolve(input.funding);

  const state = plans.map(() => ({ done: 0, phase: 'sign' as PresignPhase, finished: false, sealedBytes: 0 }));
  let front = 0;
  const progress = (i: number, phase: PresignPhase): PresignProgress => {
    const p = plans[i]!;
    return {
      k: p.k,
      count,
      phase,
      rungsDone: state[i]!.done,
      rungsTotal: p.heights.length,
      window: [p.heights[0]!, p.heights[p.heights.length - 1]!],
      release_round: p.release_round,
      ...(phase === 'done' ? { sealedBytes: state[i]!.sealedBytes } : {}),
    };
  };
  // Progress always describes the lowest unfinished installment, and every
  // installment reports 'done' exactly once, in order.
  const emit = () => {
    if (!input.onProgress) return;
    while (front < count && state[front]!.finished) input.onProgress(progress(front++, 'done'));
    if (front < count) input.onProgress(progress(front, state[front]!.phase));
  };
  emit();

  const signOne = async (i: number): Promise<SignedInstallment> => {
    const plan = plans[i]!;
    const k = plan.k;
    const spends = await inputs[i]!.promise;
    live();
    const size = input.chunkSize ?? defaultChunkSize(plan.heights.length, pool.size);
    let first: ShardOut | null = null;
    const outs = await Promise.all(
      chunk(plan.heights, size).map(async (heights) => {
        live();
        const out = await pool.call(
          'shard',
          { network: input.network, seed: input.seed, input: spends.note, terms, k, mandateId: input.mandateId, heights },
          { priority: 2 * k, signal },
        );
        if (out.rungs.length !== heights.length || out.rungs.some((r, j) => r.target_height !== heights[j])) {
          throw new SignerError(`installment ${k}: a worker returned rungs for the wrong heights`);
        }
        if (!first) {
          first = out;
          if (out.spends_nullifier !== spends.nullifier) throw new SignerError(`installment ${k} does not spend the note it was given`);
          if (i + 1 < count) {
            if (!out.change) throw new SignerError(`the pocket is exhausted after installment ${k} of ${count}`);
            inputs[i + 1]!.resolve(out.change);
          }
        }
        live();
        state[i]!.done += out.rungs.length;
        emit();
        return out;
      }),
    );
    const head = outs[0]!;
    if (outs.some((o) => !sameShard(o, head))) {
      throw new SignerError(`installment ${k}: workers disagree on its actions or change note; refusing to seal`);
    }
    const ladder: InstallmentLadder = {
      k,
      amount_zat: terms.amount_zat,
      spends_nullifier: head.spends_nullifier,
      rungs: outs.flatMap((o) => o.rungs),
    };
    live();
    state[i]!.phase = 'seal';
    emit();
    const sealed = await pool.call(
      'seal',
      { ladderJson: JSON.stringify(ladder), recipient: input.recipient, round: plan.release_round },
      { priority: 2 * k + 1, signal },
    );
    live();
    state[i]!.finished = true;
    state[i]!.sealedBytes = sealed.sealed_bytes;
    emit();
    return {
      k,
      release_round: plan.release_round,
      sealed: sealed.sealed,
      sealed_bytes: sealed.sealed_bytes,
      plaintext_bytes: sealed.plaintext_bytes,
      rungs: ladder.rungs.length,
      window: [plan.heights[0]!, plan.heights[plan.heights.length - 1]!],
      spends,
      change: head.change,
    };
  };

  const running = plans.map((_, i) =>
    signOne(i).catch((e: unknown) => {
      inputs[i + 1]?.reject(e);
      stop.abort(e);
      throw e;
    }),
  );
  try {
    return await Promise.all(running);
  } catch (e) {
    if (input.signal?.aborted) throw input.signal.reason ?? e;
    throw e instanceof SignerError ? e : new SignerError((e as Error).message ?? String(e));
  }
}
