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
 * - The cancel key is the real kit JSON (./kit.ts), encrypted with WebCrypto
 *   (PBKDF2 and AES-GCM) rather than age, so only this mock opens it.
 */
import type { Offer, SealedInstallment } from '../api/types';
import { BECH32_CHARS, isUnifiedAddress } from '../lib/addresses';
import { bytesToBase64 } from '../lib/base64url';
import { payerAuthFromSeed, type PayerAuth } from '../lib/payerAuth';
import { firstReleaseLead, planSchedule } from '../lib/schedule';
import { INSTALLMENT_FEE_ZAT, totalPrepaidZat, type NetworkId } from '../lib/zat';
import { NothingToCancelError } from './cancel';
import {
  bytesToHex,
  checkKit,
  hexToBytes,
  KIT_KIND,
  kitFileName,
  kitJson,
  parseKit,
  passphraseProblem,
  WRONG_PASSPHRASE,
  type KitCheck,
  type KitFields,
  type OpenedKit,
  type SealedKit,
} from './kit';
import {
  SignerError,
  type CancelOptions,
  type CancelReceipt,
  type FundingTx,
  type KitContext,
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

const MOCK_KIT_MAGIC = new TextEncoder().encode('cadence-mock-kit/1\n');
const MOCK_KIT_ITERATIONS = 100_000;

/** The magic, a 16-byte salt, a 12-byte IV and at least the AES-GCM tag. */
const isMockKit = (bytes: Uint8Array) => bytes.length >= MOCK_KIT_MAGIC.length + 28 && MOCK_KIT_MAGIC.every((b, i) => bytes[i] === b);

async function mockKitKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: MOCK_KIT_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The mock's pocket id: the runner never registers mock pockets, so derive one. */
const mockPocketId = (ufvk: string) => `pkt_mock${ufvk.slice(-10)}`;

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
  #schedule: Omit<KitFields, 'kind' | 'network' | 'runner' | 'pocket_id' | 'subscription_id' | 'birthday_height' | 'pocket_ua' | 'notes'> | null = null;
  #payerAuth: Promise<PayerAuth> | null = null;
  #presigned = false;
  #cancelled = false;
  #destroyed = false;
  /** The name the last cancel key was saved under, for the check that asks for it again. */
  #kitName: string | null = null;

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
    const keys = await MockSigner.#derive(seed);
    await sleep(300);
    this.#pocket = { network, ...keys, birthday_height: this.#ledger.tip() };
    return this.#pocket;
  }

  static async #derive(seed: Uint8Array): Promise<{ ua: string; ufvk: string }> {
    const [ua, ufvk] = await Promise.all([deriveChars(seed, 'ua', 104), deriveChars(seed, 'ufvk', 189)]);
    return { ua: `utest1${ua}`, ufvk: `uviewtest1${ufvk}` };
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
    const lead = firstReleaseLead(offer.period_secs);
    this.#schedule = {
      offer_id: offer.offer_id,
      mandate_id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      label: offer.name,
      amount_zat: offer.amount_zat,
      count: offer.count,
      period_secs: offer.period_secs,
      first_release_at: Math.floor(now) + lead,
      first_in_secs: lead,
      merchant_ua: offer.merchant_ua,
      funding_tx_hex: null,
      funding_height: fundingTx.mined_height ?? null,
    };
    this.#presigned = true;
    return out;
  }

  async sealKit(passphrase: string, ctx: KitContext): Promise<SealedKit> {
    this.#alive();
    const pocket = this.#pocket;
    if (!pocket || !this.#seed) throw new SignerError('create a pocket first');
    if (!this.#schedule) throw new SignerError('pre-sign the schedule first');
    const weak = passphraseProblem(passphrase);
    if (weak) throw new SignerError(weak);
    const pocketId = mockPocketId(pocket.ufvk);
    const fields: KitFields = {
      kind: KIT_KIND,
      network: pocket.network,
      runner: ctx.runner,
      pocket_id: pocketId,
      subscription_id: ctx.subscriptionId,
      ...this.#schedule,
      birthday_height: pocket.birthday_height,
      pocket_ua: pocket.ua,
      notes: [],
    };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(kitJson(fields, bytesToHex(this.#seed)));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await mockKitKey(passphrase, salt), plain));
    plain.fill(0);
    const bytes = new Uint8Array(MOCK_KIT_MAGIC.length + salt.length + iv.length + ct.length);
    bytes.set(MOCK_KIT_MAGIC);
    bytes.set(salt, MOCK_KIT_MAGIC.length);
    bytes.set(iv, MOCK_KIT_MAGIC.length + salt.length);
    bytes.set(ct, MOCK_KIT_MAGIC.length + salt.length + iv.length);
    this.#kitName = kitFileName('mock');
    return { bytes, fileName: this.#kitName };
  }

  async openKit(bytes: Uint8Array, passphrase: string): Promise<OpenedKit> {
    this.#alive();
    const head = MOCK_KIT_MAGIC.length;
    if (!isMockKit(bytes)) throw new SignerError('this file is not a cancel key from this mock build');
    let plain: Uint8Array;
    try {
      const key = await mockKitKey(passphrase, bytes.slice(head, head + 16));
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(head + 16, head + 28) }, key, bytes.slice(head + 28)));
    } catch {
      throw new SignerError(WRONG_PASSPHRASE);
    }
    const { fields, seedHex } = parseKit(JSON.parse(new TextDecoder().decode(plain)));
    plain.fill(0);
    return { fields, seed: hexToBytes(seedHex) };
  }

  async verifyKit(bytes: Uint8Array, passphrase: string): Promise<KitCheck> {
    this.#alive();
    const pocket = this.#pocket;
    if (!pocket || !this.#seed) throw new SignerError('create a pocket first');
    const pocketId = mockPocketId(pocket.ufvk);
    const expected = { network: pocket.network, pocket_id: pocketId, pocket_ua: pocket.ua, fileName: this.#kitName ?? 'the cancel key' };
    return checkKit(bytes, passphrase, expected, {
      looksLikeKit: isMockKit,
      open: (b, p) => this.openKit(b, p),
      addressOf: async (_network, seed) => (await MockSigner.#derive(seed)).ua,
    });
  }

  async restore(kit: OpenedKit): Promise<PocketInfo> {
    this.#alive();
    if (this.#pocket || this.#seed) throw new SignerError('this signer already holds a pocket; open the cancel key in a fresh one');
    const { fields: f, seed } = kit;
    const keys = await MockSigner.#derive(seed);
    if (keys.ua !== f.pocket_ua) throw new SignerError("this cancel key is damaged: its seed does not make its pocket's address");
    this.#seed = Uint8Array.from(seed);
    seed.fill(0);
    this.#pocket = { network: f.network, ...keys, birthday_height: f.birthday_height };
    const { kind: _k, network: _n, runner: _r, pocket_id: _p, subscription_id: _s, birthday_height: _b, pocket_ua: _u, notes: _notes, ...schedule } = f;
    this.#schedule = schedule;
    this.#presigned = true;
    return this.#pocket;
  }

  async cancel(refundUa: string, opts: CancelOptions = {}): Promise<CancelReceipt> {
    this.#alive();
    const pocket = this.#pocket;
    if (!pocket || !this.#seed) throw new SignerError('this signer holds no pocket key');
    if (this.#cancelled) throw new SignerError('this pocket has already been cancelled');
    const ua = refundUa.trim();
    if (!isUnifiedAddress(ua, pocket.network)) throw new SignerError('the refund address must be a testnet unified address (utest1…)');
    if (ua === pocket.ua) throw new SignerError('refund to an address of your own wallet, not to the pocket');
    opts.onStatus?.({ step: 'finding' });
    const balance = this.#ledger.pocketBalance(pocket.ufvk);
    if (balance <= INSTALLMENT_FEE_ZAT) throw new NothingToCancelError('Nothing is left in the pocket to refund: every installment has been paid.');
    opts.onStatus?.({ step: 'proving', k: 0 });
    await sleep(900, opts.signal);
    opts.onStatus?.({ step: 'broadcasting', k: 0 });
    const refunded = balance - INSTALLMENT_FEE_ZAT;
    const tx = this.#ledger.broadcastCancel(pocket.ufvk, ua, refunded);
    this.#cancelled = true;
    return { txid: tx.txid, refunded_zat: refunded, fee_zat: INSTALLMENT_FEE_ZAT, target_height: tx.target_height };
  }

  /** The real derivation (WebCrypto HKDF and Ed25519), from the mock pocket's seed. */
  async payerAuth(): Promise<PayerAuth> {
    this.#alive();
    if (!this.#pocket || !this.#seed) throw new SignerError('create a pocket first');
    const auth = await (this.#payerAuth ??= payerAuthFromSeed(this.#seed));
    return {
      publicKeyHex: auth.publicKeyHex,
      sign: async (method, path, body) => {
        this.#alive();
        return auth.sign(method, path, body);
      },
    };
  }

  destroy(): void {
    this.#seed?.fill(0);
    this.#seed = null;
    this.#payerAuth = null;
    this.#schedule = null;
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
  sealKit(): Promise<SealedKit> {
    this.#fail();
  }
  openKit(): Promise<OpenedKit> {
    return Promise.reject(new SignerError('this build has no in-browser signer (build with VITE_SIGNER=wasm); cancel with the cadence CLI: cadence cancel --subscription <cancel key> --to <your address>'));
  }
  verifyKit(): Promise<KitCheck> {
    this.#fail();
  }
  restore(): Promise<PocketInfo> {
    this.#fail();
  }
  cancel(): Promise<CancelReceipt> {
    this.#fail();
  }
  payerAuth(): Promise<PayerAuth> {
    this.#fail();
  }
  destroy(): void {}
}
