/**
 * WasmSigner: the real payer signer, cadence-core compiled to WebAssembly
 * (crates/cadence-wasm) and run in a pool of module Web Workers.
 *
 * - Keys: the pocket seed is 32 random bytes from crypto.getRandomValues, made in
 *   a worker and kept here in a private Uint8Array. Nothing is written to any
 *   browser storage, and destroy() zeroises the seed and terminates every worker.
 *   Custody is therefore 'memory'. To cancel after closing the tab, the payer saves
 *   a cancel key: sealKit() has a worker write the seed, schedule and notes into the
 *   kit JSON and encrypt it to a passphrase (age scrypt), and the page downloads the
 *   ciphertext. verifyKit() has the payer prove the saved file opens this pocket
 *   before they close the tab; openKit() and restore() load it back into a fresh
 *   signer.
 * - Chain access: none of its own. The runner watches the pocket from its UFVK
 *   (`POST /api/pockets`) and relays the raw funding transaction, which the
 *   worker decrypts with the pocket key; amounts are never taken on trust.
 * - Presign: each installment's window of candidate heights is sharded across the
 *   pool, the shards are checked to agree, and the ladder is sealed (age to the
 *   runner, tlock to its drand round) in a worker. The flow then uploads the
 *   packages with `POST /api/subscriptions`.
 * - Cancel: signs a spend of the live pocket note back to the payer in the pool,
 *   and proves it in a dedicated prover worker (its proving key starts building
 *   the moment cancel() is called), then `POST /api/broadcast`. Waiting for anchor
 *   depth and losing the race to an installment are handled in ./cancel.ts.
 *
 * All wasm and worker scripts are served from this origin (/wasm/, from src/wasm, and the
 * bundle); the only network peer is the configured runner.
 */
import type { CadenceClient } from '../api/client';
import type { Offer, PocketWitness, SealedInstallment } from '../api/types';
import { isUnifiedAddress } from '../lib/addresses';
import { QUICKNET } from '../lib/drand';
import { firstReleaseLead } from '../lib/schedule';
import { nowSecs } from '../lib/time';
import { totalPrepaidZat, type NetworkId } from '../lib/zat';
import { checkPocketState, readPocket, runCancel } from './cancel';
import { checkKit, isAgeKit, KIT_KIND, kitFileName, passphraseProblem, type KitCheck, type KitFields, type KitNote, type OpenedKit, type SealedKit } from './kit';
import { SignerError, type CancelOptions, type CancelReceipt, type FundingTx, type KitContext, type PocketInfo, type PresignOptions, type Signer } from './types';
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

function checkWitness(w: PocketWitness): PocketWitness {
  const h32 = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  if (!w || !isHeight(w.target_height) || !h32(w.anchor) || !Number.isSafeInteger(w.position) || w.position < 0 || !Array.isArray(w.auth_path) || w.auth_path.length !== 32 || !w.auth_path.every(h32)) {
    throw new SignerError('the runner sent a malformed witness');
  }
  return w;
}

/** A pocket note this signer created (the funding note, or C(k) after installment k). */
type KnownNote = KitNote;

/** What the cancel key needs besides the seed and notes: fixed once the schedule is signed. */
type Schedule = Pick<
  KitFields,
  'offer_id' | 'mandate_id' | 'label' | 'amount_zat' | 'count' | 'period_secs' | 'first_release_at' | 'first_in_secs' | 'merchant_ua' | 'funding_tx_hex' | 'funding_height'
>;

export class WasmSigner implements Signer {
  readonly implementation = 'wasm' as const;
  readonly keyCustody = 'memory' as const;
  readonly #api: CadenceClient;
  readonly #poolSize: number;
  #pool: WorkerPool<SignerOps> | null = null;
  #prover: WorkerPool<ProverOps> | null = null;
  #seed: Uint8Array | null = null;
  #pocket: PocketInfo | null = null;
  #funding: (WasmNote & { txid: string; mined_height: number; tx_hex: string }) | null = null;
  #notes = new Map<string, KnownNote>();
  #schedule: Schedule | null = null;
  #presigned = false;
  #cancelled = false;
  #cancelling = false;
  #destroyed = false;
  /** The name the last cancel key was saved under, for the check that asks for it again. */
  #kitName: string | null = null;

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
    // A pool that shut down because a worker failed is replaced, so a failed presign can be
    // tried again with the same pocket. A destroyed signer never gets a new one.
    this.#alive();
    if (!this.#pool || this.#pool.closed) this.#pool = createSignerPool(this.#poolSize);
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
      const state = await readPocket((signal) => this.#api.getPocket(pocket.pocket_id!, signal), { retryMs: POLL_MS, signal: opts.signal });
      if (state.funding) {
        const { txid, tx_hex, mined_height } = state.funding;
        if (!tx_hex) throw new SignerError('the runner no longer holds this pocket’s funding transaction: its subscription has ended');
        const note = await this.#workers().call('funding', { network: pocket.network, seed, txHex: tx_hex, height: mined_height }, { signal: opts.signal });
        if (note.value_zat < expectedZat) {
          throw new SignerError(`the pocket received ${note.value_zat} zats; this schedule needs ${expectedZat} (installments plus fees)`);
        }
        this.#funding = { ...note, txid, mined_height, tx_hex };
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
    const label = `${offer.name} (${pocket.pocket_id})`;
    const signed = await presignSchedule({
      pool,
      network: pocket.network,
      seed,
      funding,
      terms: {
        amount_zat: offer.amount_zat,
        count: offer.count,
        merchant_ua: offer.merchant_ua,
        label,
      },
      mandateId,
      plans,
      recipient: offer.runner_age_recipient,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    for (const s of signed) if (s.change) this.#notes.set(s.change.nullifier, { ...s.change, k: s.k });
    this.#schedule = {
      offer_id: offer.offer_id,
      mandate_id: mandateId,
      label,
      amount_zat: offer.amount_zat,
      count: offer.count,
      period_secs: offer.period_secs,
      first_release_at: signedAt + lead,
      first_in_secs: lead,
      merchant_ua: offer.merchant_ua,
      funding_tx_hex: funding.tx_hex,
      funding_height: funding.mined_height,
    };
    this.#presigned = true;
    return signed.map((s) => ({ k: s.k, release_round: s.release_round, sealed: s.sealed }));
  }

  async sealKit(passphrase: string, ctx: KitContext): Promise<SealedKit> {
    const { pocket, seed } = this.#key();
    const schedule = this.#schedule;
    if (!schedule) throw new SignerError('pre-sign the schedule first');
    const weak = passphraseProblem(passphrase);
    if (weak) throw new SignerError(weak);
    const fields: KitFields = {
      kind: KIT_KIND,
      network: pocket.network,
      runner: ctx.runner,
      pocket_id: pocket.pocket_id!,
      subscription_id: ctx.subscriptionId,
      ...schedule,
      birthday_height: pocket.birthday_height,
      pocket_ua: pocket.ua,
      notes: [...this.#notes.values()].sort((a, b) => a.k - b.k),
    };
    const bytes = await this.#workers().call('sealKit', { fields, seed, passphrase });
    this.#kitName = kitFileName();
    return { bytes, fileName: this.#kitName };
  }

  async openKit(bytes: Uint8Array, passphrase: string): Promise<OpenedKit> {
    this.#alive();
    return this.#workers().call('openKit', { bytes, passphrase });
  }

  async verifyKit(bytes: Uint8Array, passphrase: string): Promise<KitCheck> {
    const { pocket } = this.#key();
    const expected = { network: pocket.network, pocket_id: pocket.pocket_id!, pocket_ua: pocket.ua, fileName: this.#kitName ?? 'the cancel key' };
    return checkKit(bytes, passphrase, expected, {
      looksLikeKit: isAgeKit,
      open: (b, p) => this.openKit(b, p),
      // The worker derives the address from the opened seed, as restore() does.
      addressOf: async (network, seed) => (await this.#workers().call('pocketInfo', { network, seed })).ua,
    });
  }

  async restore(kit: OpenedKit): Promise<PocketInfo> {
    this.#alive();
    if (this.#pocket || this.#seed) throw new SignerError('this signer already holds a pocket; open the cancel key in a fresh one');
    const { fields: f, seed } = kit;
    if (seed.length !== 32) throw new SignerError('a pocket seed is 32 bytes');
    const made = await this.#workers().call('pocketInfo', { network: f.network, seed });
    this.#alive();
    if (made.ua !== f.pocket_ua) throw new SignerError("this cancel key is damaged: its seed does not make its pocket's address");
    this.#seed = Uint8Array.from(seed);
    seed.fill(0);
    this.#pocket = { network: f.network, ua: made.ua, ufvk: made.ufvk, birthday_height: f.birthday_height, pocket_id: f.pocket_id };
    for (const n of f.notes) this.#notes.set(n.nullifier, { ...n });
    this.#schedule = {
      offer_id: f.offer_id,
      mandate_id: f.mandate_id,
      label: f.label,
      amount_zat: f.amount_zat,
      count: f.count,
      period_secs: f.period_secs,
      first_release_at: f.first_release_at,
      first_in_secs: f.first_in_secs,
      merchant_ua: f.merchant_ua,
      funding_tx_hex: f.funding_tx_hex,
      funding_height: f.funding_height,
    };
    this.#presigned = true;
    return this.#pocket;
  }

  async cancel(refundUa: string, opts: CancelOptions = {}): Promise<CancelReceipt> {
    const { pocket, seed } = this.#key();
    if (this.#cancelled) throw new SignerError('this pocket has already been cancelled');
    const ua = refundUa.trim();
    if (!isUnifiedAddress(ua, pocket.network)) {
      throw new SignerError(`the refund address must be a ${pocket.network === 'main' ? 'mainnet (u1…)' : 'testnet (utest1…)'} unified address`);
    }
    if (ua === pocket.ua) throw new SignerError('refund to an address of your own wallet, not to the pocket');
    if (this.#cancelling) throw new SignerError('a cancel is already running in this tab');
    this.#cancelling = true;
    const id = pocket.pocket_id!;

    // Building the proving key takes seconds; start it while we talk to the runner.
    const prover = (this.#prover ??= createProver());
    const warm = prover.call('warmUp', {});
    warm.catch(() => {});
    try {
      const receipt = await runCancel(
        {
          pocket: async (signal) => checkPocketState(await this.#api.getPocket(id, signal)),
          known: (nf) => this.#notes.get(nf),
          witness: async (nf, signal) => checkWitness(await this.#api.getPocketWitness(id, nf, signal)),
          prove: async (note, witness) => {
            const built = await this.#workers().call('cancel', { network: pocket.network, seed, note: note.note, refundUa: ua, targetHeight: witness.target_height });
            await warm;
            const proved = await prover.call('prove', { pczt: built.pczt, anchor: witness.anchor, position: witness.position, authPath: witness.auth_path });
            return { tx_hex: proved.tx_hex, txid: proved.txid, refunded_zat: built.refunded_zat, fee_zat: built.fee_zat, target_height: built.target_height };
          },
          broadcast: (txHex) => this.#api.broadcast({ tx_hex: txHex }),
          count: this.#schedule?.count ?? null,
        },
        opts,
      );
      this.#cancelled = true;
      return receipt;
    } finally {
      // The prover holds no key, but it holds a lot of memory.
      prover.terminate('the cancel is finished');
      this.#prover = null;
      this.#cancelling = false;
    }
  }

  destroy(): void {
    this.#seed?.fill(0);
    this.#seed = null;
    this.#notes.clear();
    this.#funding = null;
    this.#schedule = null;
    this.#pool?.terminate();
    this.#pool = null;
    this.#prover?.terminate();
    this.#prover = null;
    this.#destroyed = true;
  }
}
