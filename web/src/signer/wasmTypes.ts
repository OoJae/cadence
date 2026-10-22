/**
 * Shapes shared by the WASM signer, its worker pool and the workers: what
 * crates/cadence-wasm returns, and the operations a worker serves.
 *
 * Amounts are zatoshis and heights block heights (JS safe integers). Notes travel
 * as cadence-wasm's 232-hex-character encoding; the pocket seed travels as a
 * 32-byte Uint8Array and never as a string.
 */
import type { NetworkId } from '../lib/zat';

/** A pocket note (funding note or change note), as cadence-wasm encodes it. Secret. */
export interface WasmNote {
  note: string;
  value_zat: number;
  nullifier: string;
}

/** `cadence_core::package::RungPackage`. */
export interface RungPackage {
  target_height: number;
  expiry_height: number;
  /** The redacted, signed, unproven PCZT, hex. */
  pczt: string;
}

/** `cadence_core::package::InstallmentLadder`: what one sealed package contains. */
export interface InstallmentLadder {
  k: number;
  amount_zat: number;
  spends_nullifier: string;
  rungs: RungPackage[];
}

export interface ShardTerms {
  amount_zat: number;
  count: number;
  merchant_ua: string;
  /** 16 bytes hex; cadence-wasm defaults it to the mandate id. */
  tag?: string;
}

export interface ShardOut {
  k: number;
  rungs: RungPackage[];
  spends_nullifier: string;
  actions_digest: string;
  change: WasmNote | null;
}

export interface SealOut {
  /** Standard base64 of tlock(age(zstd(ladder))). */
  sealed: string;
  sealed_bytes: number;
  plaintext_bytes: number;
  round: number;
}

export interface CancelOut {
  pczt: string;
  refunded_zat: number;
  fee_zat: number;
  target_height: number;
  expiry_height: number;
  spends_nullifier: string;
}

export interface ProvedOut {
  tx_hex: string;
  txid: string;
}

/** Operations a signer worker serves: `in` is the message, `out` the reply. */
export type SignerOps = {
  pocket: { in: { network: NetworkId }; out: { seed: Uint8Array; ua: string; ufvk: string } };
  funding: { in: { network: NetworkId; seed: Uint8Array; txHex: string; height: number }; out: WasmNote };
  synthetic: { in: { network: NetworkId; seed: Uint8Array; valueZat: number }; out: WasmNote };
  window: { in: { network: NetworkId; tip: number; now: number; at: number }; out: number[] };
  round: { in: { unixSecs: number }; out: number };
  fundingTotal: { in: { amountZat: number; count: number }; out: number };
  shard: {
    in: { network: NetworkId; seed: Uint8Array; input: string; terms: ShardTerms; k: number; mandateId: string; heights: number[] };
    out: ShardOut;
  };
  seal: { in: { ladderJson: string; recipient: string; round: number }; out: SealOut };
  cancel: { in: { network: NetworkId; seed: Uint8Array; note: string; refundUa: string; targetHeight: number }; out: CancelOut };
  info: { in: Record<string, never>; out: { build: string; memoryBytes: number } };
};

/** Operations the prover worker serves. */
export type ProverOps = {
  warmUp: { in: Record<string, never>; out: { ms: number } };
  prove: { in: { pczt: string; anchor: string; position: number; authPath: string[] }; out: ProvedOut };
  info: { in: Record<string, never>; out: { build: string; memoryBytes: number } };
};

export type OpMap = Record<string, { in: unknown; out: unknown }>;

export interface WorkerRequest {
  id: number;
  op: string;
  args: unknown;
}

/** `fatal`: the wasm instance trapped (a Rust panic) and must not be used again. */
export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string; fatal?: boolean };

/** Where the wasm-bindgen output is served from: /wasm/, from web/src/wasm (`pnpm build:wasm`; see vite.config.ts). */
export function wasmGlueUrl(kind: 'signer' | 'prover', base: string = import.meta.env.BASE_URL): string {
  return `${base.replace(/\/?$/, '/')}wasm/${kind}/cadence_wasm.js`;
}
