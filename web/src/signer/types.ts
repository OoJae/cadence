/**
 * The payer-side signer. The production implementation is a WASM build of
 * cadence-core running in a Web Worker (built separately); this app ships a mock
 * that implements the same contract with in-memory keys.
 *
 * One Signer instance serves one mandate: createPocket() → awaitFunding() →
 * presign() → (later) cancel(). Key material never leaves the signer: the app only
 * ever sees the pocket's address, its view-only UFVK and sealed packages.
 */
import type { Offer, SealedInstallment } from '../api/types';
import type { NetworkId } from '../lib/zat';

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
  /** Signing starts as soon as the payment is in the mempool. */
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
}

export interface Signer {
  /** 'wasm' is the real cadence-core signer; 'mock' is this build's stand-in. */
  readonly implementation: 'mock' | 'wasm';
  /**
   * Where the pocket key lives. 'memory' forgets it when the tab closes, so cancel is
   * only possible from this tab; both the mock and the WASM signer are 'memory' today.
   * 'passkey' (planned) keeps it sealed under WebAuthn PRF or a passphrase so the
   * payer can come back to cancel.
   */
  readonly keyCustody: 'memory' | 'passkey';

  /** Creates a fresh single-use pocket: a new random seed at a non-zero ZIP 32 account. */
  createPocket(network: NetworkId): Promise<PocketInfo>;

  /** Resolves when a payment of at least `expectedZat` reaches the pocket (mempool is enough). */
  awaitFunding(expectedZat: number, opts?: { signal?: AbortSignal }): Promise<FundingTx>;

  /**
   * Pre-signs every installment of `offer`, spending `fundingTx` and each change note
   * in turn, once per candidate height ("rungs"). Each package is redacted, compressed,
   * sealed to the runner's age key and time-locked to its drand round.
   */
  presign(offer: Offer, fundingTx: FundingTx, opts?: PresignOptions): Promise<SealedInstallment[]>;

  /**
   * Spends the pocket's current note to the payer's own `refundUa` (OvkPolicy::Discard),
   * so every later installment becomes a double-spend the runner cannot broadcast.
   */
  cancel(refundUa: string): Promise<CancelReceipt>;

  /** Zeroises all key material. The signer is unusable afterwards. */
  destroy(): void;
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerError';
  }
}
