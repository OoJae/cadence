/**
 * In-browser half of the WASM signer smoke test (driven by scripts/wasm-smoke.mjs,
 * which also plays the runner). The result lands in `window.__smoke`.
 *
 *   ?mode=engine&heights=20&recipient=age1…   one installment over N consecutive heights
 *       from a synthetic funding note, sealed to quicknet round 33,000,000 (public
 *       beacon), so the runner side can open it and check every signature.
 *   ?mode=signer&count=2&recipient=age1…[&cancel=1]   the real WasmSigner against
 *       the fake runner: register a pocket, decrypt the funding transaction, presign
 *       every installment over its real window, upload, and optionally cancel
 *       (proving in the browser) to a fresh testnet address. `&pool=N` overrides the
 *       pool size (default: hardwareConcurrency - 1, at most 8).
 */
import { CadenceClient } from '../../src/api/client';
import { HttpTransport } from '../../src/api/http';
import type { Offer } from '../../src/api/types';
import { QUICKNET } from '../../src/lib/drand';
import { totalPrepaidZat } from '../../src/lib/zat';
import type { PresignProgress } from '../../src/signer/types';
import { createSignerPool, WasmSigner } from '../../src/signer/wasm';
import { presignSchedule } from '../../src/signer/wasmEngine';

declare global {
  interface Window {
    __smoke?: Record<string, unknown>;
    __smokeError?: string;
  }
}

const q = new URLSearchParams(location.search);
const out = document.getElementById('out')!;
const log = (line: string) => {
  out.textContent += `${line}\n`;
};
const num = (name: string, fallback: number) => Number(q.get(name) ?? fallback);
const AMOUNT = 50_000;
/** Testnet, past NU7: rungs carry the NU7 branch and a 120-block expiry delta. */
const TIP = 4_600_000;

function sealedHeader(b64: string): { round: number; chain: string } | null {
  const head = atob(b64.slice(0, 400));
  const m = /-> tlock (\d+) ([0-9a-f]{64})/.exec(head);
  return m ? { round: Number(m[1]), chain: m[2]! } : null;
}

const sealedLength = (b64: string) => (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

async function engine() {
  const n = num('heights', 20);
  const recipient = q.get('recipient')!;
  const pool = createSignerPool();
  const t0 = performance.now();
  const pocket = await pool.call('pocket', { network: 'test' });
  const merchant = await pool.call('pocket', { network: 'test' });
  const total = await pool.call('fundingTotal', { amountZat: AMOUNT, count: 1 });
  const funding = await pool.call('synthetic', { network: 'test', seed: pocket.seed, valueZat: total });
  const heights = Array.from({ length: n }, (_, i) => TIP + 1 + i);
  const progress: PresignProgress[] = [];
  const t1 = performance.now();
  const [signed] = await presignSchedule({
    pool,
    network: 'test',
    seed: pocket.seed,
    funding,
    terms: { amount_zat: AMOUNT, count: 1, merchant_ua: merchant.ua },
    mandateId: '00112233445566778899aabbccddeeff',
    plans: [{ k: 1, release_round: 33_000_000, heights }],
    recipient,
    onProgress: (p) => progress.push(p),
  });
  const t2 = performance.now();
  const s = signed!;
  const info = await pool.call('info', {});
  pool.terminate();
  return {
    pool_size: pool.size,
    rungs: s.rungs,
    window: s.window,
    sealed: s.sealed,
    sealed_bytes: s.sealed_bytes,
    sealed_len_check: sealedLength(s.sealed),
    plaintext_bytes: s.plaintext_bytes,
    header: sealedHeader(s.sealed),
    spends_nullifier: s.spends.nullifier,
    funding_nullifier: funding.nullifier,
    change_is_null: s.change === null,
    setup_ms: t1 - t0,
    presign_ms: t2 - t1,
    per_rung_ms: (t2 - t1) / s.rungs,
    progress_phases: [...new Set(progress.map((p) => p.phase))],
    done_events: progress.filter((p) => p.phase === 'done').length,
    pocket_ua: pocket.ua,
    worker_memory_mb: info.memoryBytes / 1048576,
    build: JSON.parse(info.build),
  };
}

async function signerFlow() {
  const count = num('count', 2);
  const period = num('period', 600);
  const recipient = q.get('recipient')!;
  const api = new CadenceClient(new HttpTransport(''));
  // Stand-ins for the merchant's and the payer's own wallets: any testnet UA with an Orchard receiver.
  const helper = createSignerPool(1);
  const merchant = await helper.call('pocket', { network: 'test' });
  const refundUa = q.has('cancel') ? (await helper.call('pocket', { network: 'test' })).ua : null;
  helper.terminate();

  const signer = new WasmSigner(api, q.has('pool') ? { poolSize: num('pool', 1) } : {});
  const t0 = performance.now();
  const pocket = await signer.createPocket('test');
  log(`pocket ${pocket.pocket_id} ${pocket.ua.slice(0, 24)}…`);
  const total = totalPrepaidZat(AMOUNT, count);
  const funding = await signer.awaitFunding(total);
  log(`funded ${funding.value_zat} zats in ${funding.txid}`);
  const t1 = performance.now();
  const offer: Offer = {
    offer_id: 'off_smoke',
    name: 'Smoke test',
    amount_zat: AMOUNT,
    period_secs: period,
    count,
    merchant_ua: merchant.ua,
    runner_age_recipient: recipient,
    runner_endpoint: location.origin,
    network: 'test',
    drand_chain: QUICKNET.hash,
  };
  const done: PresignProgress[] = [];
  let events = 0;
  const sealed = await signer.presign(offer, funding, {
    onProgress: (p) => {
      events++;
      if (p.phase === 'done') {
        done.push(p);
        log(`installment ${p.k}: ${p.rungsTotal} rungs ${p.window[0]}–${p.window[1]}, sealed ${p.sealedBytes} bytes, round ${p.release_round}`);
      }
    },
  });
  const t2 = performance.now();
  const rungs = done.reduce((a, p) => a + p.rungsTotal, 0);
  log(`presigned ${rungs} rungs in ${(t2 - t1).toFixed(0)} ms`);
  const sub = await api.createSubscription({
    offer_id: offer.offer_id,
    pocket_id: pocket.pocket_id,
    pocket_ufvk: pocket.ufvk,
    birthday_height: pocket.birthday_height,
    funding_txid: funding.txid,
    installments: sealed,
  });
  let cancel: Record<string, unknown> | null = null;
  if (refundUa) {
    const tc = performance.now();
    const receipt = await signer.cancel(refundUa);
    cancel = { ...receipt, ms: performance.now() - tc };
    log(`cancelled: ${receipt.txid}, refunded ${receipt.refunded_zat}, in ${(performance.now() - tc).toFixed(0)} ms`);
  }
  signer.destroy();
  let afterDestroy = '';
  try {
    await signer.cancel(refundUa ?? merchant.ua);
  } catch (e) {
    afterDestroy = (e as Error).message;
  }
  return {
    pool_size: signer.poolSize,
    pocket_id: pocket.pocket_id,
    funding,
    setup_ms: t1 - t0,
    presign_ms: t2 - t1,
    rungs,
    per_rung_ms: (t2 - t1) / rungs,
    progress_events: events,
    installments: done.map((p) => ({ k: p.k, rungs: p.rungsTotal, window: p.window, release_round: p.release_round, sealed_bytes: p.sealedBytes })),
    sealed: sealed.map((s) => ({ k: s.k, release_round: s.release_round, bytes: sealedLength(s.sealed), header: sealedHeader(s.sealed) })),
    subscription: sub,
    cancel,
    after_destroy: afterDestroy,
  };
}

(async () => {
  try {
    const mode = q.get('mode') ?? 'engine';
    log(`mode ${mode}, hardwareConcurrency ${navigator.hardwareConcurrency}, crossOriginIsolated ${self.crossOriginIsolated}`);
    window.__smoke = { mode, userAgent: navigator.userAgent, ...(mode === 'signer' ? await signerFlow() : await engine()) };
    log('ok');
  } catch (e) {
    window.__smokeError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log(`FAILED ${window.__smokeError}`);
  }
})();
