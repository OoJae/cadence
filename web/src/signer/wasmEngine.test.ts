import { describe, expect, it } from 'vitest';
import type { PresignProgress } from './types';
import { chunk, defaultChunkSize, presignSchedule, type InstallmentPlan, type SignerPool } from './wasmEngine';
import { WorkerPool } from './wasmPool';
import type { SignerOps, WasmNote, WorkerReply, WorkerRequest } from './wasmTypes';

const note = (name: string, value = 1): WasmNote => ({ note: `note-${name}`, value_zat: value, nullifier: `nf-${name}` });
const FUNDING = note('F', 120_000);

type Log = Array<{ op: string; k: number; heights?: number[] }>;

/**
 * A pool that answers like cadence-wasm would: installment k spends `input`, and
 * every shard of k returns the same actions digest and change note C(k).
 */
function fakePool(opts: { size?: number; tamper?: (k: number, heights: number[]) => Partial<Record<'actions_digest' | 'spends_nullifier', string>>; exhaustAt?: number } = {}) {
  const log: Log = [];
  const pool: SignerPool = {
    size: opts.size ?? 3,
    call: (async (op: string, args: never) => {
      if (op === 'shard') {
        const a = args as SignerOps['shard']['in'];
        log.push({ op, k: a.k, heights: a.heights });
        await new Promise((r) => setTimeout(r, 1 + a.heights.length));
        log.push({ op: 'shard-done', k: a.k });
        const spends = a.input === FUNDING.note ? FUNDING.nullifier : a.input.replace('note-', 'nf-');
        const last = a.k === a.terms.count || a.k === opts.exhaustAt;
        return {
          k: a.k,
          rungs: a.heights.map((h) => ({ target_height: h, expiry_height: h + 120, pczt: 'ab' })),
          spends_nullifier: spends,
          actions_digest: `digest-${a.k}`,
          change: last ? null : note(`C${a.k}`),
          ...(opts.tamper?.(a.k, a.heights) ?? {}),
        };
      }
      if (op === 'seal') {
        await new Promise((r) => setTimeout(r, 1));
        const a = args as SignerOps['seal']['in'];
        const ladder = JSON.parse(a.ladderJson);
        log.push({ op, k: ladder.k });
        return { sealed: `sealed-${ladder.k}-${ladder.rungs.length}`, sealed_bytes: 65536, plaintext_bytes: a.ladderJson.length, round: a.round };
      }
      throw new Error(`unexpected ${op}`);
    }) as SignerPool['call'],
  };
  return { pool, log };
}

const plans = (count: number, n = 10): InstallmentPlan[] =>
  Array.from({ length: count }, (_, i) => ({ k: i + 1, release_round: 1000 + i * 200, heights: Array.from({ length: n }, (_, j) => 500 + i * 3 + j) }));

const input = (pool: SignerPool, count: number, extra: Partial<Parameters<typeof presignSchedule>[0]> = {}) => ({
  pool,
  network: 'test' as const,
  seed: new Uint8Array(32),
  funding: FUNDING,
  terms: { amount_zat: 50_000, count, merchant_ua: 'utest1merchant' },
  mandateId: '00'.repeat(16),
  plans: plans(count),
  recipient: 'age1runner',
  ...extra,
});

describe('presignSchedule', () => {
  it('chains change notes, keeps every rung in height order and seals each installment once', async () => {
    const { pool, log } = fakePool();
    const out = await presignSchedule(input(pool, 3));
    expect(out.map((s) => s.k)).toEqual([1, 2, 3]);
    expect(out.map((s) => s.spends.nullifier)).toEqual(['nf-F', 'nf-C1', 'nf-C2']);
    expect(out.map((s) => s.change?.note ?? null)).toEqual(['note-C1', 'note-C2', null]);
    expect(out.map((s) => s.sealed)).toEqual(['sealed-1-10', 'sealed-2-10', 'sealed-3-10']);
    expect(out[1]!.window).toEqual([503, 512]);
    expect(log.filter((e) => e.op === 'seal').map((e) => e.k)).toEqual([1, 2, 3]);
    // Shards cover the window exactly, once.
    for (const k of [1, 2, 3]) {
      const hs = log.filter((e) => e.op === 'shard' && e.k === k).flatMap((e) => e.heights!);
      expect(hs.sort((a, b) => a - b)).toEqual(plans(3)[k - 1]!.heights);
    }
  });

  it('starts installment k+1 as soon as the first shard of k returns', async () => {
    const { pool, log } = fakePool();
    await presignSchedule(input(pool, 2, { chunkSize: 2 }));
    const firstK2 = log.findIndex((e) => e.op === 'shard' && e.k === 2);
    const lastK1Done = log.findLastIndex((e) => e.op === 'shard-done' && e.k === 1);
    const sealK1 = log.findIndex((e) => e.op === 'seal' && e.k === 1);
    expect(firstK2).toBeGreaterThan(-1);
    expect(firstK2).toBeLessThan(sealK1);
    expect(firstK2).toBeLessThan(lastK1Done);
  });

  it('reports progress for the lowest unfinished installment, and done exactly once each, in order', async () => {
    const { pool } = fakePool();
    const seen: PresignProgress[] = [];
    await presignSchedule(input(pool, 3, { onProgress: (p) => seen.push(p) }));
    expect(seen.filter((p) => p.phase === 'done').map((p) => p.k)).toEqual([1, 2, 3]);
    expect(seen.filter((p) => p.phase === 'done').every((p) => p.sealedBytes === 65536 && p.rungsDone === 10 && p.rungsTotal === 10)).toBe(true);
    const ks = seen.map((p) => p.k);
    expect(ks).toEqual([...ks].sort((a, b) => a - b));
    expect(seen.some((p) => p.phase === 'seal')).toBe(true);
    expect(seen[0]).toMatchObject({ k: 1, count: 3, phase: 'sign', rungsDone: 0, window: [500, 509], release_round: 1000 });
  });

  it('refuses to seal when shards of one installment disagree', async () => {
    const { pool, log } = fakePool({ tamper: (k, hs) => (k === 2 && hs[0] === 503 + 4 ? { actions_digest: 'other' } : {}) });
    await expect(presignSchedule(input(pool, 3, { chunkSize: 4 }))).rejects.toThrow(/disagree/);
    expect(log.some((e) => e.op === 'seal' && e.k === 2)).toBe(false);
    expect(log.some((e) => e.op === 'seal' && e.k === 3)).toBe(false);
  });

  it('refuses a shard that spends some other note', async () => {
    const { pool } = fakePool({ tamper: (k) => (k === 1 ? { spends_nullifier: 'nf-elsewhere' } : {}) });
    await expect(presignSchedule(input(pool, 2, { chunkSize: 100 }))).rejects.toThrow(/does not spend/);
  });

  it('stops when the pocket runs out before the last installment', async () => {
    const { pool } = fakePool({ exhaustAt: 1 });
    await expect(presignSchedule(input(pool, 2))).rejects.toThrow(/exhausted after installment 1 of 2/);
  });

  it('honours an abort', async () => {
    const { pool } = fakePool();
    const ctl = new AbortController();
    const run = presignSchedule(input(pool, 3, { signal: ctl.signal, onProgress: (p) => p.phase === 'done' && ctl.abort(new Error('user left')) }));
    await expect(run).rejects.toThrow();
  });

  it('chunks evenly and sizes chunks to the pool', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(defaultChunkSize(20, 7)).toBe(4);
    expect(defaultChunkSize(161, 7)).toBe(8);
    expect(defaultChunkSize(5000, 1)).toBe(32);
  });
});

// ---------------------------------------------------------------- the pool

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: WorkerRequest) {
    this.received.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  reply(r: WorkerReply) {
    this.onmessage?.({ data: r } as MessageEvent<WorkerReply>);
  }
}

type EchoOps = { echo: { in: { v: number }; out: number } };

function fakeWorkerPool(size: number) {
  FakeWorker.all = [];
  return new WorkerPool<EchoOps>(() => new FakeWorker() as unknown as Worker, size);
}

describe('WorkerPool', () => {
  it('starts workers lazily up to its size and runs queued work by priority, then arrival', async () => {
    const pool = fakeWorkerPool(1);
    const results: number[] = [];
    const calls = [
      pool.call('echo', { v: 1 }, { priority: 5 }),
      pool.call('echo', { v: 2 }, { priority: 9 }),
      pool.call('echo', { v: 3 }, { priority: 1 }),
      pool.call('echo', { v: 4 }, { priority: 1 }),
    ].map((p) => p.then((v) => results.push(v)));
    expect(pool.started).toBe(1);
    const w = FakeWorker.all[0]!;
    for (let i = 0; i < 4; i++) {
      const m = w.received[i]!;
      w.reply({ id: m.id, ok: true, value: (m.args as { v: number }).v });
      await Promise.resolve();
    }
    await Promise.all(calls);
    // v=1 was dispatched at once; the rest waited and ran by priority, ties in order.
    expect(results).toEqual([1, 3, 4, 2]);
  });

  it('spreads work over several workers and surfaces worker errors per call', async () => {
    const pool = fakeWorkerPool(2);
    const a = pool.call('echo', { v: 1 });
    const b = pool.call('echo', { v: 2 });
    expect(FakeWorker.all).toHaveLength(2);
    const [w1, w2] = FakeWorker.all;
    w2!.reply({ id: w2!.received[0]!.id, ok: false, error: 'bad note' });
    w1!.reply({ id: w1!.received[0]!.id, ok: true, value: 10 });
    await expect(a).resolves.toBe(10);
    await expect(b).rejects.toThrow('bad note');
    expect(FakeWorker.all.some((w) => w.terminated)).toBe(false);
  });

  it('replaces a worker whose wasm instance trapped', async () => {
    const pool = fakeWorkerPool(1);
    const a = pool.call('echo', { v: 1 });
    const w = FakeWorker.all[0]!;
    w.reply({ id: w.received[0]!.id, ok: false, error: 'unreachable', fatal: true });
    await expect(a).rejects.toThrow('unreachable');
    expect(w.terminated).toBe(true);
    const b = pool.call('echo', { v: 2 });
    expect(FakeWorker.all).toHaveLength(2);
    const w2 = FakeWorker.all[1]!;
    w2.reply({ id: w2.received[0]!.id, ok: true, value: 2 });
    await expect(b).resolves.toBe(2);
  });

  it('drops queued work on abort, and fails everything on terminate', async () => {
    const pool = fakeWorkerPool(1);
    const running = pool.call('echo', { v: 1 });
    const ctl = new AbortController();
    const queued = pool.call('echo', { v: 2 }, { signal: ctl.signal });
    ctl.abort(new Error('left'));
    await expect(queued).rejects.toThrow('left');
    const later = pool.call('echo', { v: 3 });
    pool.terminate('bye');
    await expect(running).rejects.toThrow('bye');
    await expect(later).rejects.toThrow('bye');
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    expect(FakeWorker.all[0]!.received).toHaveLength(1);
    await expect(pool.call('echo', { v: 4 })).rejects.toThrow('bye');
  });

  it('gives up on a worker that cannot start, rather than respawning it', async () => {
    const pool = fakeWorkerPool(2);
    const a = pool.call('echo', { v: 1 });
    FakeWorker.all[0]!.onerror?.({ message: 'failed to load', preventDefault() {} } as unknown as ErrorEvent);
    await expect(a).rejects.toThrow(/failed to load/);
    await expect(pool.call('echo', { v: 2 })).rejects.toThrow(/failed to load/);
  });
});
