/**
 * WasmSigner: the real payer signer, cadence-core compiled to WebAssembly
 * (crates/cadence-wasm) and run in a pool of module Web Workers.
 *
 * - Keys: the pocket seed is 32 random bytes from crypto.getRandomValues, made in
 *   a worker and kept here in a private Uint8Array. Nothing is written to any
 *   browser storage, and destroy() zeroises the seed and terminates every worker.
 *   Custody is therefore 'memory': cancelling needs this tab. (Sealing the seed
 *   under a passkey so the payer can come back is not built yet.)
 * - Chain access: none of its own. The runner watches the pocket from its UFVK
 *   (`POST /api/pockets`) and relays the raw funding transaction, which the
 *   worker decrypts with the pocket key; amounts are never taken on trust.
 * - Presign: each installment's window of candidate heights is sharded across the
 *   pool, the shards are checked to agree, and the ladder is sealed (age to the
 *   runner, tlock to its drand round) in a worker. The flow then uploads the
 *   packages with `POST /api/subscriptions`.
 * - Cancel: signs a spend of the live pocket note back to the payer in the pool,
 *   and proves it in a dedicated prover worker (its proving key starts building
 *   the moment cancel() is called), then `POST /api/broadcast`.
 *
 * All wasm and worker scripts are served from this origin (/wasm/, from src/wasm, and the
 * bundle); the only network peer is the configured runner.
 */
import type { CadenceClient } from '../api/client';
import type { Offer, PocketState, PocketWitness, SealedInstallment } from '../api/types';
import { isUnifiedAddress } from '../lib/addresses';
import { QUICKNET } from '../lib/drand';
import { firstReleaseLead } from '../lib/schedule';
import { nowSecs } from '../lib/time';
import { INSTALLMENT_FEE_ZAT, totalPrepaidZat, type NetworkId } from '../lib/zat';
import { SignerError, type CancelReceipt, type FundingTx, type PocketInfo, type PresignOptions, type Signer } from './types';
import { presignSchedule, type InstallmentPlan } from './wasmEngine';
import { moduleWorker, WorkerPool, defaultPoolSize } from './wasmPool';
import type { ProverOps, SignerOps, WasmNote } from './wasmTypes';
import signerWorkerUrl from './wasmWorker.ts?worker&url';
import proverWorkerUrl from './proverWorker.ts?worker&url';

export function createSignerPool(size: number = defaultPoolSize()): WorkerPool<SignerOps> {
  let n = 0;
  return new WorkerPool<SignerOps>(() => moduleWorker(signerWorkerUrl, `cadence-signer-${++n}`), size);
}

export function createProver(): WorkerPool<ProverOps> {
  return new WorkerPool<ProverOps>(() => moduleWorker(proverWorkerUrl, 'cadence-prover'), 1);
}

const POLL_MS = 5_000;
const HEX = /^[0-9a-f]+$/;

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/** Resolves when the tab is visible: background tabs do not poll. */
function whenVisible(signal?: AbortSignal): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', done);
      resolve();
    };
    document.addEventListener('visibilitychange', done);
    signal?.addEventListener('abort', () => (document.removeEventListener('visibilitychange', done), reject(signal.reason)), { once: true });
  });
}

const isHeight = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

function checkPocketState(s: PocketState): PocketState {
  if (!s || !isHeight(s.tip) || !Array.isArray(s.notes)) throw new SignerError('the runner sent a malformed pocket status');
  if (s.funding && (typeof s.funding.tx_hex !== 'string' || !HEX.test(s.funding.tx_hex) || !isHeight(s.funding.mined_height))) {
    throw new SignerError('the runner sent a malformed funding transaction');
  }
  return s;
}

function checkWitness(w: PocketWitness): PocketWitness {
  const h32 = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  if (!w || !isHeight(w.target_height) || !h32(w.anchor) || !Number.isSafeInteger(w.position) || w.position < 0 || !Array.isArray(w.auth_path) || w.auth_path.length !== 32 || !w.auth_path.every(h32)) {
    throw new SignerError('the runner sent a malformed witness');
  }
  return w;
}

/** A pocket note this signer created (the funding note, or C(k) after installment k). */
interface KnownNote extends WasmNote {
  /** 0 for the funding note. */
  k: number;
}

export class WasmSigner implements Signer {
  readonly implementation = 'wasm' as const;
  readonly keyCustody = 'memory' as const;
  readonly #api: CadenceClient;
  readonly #poolSize: number;
  #pool: WorkerPool<SignerOps> | null = null;
  #prover: WorkerPool<ProverOps> | null = null;
  #seed: Uint8Array | null = null;
  #pocket: PocketInfo | null = null;
  #funding: (WasmNote & { txid: string; mined_height: number }) | null = null;
  #notes = new Map<string, KnownNote>();
  #presigned = false;
  #cancelled = false;
  #destroyed = false;

  constructor(api: CadenceClient, opts: { poolSize?: number } = {}) {
    this.#api = api;
    this.#poolSize = opts.poolSize ?? defaultPoolSize();
  }

  get pocket(): PocketInfo | null {
    return this.#pocket;
  }

  /** Workers in the signing pool. */
  get poolSize(): number {
    return this.#poolSize;
  }

  #alive(): void {
    if (this.#destroyed) throw new SignerError('this signer was destroyed and holds no keys');
  }

  #workers(): WorkerPool<SignerOps> {
    this.#pool ??= createSignerPool(this.#poolSize);
    return this.#pool;
  }

  #key(): { pocket: PocketInfo; seed: Uint8Array } {
    this.#alive();
    if (!this.#pocket || !this.#seed) throw new SignerError('create a pocket first');
    return { pocket: this.#pocket, seed: this.#seed };
  }

  async createPocket(network: NetworkId): Promise<PocketInfo> {
    this.#alive();
    if (this.#pocket || this.#seed) throw new SignerError('this signer already holds a pocket; pockets are single-use');
    const made = await this.#workers().call('pocket', { network });
    this.#alive();
    this.#seed = made.seed;
    const reg = await this.#api.registerPocket({ pocket_ufvk: made.ufvk });
    if (!reg || typeof reg.pocket_id !== 'string' || !isHeight(reg.birthday_height)) throw new SignerError('the runner did not register the pocket');
    this.#pocket = { network, ua: made.ua, ufvk: made.ufvk, birthday_height: reg.birthday_height, pocket_id: reg.pocket_id };
    return this.#pocket;
  }

  async awaitFunding(expectedZat: number, opts: { signal?: AbortSignal } = {}): Promise<FundingTx> {
    const { pocket, seed } = this.#key();
    for (;;) {
      await whenVisible(opts.signal);
      const state = checkPocketState(await this.#api.getPocket(pocket.pocket_id!, opts.signal));
      if (state.funding) {
        const { txid, tx_hex, mined_height } = state.funding;
        const note = await this.#workers().call('funding', { network: pocket.network, seed, txHex: tx_hex, height: mined_height }, { signal: opts.signal });
        if (note.value_zat < expectedZat) {
          throw new SignerError(`the pocket received ${note.value_zat} zats; this schedule needs ${expectedZat} (installments plus fees)`);
        }
        this.#funding = { ...note, txid, mined_height };
        this.#notes.set(note.nullifier, { ...note, k: 0 });
        return { txid, value_zat: note.value_zat, status: 'mined', mined_height };
      }
      await sleep(POLL_MS, opts.signal);
    }
  }

  async presign(offer: Offer, fundingTx: FundingTx, opts: PresignOptions = {}): Promise<SealedInstallment[]> {
    const { pocket, seed } = this.#key();
    if (this.#presigned) throw new SignerError('this pocket is already pre-signed; pockets are single-use');
    const funding = this.#funding;
    if (!funding || funding.txid !== fundingTx.txid) throw new SignerError('wait for the funding transaction first');
    if (offer.network !== pocket.network) throw new SignerError('the offer is for a different network than the pocket');
    if (offer.drand_chain !== QUICKNET.hash) throw new SignerError('the offer is not time-locked to drand quicknet');
    const need = totalPrepaidZat(offer.amount_zat, offer.count);
    if (funding.value_zat < need) {
      throw new SignerError(`the pocket holds ${funding.value_zat} zats; this schedule needs ${need} (installments plus fees)`);
    }

    const pool = this.#workers();
    const signedAt = Math.floor(opts.signedAt ?? nowSecs());
    const state = checkPocketState(await this.#api.getPocket(pocket.pocket_id!, opts.signal));
    const now = Math.floor(nowSecs());
    const lead = firstReleaseLead(offer.period_secs);
    const plans: InstallmentPlan[] = await Promise.all(
      Array.from({ length: offer.count }, async (_, i) => {
        const at = signedAt + lead + i * offer.period_secs;
        const [release_round, heights] = await Promise.all([
          pool.call('round', { unixSecs: at }, { priority: -1 }),
          pool.call('window', { network: pocket.network, tip: state.tip, now, at }, { priority: -1 }),
        ]);
        return { k: i + 1, release_round, heights };
      }),
    );

    const mandateId = hexOf(crypto.getRandomValues(new Uint8Array(16)));
    const signed = await presignSchedule({
      pool,
      network: pocket.network,
      seed,
      funding,
      terms: { amount_zat: offer.amount_zat, count: offer.count, merchant_ua: offer.merchant_ua },
      mandateId,
      plans,
      recipient: offer.runner_age_recipient,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    for (const s of signed) if (s.change) this.#notes.set(s.change.nullifier, { ...s.change, k: s.k });
    this.#presigned = true;
    return signed.map((s) => ({ k: s.k, release_round: s.release_round, sealed: s.sealed }));
  }

  async cancel(refundUa: string): Promise<CancelReceipt> {
    const { pocket, seed } = this.#key();
    if (this.#cancelled) throw new SignerError('this pocket has already been cancelled');
    const ua = refundUa.trim();
    if (!isUnifiedAddress(ua, pocket.network)) {
      throw new SignerError(`the refund address must be a ${pocket.network === 'main' ? 'mainnet (u1…)' : 'testnet (utest1…)'} unified address`);
    }
    if (ua === pocket.ua) throw new SignerError('refund to an address of your own wallet, not to the pocket');

    // Building the proving key takes seconds; start it while we talk to the runner.
    const prover = (this.#prover ??= createProver());
    const warm = prover.call('warmUp', {});
    warm.catch(() => {});
    try {
      const state = checkPocketState(await this.#api.getPocket(pocket.pocket_id!));
      const live = state.notes
        .map((n) => this.#notes.get(String(n.nullifier).toLowerCase()))
        .filter((n): n is KnownNote => !!n)
        .sort((a, b) => b.k - a.k)[0];
      if (!live) {
        if (!state.notes.length) throw new SignerError('nothing is left in the pocket to refund: every installment has been paid');
        throw new SignerError('the runner reports pocket notes this signer did not create');
      }
      if (live.value_zat <= INSTALLMENT_FEE_ZAT) throw new SignerError('nothing is left in the pocket to refund');

      const witness = checkWitness(await this.#api.getPocketWitness(pocket.pocket_id!, live.nullifier));
      const built = await this.#workers().call('cancel', { network: pocket.network, seed, note: live.note, refundUa: ua, targetHeight: witness.target_height });
      await warm;
      const proved = await prover.call('prove', { pczt: built.pczt, anchor: witness.anchor, position: witness.position, authPath: witness.auth_path });
      const res = await this.#api.broadcast({ tx_hex: proved.tx_hex });
      if (!res || res.txid !== proved.txid) {
        throw new SignerError(`the runner reported txid ${res?.txid ?? '(none)'} for the cancel, whose txid is ${proved.txid}`);
      }
      this.#cancelled = true;
      return { txid: proved.txid, refunded_zat: built.refunded_zat, fee_zat: built.fee_zat, target_height: built.target_height };
    } finally {
      // The prover holds no key, but it holds a lot of memory.
      prover.terminate('the cancel is finished');
      this.#prover = null;
    }
  }

  destroy(): void {
    this.#seed?.fill(0);
    this.#seed = null;
    this.#notes.clear();
    this.#funding = null;
    this.#pool?.terminate();
    this.#pool = null;
    this.#prover?.terminate();
    this.#prover = null;
    this.#destroyed = true;
  }
}
