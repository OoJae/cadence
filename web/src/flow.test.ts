import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, uploadTimeoutMs, type CadenceClient } from './api/client';
import type { Offer } from './api/types';
import { canRetrySigning, canRetryUpload, canWatchAgain, retrySigning, retryUpload, runMandate, watchAgain, type FlowState } from './flow';
import { SignerError, type Signer } from './signer/types';

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

describe('a plan past the horizon', () => {
  it('is refused before any pocket exists', async () => {
    const signer = { createPocket: vi.fn() } as unknown as Signer;
    const patches: Partial<FlowState>[] = [];
    await runMandate({ ...offer, period_secs: 2_592_000, count: 3 }, signer, (p) => patches.push(p));
    expect(signer.createPocket).not.toHaveBeenCalled();
    expect(patches).toEqual([{ phase: 'error', error: expect.stringMatching(/cannot yet seal a payment due more than 45 days/) }]);
  });
});

describe('signing again after a failed signing', () => {
  const paid: FlowState = { ...held, sealed: undefined };

  it('is offered only for a funded pocket with nothing sealed', () => {
    expect(canRetrySigning(paid)).toBe(true);
    expect(canRetrySigning({ ...paid, funding: undefined })).toBe(false);
    expect(canRetrySigning(held)).toBe(false);
    expect(canRetrySigning({ ...paid, subscriptionId: 'sub_t' })).toBe(false);
  });

  it('pre-signs against the same pocket and funding, then uploads', async () => {
    const sealed = [{ k: 1, release_round: 10, sealed: 'AAAA' }];
    const signer = { presign: vi.fn(async () => sealed) } as unknown as Signer;
    const api = { createSubscription: vi.fn(async () => ({ subscription_id: 'sub_t', status: 'active' })) } as unknown as CadenceClient;
    const patches: Partial<FlowState>[] = [];
    await retrySigning(offer, signer, paid, (p) => patches.push(p), { api });
    expect(signer.presign).toHaveBeenCalledWith(offer, paid.funding, expect.anything());
    expect(api.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ pocket_id: 'pkt_t', funding_txid: paid.funding!.txid, installments: sealed }), undefined);
    expect(patches[0]).toMatchObject({ phase: 'signing', error: undefined, finished: [] });
    expect(patches.at(-1)).toEqual({ subscriptionId: 'sub_t', phase: 'done' });
  });

  it('lands back in the error state if signing fails again', async () => {
    const signer = { presign: vi.fn(async () => { throw new Error('a signer worker failed'); }) } as unknown as Signer;
    const patches: Partial<FlowState>[] = [];
    await retrySigning(offer, signer, paid, (p) => patches.push(p));
    expect(patches.at(-1)).toEqual({ phase: 'error', error: 'a signer worker failed' });
  });
});

describe('watching again after the funding watch failed', () => {
  const unpaid: FlowState = { phase: 'error', pocket: held.pocket, totalZat: 440_000, error: 'could not reach the runner' };

  it('is offered for a pocket whose payment has not been seen', () => {
    expect(canWatchAgain(unpaid)).toBe(true);
    expect(canWatchAgain({ ...unpaid, funding: held.funding })).toBe(false);
    expect(canWatchAgain({ ...unpaid, pocket: undefined })).toBe(false);
  });

  it('is not offered after the signer refused the payment it saw, which would repeat', async () => {
    const underpaid = 'the pocket received 400000 zats; this schedule needs 440000 (installments plus fees)';
    const signer = { awaitFunding: vi.fn(async () => { throw new SignerError(underpaid); }) } as unknown as Signer;
    const patches: Partial<FlowState>[] = [];
    await watchAgain(offer, signer, unpaid, (p) => patches.push(p));
    expect(patches.at(-1)).toEqual({ phase: 'error', error: underpaid, refused: true });
    const after = Object.assign({}, unpaid, ...patches) as FlowState;
    expect(canWatchAgain(after)).toBe(false);
  });

  it('watches the same pocket for the same amount, then signs and uploads', async () => {
    const funding = { txid: 'bb'.repeat(32), value_zat: 440_000, status: 'mined' as const, mined_height: 5 };
    const sealed = [{ k: 1, release_round: 10, sealed: 'AAAA' }];
    const signer = { awaitFunding: vi.fn(async () => funding), presign: vi.fn(async () => sealed) } as unknown as Signer;
    const api = { createSubscription: vi.fn(async () => ({ subscription_id: 'sub_w', status: 'active' })) } as unknown as CadenceClient;
    const patches: Partial<FlowState>[] = [];
    await watchAgain(offer, signer, unpaid, (p) => patches.push(p), { api });
    expect(signer.awaitFunding).toHaveBeenCalledWith(440_000, expect.anything());
    expect(patches[0]).toEqual({ phase: 'funding', error: undefined });
    expect(patches[1]).toEqual({ funding, phase: 'signing' });
    expect(patches.at(-1)).toEqual({ subscriptionId: 'sub_w', phase: 'done' });
  });
});
