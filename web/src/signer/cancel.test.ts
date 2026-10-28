import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { PocketNoteInfo, PocketState, PocketWitness } from '../api/types';
import { NothingToCancelError, POCKET_RETRIES, readPocket, RETRY_MS, runCancel, WAIT_LIMIT_MS, type CancelSteps } from './cancel';
import type { KitNote } from './kit';
import type { CancelStatus } from './types';

const nf = (k: number) => String(k + 1).padStart(2, '0').repeat(32);
const note = (k: number, value_zat: number): KitNote => ({ k, note: `note-${k}`, nullifier: nf(k), value_zat });
// Three installments of 100,000 zats: C(k) holds what installments k+1.. still need.
const NOTES = [note(0, 330_000), note(1, 220_000), note(2, 110_000)];
const WITNESS: PocketWitness = { target_height: 1001, anchor_height: 998, anchor: 'aa'.repeat(32), position: 7, auth_path: Array(32).fill('bb'.repeat(32)) };

const NOT_DEEP = () => new ApiError(400, 'the note is not yet anchor-deep; retry in a few blocks');
const CONFLICT = () =>
  new ApiError(
    500,
    'lightwalletd rejected the transaction (-25): any transaction with the same effects will be rejected from the mempool until the next chain tip block: transaction rejected because another transaction in the mempool has already spent some of its inputs',
  );

/** A scripted runner: `pockets` and `witnesses` are answered in order (the last one repeats). */
function world(opts: { pockets: Array<{ tip: number; syncing?: boolean; notes: Array<[k: number, minedAt: number]> }>; witnesses?: Array<'ok' | 'not-deep'>; broadcasts?: Array<'ok' | ApiError> }) {
  const calls = { pocket: 0, witness: [] as string[], prove: [] as number[], broadcast: 0 };
  const statuses: CancelStatus[] = [];
  const at = <T,>(list: T[], i: number) => list[Math.min(i, list.length - 1)]!;
  const witnesses: Array<'ok' | 'not-deep'> = opts.witnesses ?? ['ok'];
  const broadcasts: Array<'ok' | ApiError> = opts.broadcasts ?? ['ok'];
  const steps: CancelSteps = {
    pocket: async () => {
      const p = at(opts.pockets, calls.pocket++);
      const notes: PocketNoteInfo[] = p.notes.map(([k, mined]) => ({ nullifier: nf(k), value_zat: NOTES[k]!.value_zat, mined_height: mined, position: k }));
      return { pocket_id: 'pkt_t', tip: p.tip, syncing: p.syncing, funding: null, notes } satisfies PocketState;
    },
    known: (n) => NOTES.find((x) => x.nullifier === n),
    witness: async (n) => {
      const w = at(witnesses, calls.witness.length);
      calls.witness.push(n);
      if (w === 'not-deep') throw NOT_DEEP();
      return WITNESS;
    },
    prove: async (n) => {
      calls.prove.push(n.k);
      return { tx_hex: `tx-${n.k}`, txid: `txid-${n.k}`, refunded_zat: n.value_zat - 10_000, fee_zat: 10_000, target_height: 1001 };
    },
    broadcast: async (hex) => {
      const b = at(broadcasts, calls.broadcast++);
      if (b !== 'ok') throw b;
      return { txid: hex.replace('tx-', 'txid-') };
    },
    count: 3,
  };
  return { steps, calls, statuses, onStatus: (s: CancelStatus) => statuses.push(s) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runCancel', () => {
  it('spends the newest note it created and returns the receipt', async () => {
    const w = world({ pockets: [{ tip: 1000, notes: [[1, 990]] }] });
    const r = await runCancel(w.steps, { onStatus: w.onStatus });
    expect(r).toMatchObject({ txid: 'txid-1', refunded_zat: 210_000, spent: 'the change from installment 1' });
    expect(w.calls.witness).toEqual([nf(1)]);
    expect(w.statuses.map((s) => s.step)).toEqual(['finding', 'proving', 'broadcasting']);
  });

  it('waits while the runner catches up with a just-mined installment instead of finding nothing', async () => {
    // Installment 2 spent C(1) while the cancel was proved; the runner has recorded it
    // as mined but not yet scanned the block with C(2).
    const w = world({
      pockets: [
        { tip: 1000, notes: [[1, 990]] },
        { tip: 1001, syncing: true, notes: [] },
        { tip: 1002, notes: [[2, 1001]] },
      ],
      broadcasts: [CONFLICT(), 'ok'],
    });
    const done = runCancel(w.steps, { onStatus: w.onStatus });
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    await expect(done).resolves.toMatchObject({ txid: 'txid-2', spent: 'the change from installment 2' });
    expect(w.calls.prove).toEqual([1, 2]);
  });

  it('waits for a fresh note to be anchor-deep, retrying every 15 s and counting blocks', async () => {
    const w = world({
      pockets: [
        { tip: 1000, notes: [[0, 1000]] },
        { tip: 1001, notes: [[0, 1000]] },
        { tip: 1002, notes: [[0, 1000]] },
      ],
      witnesses: ['not-deep', 'not-deep', 'ok'],
    });
    const done = runCancel(w.steps, { onStatus: w.onStatus });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.statuses.at(-1)).toMatchObject({ step: 'waiting', k: 0, blocks: 2 });
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(w.calls.witness).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls.witness).toHaveLength(2);
    expect(w.statuses.at(-1)).toMatchObject({ step: 'waiting', blocks: 1 });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await expect(done).resolves.toMatchObject({ txid: 'txid-0' });
    expect(w.calls.prove).toEqual([0]);
  });

  it('gives up after about 5 minutes of waiting', async () => {
    const w = world({ pockets: [{ tip: 1000, notes: [[0, 1000]] }], witnesses: ['not-deep'] });
    const done = runCancel(w.steps, { onStatus: w.onStatus });
    const check = expect(done).rejects.toThrow(/still not 3 blocks deep after 5 minutes/);
    await vi.advanceTimersByTimeAsync(WAIT_LIMIT_MS + RETRY_MS);
    await check;
    expect(w.calls.witness.length).toBe(WAIT_LIMIT_MS / RETRY_MS + 1);
    expect(w.calls.prove).toEqual([]);
  });

  it('stops waiting when aborted, and never proves or broadcasts', async () => {
    const w = world({ pockets: [{ tip: 1000, notes: [[0, 1000]] }], witnesses: ['not-deep'] });
    const ctrl = new AbortController();
    const done = runCancel(w.steps, { signal: ctrl.signal });
    const check = expect(done).rejects.toThrow('stopped by the payer');
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    ctrl.abort(new Error('stopped by the payer'));
    await vi.advanceTimersByTimeAsync(0);
    await check;
    expect(w.calls.witness).toHaveLength(3);
    expect(w.calls.prove).toEqual([]);
    expect(w.calls.broadcast).toBe(0);
  });

  it('retries once with C(k+1) when installment k+1 spent C(k) first', async () => {
    const w = world({
      pockets: [
        { tip: 1000, notes: [[0, 990]] },
        // Installment 1 landed while the cancel was being proved.
        { tip: 1001, notes: [[1, 1001]] },
        { tip: 1003, notes: [[1, 1001]] },
      ],
      witnesses: ['ok', 'not-deep', 'ok'],
      broadcasts: [CONFLICT(), 'ok'],
    });
    const done = runCancel(w.steps, { onStatus: w.onStatus });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await expect(done).resolves.toMatchObject({ txid: 'txid-1', refunded_zat: 210_000 });
    expect(w.calls.prove).toEqual([0, 1]);
    expect(w.calls.broadcast).toBe(2);
  });

  it('reports nothing left to cancel when the last installment spent the last note', async () => {
    const w = world({
      pockets: [
        { tip: 1000, notes: [[2, 990]] },
        { tip: 1001, notes: [] },
      ],
      broadcasts: [CONFLICT()],
    });
    const err = await runCancel(w.steps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NothingToCancelError);
    expect((err as NothingToCancelError).k).toBe(3);
    expect((err as Error).message).toBe('Installment 3 was released before your cancel landed: nothing is left to cancel.');
  });

  it('waits while the installment that beat it is still in the mempool', async () => {
    const w = world({
      pockets: [
        { tip: 1000, notes: [[2, 990]] },
        // The runner still lists C(2): installment 3 is unmined.
        { tip: 1000, notes: [[2, 990]] },
        { tip: 1001, notes: [] },
      ],
      broadcasts: [CONFLICT()],
    });
    const done = runCancel(w.steps, { onStatus: w.onStatus });
    const check = expect(done).rejects.toBeInstanceOf(NothingToCancelError);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.statuses.at(-1)).toMatchObject({ step: 'raced', k: 3 });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await check;
    expect(w.calls.prove).toEqual([2]);
  });

  it('surfaces a refusal that is not a spend conflict', async () => {
    const bad = new ApiError(500, 'lightwalletd rejected the transaction (-26): bad-txns-ironwood-proof');
    const w = world({ pockets: [{ tip: 1000, notes: [[1, 990]] }], broadcasts: [bad] });
    await expect(runCancel(w.steps)).rejects.toBe(bad);
    expect(w.calls.broadcast).toBe(1);
  });

  it('retries only once', async () => {
    const second = CONFLICT();
    const w = world({
      pockets: [
        { tip: 1000, notes: [[0, 990]] },
        { tip: 1001, notes: [[1, 990]] },
        { tip: 1002, notes: [[2, 990]] },
      ],
      broadcasts: [CONFLICT(), second],
    });
    await expect(runCancel(w.steps)).rejects.toBe(second);
    expect(w.calls.prove).toEqual([0, 1]);
  });

  it('does not guess when the runner could not be reached during the broadcast', async () => {
    const down = new ApiError(0, 'could not reach the runner (fetch failed)');
    const w = world({ pockets: [{ tip: 1000, notes: [[1, 990]] }], broadcasts: [down] });
    await expect(runCancel(w.steps)).rejects.toBe(down);
    expect(w.calls.pocket).toBe(1);
  });

  it('says there is nothing to cancel when the runner lists no note', async () => {
    const w = world({ pockets: [{ tip: 1000, notes: [] }] });
    await expect(runCancel(w.steps)).rejects.toBeInstanceOf(NothingToCancelError);
  });

  it('refuses notes it did not create', async () => {
    const w = world({ pockets: [{ tip: 1000, notes: [[1, 990]] }] });
    w.steps.known = () => undefined;
    await expect(runCancel(w.steps)).rejects.toThrow(/did not create/);
  });

  it('checks the txid the runner reports', async () => {
    const w = world({ pockets: [{ tip: 1000, notes: [[1, 990]] }] });
    w.steps.broadcast = async () => ({ txid: 'something-else' });
    await expect(runCancel(w.steps)).rejects.toThrow(/reported txid something-else/);
  });
});

describe('readPocket', () => {
  const STATE: PocketState = { pocket_id: 'pkt_t', tip: 1000, funding: null, notes: [] };
  const noSleep = async () => {};
  const scripted = (answers: Array<PocketState | ApiError>) => {
    let calls = 0;
    const get = async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      if (a instanceof ApiError) throw a;
      return a;
    };
    return { get, calls: () => calls };
  };

  it('asks again while the runner is unreachable, slow or failing', async () => {
    const r = scripted([new ApiError(0, 'the runner did not answer in time'), new ApiError(502, 'HTTP 502'), STATE]);
    await expect(readPocket(r.get, { retryMs: 5_000, sleep: noSleep })).resolves.toEqual(STATE);
    expect(r.calls()).toBe(3);
  });

  it('gives up after POCKET_RETRIES more tries', async () => {
    const down = new ApiError(0, 'could not reach the runner (fetch failed)');
    const r = scripted([down]);
    await expect(readPocket(r.get, { retryMs: 5_000, sleep: noSleep })).rejects.toBe(down);
    expect(r.calls()).toBe(POCKET_RETRIES + 1);
  });

  it('throws a refusal or a malformed answer at once', async () => {
    const gone = new ApiError(404, 'no such pocket');
    const r = scripted([gone]);
    await expect(readPocket(r.get, { retryMs: 5_000, sleep: noSleep })).rejects.toBe(gone);
    expect(r.calls()).toBe(1);
    const bad = scripted([{ ...STATE, tip: 0 }]);
    await expect(readPocket(bad.get, { retryMs: 5_000, sleep: noSleep })).rejects.toThrow(/malformed pocket status/);
  });

  it('stops when the watch is aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = scripted([new ApiError(0, 'could not reach the runner (aborted)'), STATE]);
    await expect(readPocket(r.get, { retryMs: 5_000, signal: ctl.signal, sleep: noSleep })).rejects.toBeInstanceOf(ApiError);
    expect(r.calls()).toBe(1);
  });
});
