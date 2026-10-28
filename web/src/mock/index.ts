/**
 * The mock world for VITE_API=mock: one chain, one runner, a transport that routes
 * the typed client's requests to it, and the ledger the MockSigner uses. Loaded with
 * a dynamic import, so builds pointed at a real runner never fetch it.
 */
import { ApiError, type ApiRequest, type Transport } from '../api/client';
import type { MockLedger } from '../signer/mock';
import { nowSecs } from '../lib/time';
import { MockChain, MOCK_BLOCK_SECS } from './chain';
import { seedMockRunner } from './fixtures';
import { HttpError, MockRunner } from './runner';

export { DEMO_MERCHANT_UA } from './fixtures';
export { MOCK_BLOCK_SECS } from './chain';

const appOrigin = typeof location !== 'undefined' ? location.origin : 'http://localhost:5173';

export const chain = new MockChain(nowSecs());
export const runner = new MockRunner(chain, nowSecs, appOrigin);
seedMockRunner(runner, chain, nowSecs());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Routes `/api/...` requests to the in-memory runner, with network-like latency and copying. */
export class MockTransport implements Transport {
  readonly label = 'in-page mock runner';

  async request<T>(req: ApiRequest): Promise<T> {
    await sleep(req.path === '/api/status' ? 60 : 120 + Math.random() * 180);
    if (req.signal?.aborted) throw new ApiError(0, 'aborted');
    try {
      // The text an HTTP transport would send: payer signatures cover it.
      const raw = req.body === undefined ? '' : JSON.stringify(req.body);
      const body = req.body === undefined ? undefined : JSON.parse(raw);
      const result = await this.#route(req.method, req.path, body, req.token, req.headers ?? {}, raw);
      return JSON.parse(JSON.stringify(result)) as T;
    } catch (e) {
      if (e instanceof HttpError) throw new ApiError(e.status, e.message);
      throw e;
    }
  }

  #route(method: string, path: string, body: unknown, token: string | undefined, headers: Record<string, string>, raw: string): unknown {
    const seg = path.split('/').filter(Boolean); // ['api', ...]
    if (seg[0] !== 'api') throw new HttpError(404, 'not found');
    const [, a, b, c] = seg;
    if (method === 'GET' && a === 'status' && !b) return runner.status();
    if (method === 'POST' && a === 'offers' && !b) return runner.createOffer(body, token);
    if (method === 'GET' && a === 'offers' && b && !c) return runner.getOffer(decodeURIComponent(b));
    if (method === 'POST' && a === 'subscriptions' && !b) return runner.createSubscription(body);
    if (method === 'GET' && a === 'subscriptions' && !b) return runner.listSubscriptions();
    if (method === 'GET' && a === 'subscriptions' && b && !c) return runner.getSubscription(decodeURIComponent(b));
    if (method === 'POST' && a === 'subscriptions' && b && c === 'stop') return runner.stop(decodeURIComponent(b), token);
    if (method === 'POST' && a === 'subscriptions' && b && c === 'pass') return runner.issuePass(decodeURIComponent(b), headers, raw, path);
    if (method === 'GET' && a === 'passes' && b === 'key' && !c) return runner.passKey();
    if (method === 'POST' && a === 'passes' && b === 'verify' && !c) return runner.verifyPass(body);
    if (method === 'GET' && a === 'decode' && b && !c) return runner.decode(b);
    if (method === 'POST' && a === 'sandbox' && b === 'fund') return runner.fund(body);
    if (method === 'POST' && a === 'sandbox' && b === 'cheat') return runner.cheat(body);
    throw new HttpError(404, `no route for ${method} ${path}`);
  }
}

export const transport = new MockTransport();

export const ledger: MockLedger = {
  now: nowSecs,
  tip: () => chain.tipAt(nowSecs()),
  blockSecs: MOCK_BLOCK_SECS,
  paymentsTo: (ua) => chain.paymentsTo(ua),
  pocketBalance: (ufvk) => runner.pocketBalance(ufvk),
  registerPackage: (sealed, window) => runner.registerPackage(sealed, window),
  broadcastCancel: (pocketUfvk, refundUa, valueZat) => {
    const tx = chain.send({ kind: 'cancel', to: refundUa, value_zat: valueZat, spends_pocket: pocketUfvk }, nowSecs());
    return { txid: tx.txid, target_height: tx.target_height };
  },
};

/** Simulates the payer paying the pocket QR from Zodl (mock only). */
export function simulateWalletPayment(ua: string, valueZat: number): { txid: string } {
  const tx = chain.send({ kind: 'wallet', to: ua, value_zat: valueZat }, nowSecs());
  return { txid: tx.txid };
}

export function provenanceOf(subscriptionId: string): string | undefined {
  return runner.subs.get(subscriptionId)?.provenance;
}

export function offerNameOf(offerId: string): string | undefined {
  return runner.offers.get(offerId)?.name;
}
