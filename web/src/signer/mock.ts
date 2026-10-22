/**
 * MockSigner: the Signer contract with no real cryptography.
 *
 * - Keys live in this object only (a Uint8Array seed from crypto.getRandomValues).
 *   Nothing is written to localStorage, sessionStorage, IndexedDB or cookies, and
 *   destroy() zeroises the seed.
 * - Addresses are derived one-way from the seed with SHA-256 and shaped like testnet
 *   UAs, but they carry no valid Bech32m checksum, so no real wallet will pay them.
 * - "Sealed" packages are fixed-size random bytes, the same size for every
 *   installment, like the real padded tlock(age(zstd(ladder))) blobs.
 */
import type { Offer, SealedInstallment } from '../api/types';
import { BECH32_CHARS, isUnifiedAddress } from '../lib/addresses';
import { bytesToBase64 } from '../lib/base64url';
import { planSchedule } from '../lib/schedule';
import { INSTALLMENT_FEE_ZAT, totalPrepaidZat, type NetworkId } from '../lib/zat';
import {
  SignerError,
  type CancelReceipt,
  type FundingTx,
  type PocketInfo,
  type PresignOptions,
  type Signer,
} from './types';

/** What the mock signer needs from the (mock) world: a chain view and the runner's hooks. */
export interface MockLedger {
  now(): number;
  tip(): number;
  blockSecs: number;
  paymentsTo(ua: string): Array<{ txid: string; value_zat: number; mined_height: number }>;
  pocketBalance(ufvk: string): number;
  /** Stands in for the runner learning a package's rung heights when it opens it. */
  registerPackage(sealed: string, window: [number, number]): void;
  broadcastCancel(pocketUfvk: string, refundUa: string, valueZat: number): { txid: string; target_height: number };
}

/** Every sealed package is padded to the same size, so sizes reveal nothing. */
export const PACKAGE_BYTES = 16 * 1024;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

async function deriveChars(seed: Uint8Array, label: string, length: number): Promise<string> {
  let out = '';
  for (let counter = 0; out.length < length; counter++) {
    const input = new Uint8Array(seed.length + label.length + 1);
    input.set(seed);
    input.set(new TextEncoder().encode(label), seed.length);
    input[input.length - 1] = counter;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    for (const b of digest) out += BECH32_CHARS[b & 31];
  }
  return out.slice(0, length);
}

function randomPackage(): string {
  const bytes = new Uint8Array(PACKAGE_BYTES);
  // getRandomValues fills at most 65536 bytes per call.
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

export class MockSigner implements Signer {
  readonly implementation = 'mock' as const;
  readonly keyCustody = 'memory' as const;
  readonly #ledger: MockLedger;
  #seed: Uint8Array | null = null;
  #pocket: PocketInfo | null = null;
  #presigned = false;
  #cancelled = false;
  #destroyed = false;

  constructor(ledger: MockLedger) {
    this.#ledger = ledger;
  }

  get pocket(): PocketInfo | null {
    return this.#pocket;
  }

  #alive(): void {
    if (this.#destroyed) throw new SignerError('this signer was destroyed and holds no keys');
  }

  async createPocket(network: NetworkId): Promise<PocketInfo> {
    this.#alive();
    if (this.#pocket) throw new SignerError('this signer already holds a pocket; pockets are single-use');
    if (network !== 'test') throw new SignerError('the mock signer only creates testnet pockets');
    const seed = crypto.getRandomValues(new Uint8Array(32));
    this.#seed = seed;
    const [ua, ufvk] = await Promise.all([deriveChars(seed, 'ua', 104), deriveChars(seed, 'ufvk', 189)]);
    await sleep(300);
    this.#pocket = {
      network,
      ua: `utest1${ua}`,
      ufvk: `uviewtest1${ufvk}`,
      birthday_height: this.#ledger.tip(),
    };
    return this.#pocket;
  }

  async awaitFunding(expectedZat: number, opts: { signal?: AbortSignal } = {}): Promise<FundingTx> {
    this.#alive();
    const pocket = this.#pocket;
    if (!pocket) throw new SignerError('create a pocket first');
    for (;;) {
      const hit = this.#ledger.paymentsTo(pocket.ua).find((p) => p.value_zat >= expectedZat);
      if (hit) {
        const mined = hit.mined_height <= this.#ledger.tip();
        return { txid: hit.txid, value_zat: hit.value_zat, status: mined ? 'mined' : 'mempool', mined_height: mined ? hit.mined_height : undefined };
      }
      await sleep(400, opts.signal);
    }
  }

  async presign(offer: Offer, fundingTx: FundingTx, opts: PresignOptions = {}): Promise<SealedInstallment[]> {
    this.#alive();
    if (!this.#pocket || !this.#seed) throw new SignerError('create a pocket first');
    if (this.#presigned) throw new SignerError('this pocket is already pre-signed; pockets are single-use');
    if (offer.network !== this.#pocket.network) throw new SignerError('the offer is for a different network than the pocket');
    const need = totalPrepaidZat(offer.amount_zat, offer.count);
    if (fundingTx.value_zat < need) {
      throw new SignerError(`the pocket holds ${fundingTx.value_zat} zats; this schedule needs ${need} (installments plus fees)`);
    }

    const now = opts.signedAt ?? this.#ledger.now();
    const schedule = planSchedule(offer, now);
    const rungsTotal = offer.period_secs < 3600 ? 16 : 48;
    const out: SealedInstallment[] = [];
    const tip = this.#ledger.tip();

    for (const inst of schedule) {
      const est = tip + Math.ceil((inst.release_at + 4 - now) / this.#ledger.blockSecs) + 1;
      const window: [number, number] = [est - 2, est - 2 + rungsTotal - 1];
      const base = { k: inst.k, count: offer.count, rungsTotal, window, release_round: inst.release_round };
      for (let r = 0; r < rungsTotal; r++) {
        opts.onProgress?.({ ...base, phase: 'sign', rungsDone: r });
        await sleep(12, opts.signal);
      }
      for (const [phase, ms] of [['redact', 70], ['compress', 50], ['seal', 70], ['timelock', 90]] as const) {
        opts.onProgress?.({ ...base, phase, rungsDone: rungsTotal });
        await sleep(ms, opts.signal);
      }
      const sealed = randomPackage();
      this.#ledger.registerPackage(sealed, window);
      out.push({ k: inst.k, release_round: inst.release_round, sealed });
      opts.onProgress?.({ ...base, phase: 'done', rungsDone: rungsTotal });
    }
    this.#presigned = true;
    return out;
  }

  async cancel(refundUa: string): Promise<CancelReceipt> {
    this.#alive();
    const pocket = this.#pocket;
    if (!pocket || !this.#seed) throw new SignerError('this signer holds no pocket key');
    if (this.#cancelled) throw new SignerError('this pocket has already been cancelled');
    const ua = refundUa.trim();
    if (!isUnifiedAddress(ua, pocket.network)) throw new SignerError('the refund address must be a testnet unified address (utest1…)');
    if (ua === pocket.ua) throw new SignerError('refund to an address of your own wallet, not to the pocket');
    const balance = this.#ledger.pocketBalance(pocket.ufvk);
    if (balance <= INSTALLMENT_FEE_ZAT) throw new SignerError('nothing is left in the pocket to refund: every installment has been paid');
    await sleep(900);
    const refunded = balance - INSTALLMENT_FEE_ZAT;
    const tx = this.#ledger.broadcastCancel(pocket.ufvk, ua, refunded);
    this.#cancelled = true;
    return { txid: tx.txid, refunded_zat: refunded, fee_zat: INSTALLMENT_FEE_ZAT, target_height: tx.target_height };
  }

  destroy(): void {
    this.#seed?.fill(0);
    this.#seed = null;
    this.#destroyed = true;
  }
}

/** The signer for builds that talk to a real runner without VITE_SIGNER=wasm. */
export class UnavailableSigner implements Signer {
  readonly implementation = 'wasm' as const;
  readonly keyCustody = 'passkey' as const;
  #fail(): never {
    throw new SignerError('this build has no in-browser signer (build with VITE_SIGNER=wasm); use the cadence CLI to pre-sign');
  }
  createPocket(): Promise<PocketInfo> {
    return Promise.reject(new SignerError('this build has no in-browser signer (build with VITE_SIGNER=wasm); use the cadence CLI to pre-sign'));
  }
  awaitFunding(): Promise<FundingTx> {
    this.#fail();
  }
  presign(): Promise<SealedInstallment[]> {
    this.#fail();
  }
  cancel(): Promise<CancelReceipt> {
    this.#fail();
  }
  destroy(): void {}
}
