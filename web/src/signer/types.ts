/**
 * The payer-side signer. The production implementation is a WASM build of
 * cadence-core running in a Web Worker (built separately); this app ships a mock
 * that implements the same contract with in-memory keys.
 *
 * One Signer instance serves one mandate: createPocket() → awaitFunding() →
 * presign() → sealKit() → verifyKit() → (later) cancel(). A signer can instead
 * start from a saved cancel key: openKit() → restore() → cancel(). Key material
 * leaves the signer only encrypted to the payer's passphrase (sealKit); otherwise
 * the app only ever sees the pocket's address, its view-only UFVK and sealed
 * packages.
 */
import type { Offer, SealedInstallment } from '../api/types';
import type { NetworkId } from '../lib/zat';
import type { KitCheck, OpenedKit, SealedKit } from './kit';

export type { SealedInstallment };

/** Public facts about a freshly created pocket. Nothing here can spend. */
export interface PocketInfo {
  network: NetworkId;
  /** Orchard-only unified address the payer funds from their own wallet. */
  ua: string;
  /** Orchard-only UFVK for the runner. No transparent or Sapling part, no spend authority. */
  ufvk: string;
  /** Last block before the pocket could have been funded (the runner scans from here). */
  birthday_height: number;
  /** The runner's id for this pocket (`POST /api/pockets`). Set by the WASM signer, which registers it. */
  pocket_id?: string;
}

/** The payment into the pocket, as seen through the pocket's incoming viewing key. */
export interface FundingTx {
  txid: string;
  value_zat: number;
  /**
   * The WASM signer starts signing once the runner sees the payment mined (the runner
   * only records mined funding); the mock accepts the mempool.
   */
  status: 'mempool' | 'mined';
  mined_height?: number;
}

export type PresignPhase = 'sign' | 'redact' | 'compress' | 'seal' | 'timelock' | 'done';

export interface PresignProgress {
  /** 1-based installment being worked on. */
  k: number;
  count: number;
  phase: PresignPhase;
  /** Rungs signed so far for installment k, out of rungsTotal (one per candidate target height). */
  rungsDone: number;
  rungsTotal: number;
  /** Candidate target heights for installment k. */
  window: [number, number];
  release_round: number;
  /** Size of the sealed package once phase is 'done' (one of the fixed buckets), if the signer reports it. */
  sealedBytes?: number;
}

export interface PresignOptions {
  onProgress?: (p: PresignProgress) => void;
  signal?: AbortSignal;
  /** Unix time the schedule starts from; defaults to now. */
  signedAt?: number;
}

export interface CancelReceipt {
  txid: string;
  /** What returns to the payer: the pocket's remaining note minus the fee. */
  refunded_zat: number;
  fee_zat: number;
  /** The block it should be mined in. */
  target_height: number;
  /** Which pocket note it spent, in words ("the change from installment 2"). */
  spent?: string;
}

/** Where a cancel is, for the page to show. `k` is the pocket note's installment (0: the funding note). */
export type CancelStatus =
  | { step: 'finding' }
  /** The note is not yet anchor-deep; the next try is at `retryAt` (ms). */
  | { step: 'waiting'; k: number; blocks: number; retryAt: number }
  /** Installment `k` spent the note first; waiting for its change, then retrying once. */
  | { step: 'raced'; k: number; retryAt: number }
  | { step: 'proving'; k: number }
  | { step: 'broadcasting'; k: number };

export interface CancelOptions {
  /** Stops waiting. A cancel already being proved is not broadcast. */
  signal?: AbortSignal;
  onStatus?: (s: CancelStatus) => void;
}

/** Where the subscription lives, for the cancel key. */
export interface KitContext {
  /** The runner's absolute base URL. */
  runner: string;
  subscriptionId: string | null;
}

export interface Signer {
  /** 'wasm' is the real cadence-core signer; 'mock' is this build's stand-in. */
  readonly implementation: 'mock' | 'wasm';
  /**
   * Where the pocket key lives. 'memory' forgets it when the tab closes; to cancel
   * later, the payer saves a cancel key (sealKit), a file encrypted to a passphrase.
   * Both the mock and the WASM signer are 'memory'. 'passkey' (planned) would keep it
   * sealed under WebAuthn PRF instead.
   */
  readonly keyCustody: 'memory' | 'passkey';

  /** Creates a fresh single-use pocket: a new random seed at a non-zero ZIP 32 account. */
  createPocket(network: NetworkId): Promise<PocketInfo>;

  /** Resolves when a payment of at least `expectedZat` reaches the pocket (the WASM signer: mined; the mock: the mempool is enough). */
  awaitFunding(expectedZat: number, opts?: { signal?: AbortSignal }): Promise<FundingTx>;

  /**
   * Pre-signs every installment of `offer`, spending `fundingTx` and each change note
   * in turn, once per candidate height ("rungs"). Each package is redacted, compressed,
   * sealed to the runner's age key and time-locked to its drand round.
   */
  presign(offer: Offer, fundingTx: FundingTx, opts?: PresignOptions): Promise<SealedInstallment[]>;

  /**
   * Encrypts this pocket's cancel key (the recovery kit: seed, schedule, notes) to
   * `passphrase`, in a worker. The page only ever sees the ciphertext. Needs presign().
   */
  sealKit(passphrase: string, ctx: KitContext): Promise<SealedKit>;

  /** Decrypts a cancel key saved by sealKit, in a worker, and checks its shape. */
  openKit(bytes: Uint8Array, passphrase: string): Promise<OpenedKit>;

  /**
   * Checks a cancel key the payer saved and picked again: it opens with `passphrase`
   * (as openKit does) and is this pocket's key, with the same pocket id and address
   * and a seed that makes that address. Resolves with what is wrong rather than
   * throwing for a wrong file or passphrase. Keeps nothing; needs a pocket.
   */
  verifyKit(bytes: Uint8Array, passphrase: string): Promise<KitCheck>;

  /** Loads an opened cancel key into this fresh signer, so it can cancel. */
  restore(kit: OpenedKit): Promise<PocketInfo>;

  /**
   * Spends the pocket's current note to the payer's own `refundUa` (OvkPolicy::Discard),
   * so every later installment becomes a double-spend the runner cannot broadcast.
   * Waits (up to about 5 minutes) for a fresh note to be deep enough to spend, and
   * retries once if an installment spends the note first. Throws
   * NothingToCancelError when every installment was released first.
   */
  cancel(refundUa: string, opts?: CancelOptions): Promise<CancelReceipt>;

  /** Zeroises all key material. The signer is unusable afterwards. */
  destroy(): void;
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerError';
  }
}
