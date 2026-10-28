import { describe, expect, it } from 'vitest';
import { ApiError, CadenceClient, type ApiRequest, type Transport } from '../api/client';
import type { RunnerStatus, Subscription } from '../api/types';
import { checkPocketState, runCancel } from '../signer/cancel';
import type { KitNote } from '../signer/kit';
import { certify } from './certificate';
import { REFUND_AFTER_STOP, refundRoute } from './refund';

const TXID = 'cc'.repeat(32);
const nf = (k: number) => String(k + 1).padStart(2, '0').repeat(32);

const sub = (extra: Partial<Subscription> = {}): Subscription => ({
  subscription_id: 'sub_t',
  offer_id: 'off_t',
  status: 'stopped',
  created_at: 1_793_000_000,
  funding: { txid: 'aa'.repeat(32), mined_height: 990, amount_zat: 330_000 },
  installments: [
    { k: 1, amount_zat: 100_000, release_round: 1, release_at: 1, state: 'mined', txid: 'bb'.repeat(32), mined_height: 995 },
    { k: 2, amount_zat: 100_000, release_round: 2, release_at: 2, state: 'cancelled' },
    { k: 3, amount_zat: 100_000, release_round: 3, release_at: 3, state: 'cancelled' },
  ],
  ...extra,
});
const v2: Pick<RunnerStatus, 'features'> = { features: ['trial', REFUND_AFTER_STOP] };

describe('refund after a stop or a miss: what /manage offers', () => {
  it('refunds in the browser only when the runner lists the feature and says a note is left', () => {
    expect(refundRoute(v2, sub({ refundable: true }))).toEqual({ kind: 'refund' });
    expect(refundRoute(v2, sub({ status: 'stalled', refundable: true }))).toEqual({ kind: 'refund' });
    expect(refundRoute(v2, sub({ refundable: false }))).toEqual({ kind: 'none' });
    expect(refundRoute(v2, sub())).toEqual({ kind: 'none' });
    // Not an early end: a live plan is cancelled, and a finished one has nothing to refund.
    for (const status of ['active', 'completed', 'cancelled'] as const) expect(refundRoute(v2, sub({ status, refundable: true }))).toEqual({ kind: 'none' });
    expect(refundRoute(v2, undefined)).toEqual({ kind: 'none' });
    expect(refundRoute(undefined, sub({ refundable: true }))).toEqual({ kind: 'none' });
  });

  it('keeps the CLI sweep for an old runner: no features field, and no refundable on its subscriptions', () => {
    // Build 7244e6a's /api/status and a stopped subscription as it reports one.
    const old = { network: 'main', tip: 3_600_000, drand_round: 1, subscriptions: 1 } as RunnerStatus;
    expect(refundRoute(old, sub())).toEqual({ kind: 'none' });
    // A runner that does not list the feature is not believed, whatever its subscriptions say.
    expect(refundRoute({ features: ['trial'] }, sub({ refundable: true }))).toEqual({ kind: 'none' });
    expect(refundRoute({ features: [] }, sub({ refund: { txid: TXID, mined_height: 1003 } }))).toEqual({ kind: 'none' });
  });

  it('says when the runner has seen the refund, and ignores a malformed one', () => {
    expect(refundRoute(v2, sub({ refund: { txid: TXID, mined_height: 1003 } }))).toEqual({ kind: 'refunded', txid: TXID, mined_height: 1003 });
    expect(refundRoute(v2, sub({ refundable: true, refund: { txid: 'nope', mined_height: 1003 } }))).toEqual({ kind: 'refund' });
    expect(refundRoute(v2, sub({ refund: { txid: TXID, mined_height: 0 } }))).toEqual({ kind: 'none' });
  });
});

/**
 * A v2 runner that kept a stopped subscription's pocket: one note left, C(1), until a
 * refund spends it; then it reports the refund and forgets the pocket.
 */
function keptPocketRunner() {
  const C1: KitNote = { k: 1, note: 'note-1', nullifier: nf(1), value_zat: 220_000 };
  let refunded: string | null = null;
  const requests: string[] = [];
  const transport: Transport = {
    label: 'fake v2 runner',
    async request<T>(req: ApiRequest): Promise<T> {
      requests.push(`${req.method} ${req.path}`);
      const reply = (v: unknown) => v as T;
      if (req.method === 'GET' && req.path === '/api/status') return reply({ network: 'test', tip: 1004, drand_round: 1, subscriptions: 1, features: [REFUND_AFTER_STOP] });
      if (req.method === 'GET' && req.path === '/api/subscriptions/sub_t') return reply(refunded ? sub({ refund: { txid: refunded, mined_height: 1005 } }) : sub({ refundable: true }));
      if (req.method === 'GET' && req.path === '/api/pockets/pkt_t') {
        return reply({ pocket_id: 'pkt_t', tip: 1004, funding: null, notes: refunded ? [] : [{ nullifier: C1.nullifier, value_zat: C1.value_zat, mined_height: 995, position: 4 }] });
      }
      if (req.method === 'GET' && req.path === `/api/pockets/pkt_t/witness?nullifier=${C1.nullifier}`) {
        return reply({ target_height: 1005, anchor_height: 1001, anchor: 'dd'.repeat(32), position: 4, auth_path: Array(32).fill('ee'.repeat(32)) });
      }
      if (req.method === 'POST' && req.path === '/api/broadcast') {
        refunded = TXID;
        return reply({ txid: TXID });
      }
      throw new ApiError(404, `no route for ${req.method} ${req.path}`);
    },
  };
  return { client: new CadenceClient(transport), C1, requests };
}

describe('refund after a stop, against a fake v2 runner', () => {
  it('refunds what is left with the cancel machinery, then sees the runner report it', async () => {
    const { client, C1, requests } = keptPocketRunner();
    const status = await client.status();
    expect(refundRoute(status, await client.getSubscription('sub_t'))).toEqual({ kind: 'refund' });

    // What the WASM signer's cancel() hands runCancel, with a stand-in prover.
    const receipt = await runCancel({
      pocket: async (signal) => checkPocketState(await client.getPocket('pkt_t', signal)),
      known: (n) => (n === C1.nullifier ? C1 : undefined),
      witness: (n, signal) => client.getPocketWitness('pkt_t', n, signal),
      prove: async (note, w) => ({ tx_hex: 'ab'.repeat(40), txid: TXID, refunded_zat: note.value_zat - 10_000, fee_zat: 10_000, target_height: w.target_height }),
      broadcast: (txHex) => client.broadcast({ tx_hex: txHex }),
      count: 3,
    });
    expect(receipt).toMatchObject({ txid: TXID, refunded_zat: 210_000, spent: 'the change from installment 1', spent_k: 1, spent_nullifier: C1.nullifier });
    expect(requests).toEqual(['GET /api/status', 'GET /api/subscriptions/sub_t', 'GET /api/pockets/pkt_t', `GET /api/pockets/pkt_t/witness?nullifier=${C1.nullifier}`, 'POST /api/broadcast']);

    expect(refundRoute(status, await client.getSubscription('sub_t'))).toEqual({ kind: 'refunded', txid: TXID, mined_height: 1005 });
    // The certificate, once the decoder shows the refund revealing C(1)'s nullifier.
    const cert = certify(receipt, { mined_height: 1005, ironwood_nullifiers: [C1.nullifier] }, { network: 'test', subscription_id: 'sub_t', count: 3, runner: 'fake v2 runner' }, 1_793_000_100);
    expect(cert).toMatchObject({ cancel_txid: TXID, mined_height: 1005, spent_k: 1, returned_zat: 210_000, void_installments: [2, 3] });
  });
});
