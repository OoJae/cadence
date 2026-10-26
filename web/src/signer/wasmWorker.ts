/**
 * Module worker hosting one instance of the cadence-wasm signer.
 *
 * It is stateless: every request carries the seed and notes it needs, so any worker
 * of the pool can serve any request, and terminating the worker drops its wasm
 * memory with whatever key material passed through it.
 *
 * The wasm-bindgen glue is loaded at run time from this origin's /wasm/signer/
 * (web/src/wasm, built by `pnpm build:wasm`; see vite.config.ts), not bundled, so builds that never
 * use the WASM signer never reference it.
 */
import { bytesToHex, hexToBytes, kitJson, parseKit } from './kit';
import { wasmGlueUrl, type SignerOps, type WorkerReply, type WorkerRequest } from './wasmTypes';

interface SignerGlue {
  default(): Promise<unknown>;
  build_info(): string;
  memory_bytes(): number;
  pocket_info(network: string, seed: Uint8Array): string;
  funding_from_tx(network: string, seed: Uint8Array, txHex: string, height: number): string;
  synthetic_note(network: string, seed: Uint8Array, valueZat: number): string;
  presign_shard(network: string, seed: Uint8Array, input: string, termsJson: string, k: number, mandateIdHex: string, heights: Uint32Array): string;
  seal_installment(ladderJson: string, recipient: string, round: number): string;
  round_for(unixSecs: number): number;
  window(network: string, tip: number, now: number, at: number): Uint32Array;
  funding_total(amountZat: number, count: number): number;
  build_cancel(network: string, seed: Uint8Array, note: string, refundUa: string, targetHeight: number): string;
  seal_kit(plainJson: string, passphrase: string): Uint8Array;
  open_kit(bytes: Uint8Array, passphrase: string): string;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  location: { href: string };
}
const scope = self as unknown as WorkerScope;

let glue: Promise<SignerGlue> | null = null;
function load(): Promise<SignerGlue> {
  glue ??= (async () => {
    const url = new URL(wasmGlueUrl('signer'), scope.location.href).href;
    let m: SignerGlue;
    try {
      m = (await import(/* @vite-ignore */ url)) as SignerGlue;
    } catch (e) {
      throw new Error(`could not load the signer module from ${url} (run pnpm build:wasm): ${(e as Error).message}`);
    }
    await m.default();
    return m;
  })();
  return glue;
}

type Handlers = { [K in keyof SignerOps]: (w: SignerGlue, a: SignerOps[K]['in']) => SignerOps[K]['out'] };

/** Exported for tests, which call them on the wasm module directly. */
export const handlers: Handlers = {
  pocket: (w, { network }) => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { ua, ufvk } = JSON.parse(w.pocket_info(network, seed)) as { ua: string; ufvk: string };
    return { seed, ua, ufvk };
  },
  funding: (w, a) => JSON.parse(w.funding_from_tx(a.network, a.seed, a.txHex, a.height)),
  synthetic: (w, a) => JSON.parse(w.synthetic_note(a.network, a.seed, a.valueZat)),
  window: (w, a) => Array.from(w.window(a.network, a.tip, a.now, a.at)),
  round: (w, a) => w.round_for(a.unixSecs),
  fundingTotal: (w, a) => w.funding_total(a.amountZat, a.count),
  shard: (w, a) =>
    JSON.parse(w.presign_shard(a.network, a.seed, a.input, JSON.stringify(a.terms), a.k, a.mandateId, Uint32Array.from(a.heights))),
  seal: (w, a) => JSON.parse(w.seal_installment(a.ladderJson, a.recipient, a.round)),
  pocketInfo: (w, a) => {
    const { ua, ufvk } = JSON.parse(w.pocket_info(a.network, a.seed)) as { ua: string; ufvk: string };
    return { ua, ufvk };
  },
  cancel: (w, a) => JSON.parse(w.build_cancel(a.network, a.seed, a.note, a.refundUa, a.targetHeight)),
  sealKit: (w, a) => w.seal_kit(kitJson(a.fields, bytesToHex(a.seed)), a.passphrase),
  openKit: (w, a) => {
    let json: unknown;
    try {
      json = JSON.parse(w.open_kit(a.bytes, a.passphrase));
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('this cancel key does not hold JSON');
      throw e;
    }
    const { fields, seedHex } = parseKit(json);
    return { fields, seed: hexToBytes(seedHex) };
  },
  info: (w) => ({ build: w.build_info(), memoryBytes: w.memory_bytes() }),
};

scope.onmessage = async ({ data }) => {
  const { id, op, args } = data;
  try {
    const w = await load();
    const handler = handlers[op as keyof SignerOps] as ((w: SignerGlue, a: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unknown operation ${op}`);
    const value = handler(w, args);
    const transfer =
      op === 'pocket' || op === 'openKit'
        ? [(value as { seed: Uint8Array }).seed.buffer as ArrayBuffer]
        : op === 'sealKit'
          ? [(value as Uint8Array).buffer as ArrayBuffer]
          : [];
    scope.postMessage({ id, ok: true, value }, transfer);
  } catch (e) {
    // A trap (a Rust panic) leaves the instance unusable: ask the pool for a fresh worker.
    const fatal = e instanceof WebAssembly.RuntimeError;
    scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e), fatal });
  }
};
