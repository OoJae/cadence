/**
 * Module worker hosting the cadence-wasm prover, used only to cancel.
 *
 * It loads the larger prover build (/wasm/prover/) and never sees the pocket seed:
 * it receives a PCZT that the signer pool already signed, installs the runner's
 * anchor and witness, proves (single-threaded, about 20 s) and extracts, which
 * verifies the proof and every signature. Building the proving key takes about
 * 14 s, so the signer sends `warmUp` as soon as a cancel starts.
 */
import { wasmGlueUrl, type ProverOps, type WorkerReply, type WorkerRequest } from './wasmTypes';

interface ProverGlue {
  default(): Promise<unknown>;
  build_info(): string;
  memory_bytes(): number;
  prover_warm_up(): number;
  complete_and_prove(pczt: string, anchor: string, position: number, authPath: string[]): string;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply): void;
  location: { href: string };
}
const scope = self as unknown as WorkerScope;

let glue: Promise<ProverGlue> | null = null;
function load(): Promise<ProverGlue> {
  glue ??= (async () => {
    const url = new URL(wasmGlueUrl('prover'), scope.location.href).href;
    let m: ProverGlue;
    try {
      m = (await import(/* @vite-ignore */ url)) as ProverGlue;
    } catch (e) {
      throw new Error(`could not load the prover module from ${url} (run pnpm build:wasm): ${(e as Error).message}`);
    }
    await m.default();
    return m;
  })();
  return glue;
}

type Handlers = { [K in keyof ProverOps]: (w: ProverGlue, a: ProverOps[K]['in']) => ProverOps[K]['out'] };

const handlers: Handlers = {
  warmUp: (w) => ({ ms: w.prover_warm_up() }),
  prove: (w, a) => JSON.parse(w.complete_and_prove(a.pczt, a.anchor, a.position, a.authPath)),
  info: (w) => ({ build: w.build_info(), memoryBytes: w.memory_bytes() }),
};

scope.onmessage = async ({ data }) => {
  const { id, op, args } = data;
  try {
    const w = await load();
    const handler = handlers[op as keyof ProverOps] as ((w: ProverGlue, a: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unknown operation ${op}`);
    scope.postMessage({ id, ok: true, value: handler(w, args) });
  } catch (e) {
    // A trap (a Rust panic) leaves the instance unusable: ask the pool for a fresh worker.
    const fatal = e instanceof WebAssembly.RuntimeError;
    scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e), fatal });
  }
};
