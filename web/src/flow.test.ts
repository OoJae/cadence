import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, uploadTimeoutMs, type CadenceClient } from './api/client';
import type { Offer } from './api/types';
import { canRetryUpload, retryUpload, type FlowState } from './flow';

const offer = { offer_id: 'off_t', network: 'test', amount_zat: 100_000, count: 4, name: 'Weekly' } as unknown as Offer;
const held: FlowState = {
  phase: 'error',
  pocket: { network: 'test', ua: 'utest1pocket', ufvk: 'uviewtest1x', birthday_height: 100, pocket_id: 'pkt_t' },
  funding: { txid: 'aa'.repeat(32) } as FlowState['funding'],
  sealed: [{ k: 1, release_round: 10, sealed: 'AAAA' }],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('uploads', () => {
  it('allow more time for larger uploads, within bounds', () => {
    expect(uploadTimeoutMs([{ sealed: 'x'.repeat(1_000) }])).toBe(30_030);
    expect(uploadTimeoutMs([{ sealed: 'x'.repeat(7_000_000) }])).toBe(240_000);
    expect(uploadTimeoutMs([{ sealed: 'x'.repeat(100_000_000) }])).toBe(600_000);
  });

  it('retry after a timeout and keep the subscription the runner made', async () => {
    const calls: unknown[] = [];
    const api = {
      createSubscription: vi.fn(async (body: unknown) => {
        calls.push(body);
        if (calls.length === 1) throw new ApiError(0, 'the runner did not answer in time');
        return { subscription_id: 'sub_t', status: 'active' };
      }),
    } as unknown as CadenceClient;
    const patches: Partial<FlowState>[] = [];
    const done = retryUpload(offer, held, (p) => patches.push(p), { api });
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(calls).toHaveLength(2);
    expect(patches.at(-1)).toEqual({ subscriptionId: 'sub_t', phase: 'done' });
  });

  it('do not retry a refusal', async () => {
    const api = { createSubscription: vi.fn(async () => { throw new ApiError(400, 'installment 2 releases too late'); }) } as unknown as CadenceClient;
    const patches: Partial<FlowState>[] = [];
    await retryUpload(offer, held, (p) => patches.push(p), { api });
    expect(api.createSubscription).toHaveBeenCalledTimes(1);
    expect(patches.at(-1)).toMatchObject({ phase: 'error', error: 'installment 2 releases too late' });
  });

  it('offer a retry only when signed packages are waiting', () => {
    expect(canRetryUpload(held)).toBe(true);
    expect(canRetryUpload({ ...held, sealed: undefined })).toBe(false);
    expect(canRetryUpload({ ...held, subscriptionId: 'sub_t' })).toBe(false);
  });
});
