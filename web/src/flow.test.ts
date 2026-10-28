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

  it('wait out a busy runner, as long as it asks, then try again', async () => {
    let n = 0;
    const api = {
      createSubscription: vi.fn(async () => {
        if (n++ === 0) throw new ApiError(429, 'The runner is busy; try again in 12 s', 12);
        return { subscription_id: 'sub_t', status: 'active' };
      }),
    } as unknown as CadenceClient;
    const patches: Partial<FlowState>[] = [];
    const done = retryUpload(offer, held, (p) => patches.push(p), { api });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(api.createSubscription).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(api.createSubscription).toHaveBeenCalledTimes(2);
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

describe('the payer auth key in the upload', () => {
  const KEY = 'ab'.repeat(32);
  const oldBody = {
    offer_id: 'off_t',
    pocket_id: 'pkt_t',
    pocket_ufvk: 'uviewtest1x',
    birthday_height: 100,
    funding_txid: 'aa'.repeat(32),
    installments: held.sealed,
  };
  const runner = (status: () => Promise<unknown>) => {
    const bodies: unknown[] = [];
    const api = {
      status: vi.fn(status),
      createSubscription: vi.fn(async (body: unknown) => (bodies.push(body), { subscription_id: 'sub_k', status: 'active' })),
    } as unknown as CadenceClient;
    return { api, bodies };
  };

  it('is added when the runner lists payer_auth', async () => {
    const { api, bodies } = runner(async () => ({ network: 'test', features: ['payer_auth', 'pass'] }));
    await retryUpload(offer, { ...held, payerAuthKey: KEY }, () => {}, { api });
    expect(bodies).toEqual([{ ...oldBody, payer_auth_key: KEY }]);
  });

  it('is left out, byte for byte, for a runner without the feature or without features at all', async () => {
    for (const status of [{ network: 'test', features: ['pass'] }, { network: 'test', tip: 1, drand_round: 1, subscriptions: 0 }]) {
      const { api, bodies } = runner(async () => status);
      await retryUpload(offer, { ...held, payerAuthKey: KEY }, () => {}, { api });
      expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(oldBody));
    }
  });

  it('is left out when the status does not answer, and the upload goes on', async () => {
    const { api, bodies } = runner(async () => {
      throw new ApiError(0, 'could not reach the runner');
    });
    const patches: Partial<FlowState>[] = [];
    await retryUpload(offer, { ...held, payerAuthKey: KEY }, (p) => patches.push(p), { api });
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(oldBody));
    expect(patches.at(-1)).toEqual({ subscriptionId: 'sub_k', phase: 'done' });
  });

  it('comes from the signer after signing, and the runner is not asked about features without one', async () => {
    const sealed = held.sealed!;
    const signer = { presign: vi.fn(async () => sealed), payerAuth: vi.fn(async () => ({ publicKeyHex: KEY, sign: vi.fn() })) } as unknown as Signer;
    const { api, bodies } = runner(async () => ({ network: 'test', features: ['payer_auth'] }));
    const patches: Partial<FlowState>[] = [];
    await retrySigning(offer, signer, { ...held, sealed: undefined }, (p) => patches.push(p), { api });
    expect(patches).toContainEqual(expect.objectContaining({ phase: 'uploading', payerAuthKey: KEY }));
    expect(bodies).toEqual([{ ...oldBody, payer_auth_key: KEY }]);

    const bare = runner(async () => ({ network: 'test', features: ['payer_auth'] }));
    await retryUpload(offer, held, () => {}, { api: bare.api });
    expect(bare.api.status).not.toHaveBeenCalled();
    expect(JSON.stringify(bare.bodies[0])).toBe(JSON.stringify(oldBody));
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
