/**
 * A pool of module Web Workers with a priority queue.
 *
 * Each worker serves one request at a time. Requests wait in a queue ordered by
 * (priority, arrival), so the signer can let installment k's sealing jump ahead of
 * installment k+1's rungs. Workers start lazily, up to `size`.
 *
 * The production CSP requires Trusted Types and allows exactly one policy,
 * `cadence-worker`, in WASM-signer builds: `new Worker(url)` is a TrustedScriptURL
 * sink, and that policy only lets same-origin script URLs through.
 */
import type { OpMap, WorkerReply, WorkerRequest } from './wasmTypes';

// ---------------------------------------------------------------- Trusted Types

interface ScriptUrlPolicy {
  createScriptURL(url: string): unknown;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): ScriptUrlPolicy;
}

export const WORKER_POLICY = 'cadence-worker';
let policy: ScriptUrlPolicy | null = null;

function sameOriginScript(url: string): string {
  const u = new URL(url, location.href);
  if (u.origin !== location.origin) throw new TypeError(`refusing a worker script from another origin: ${u.origin}`);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError(`refusing a ${u.protocol} worker script`);
  return u.href;
}

/** A worker script URL the Trusted Types policy accepts (a plain string where Trusted Types are absent). */
export function trustedWorkerUrl(url: string): string {
  const tt = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (!tt) return sameOriginScript(url);
  policy ??= tt.createPolicy(WORKER_POLICY, { createScriptURL: sameOriginScript });
  // A TrustedScriptURL; the DOM typings only know strings and URLs.
  return policy.createScriptURL(url) as string;
}

export function moduleWorker(url: string, name: string): Worker {
  return new Worker(trustedWorkerUrl(url), { type: 'module', name });
}

/** One worker per spare core, keeping one for the page, at most 8. */
export function defaultPoolSize(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.min(8, Math.max(1, cores - 1));
}

// ---------------------------------------------------------------- pool

interface Task {
  id: number;
  op: string;
  args: unknown;
  priority: number;
  seq: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
}

export interface CallOptions {
  /** Lower runs first; ties run in arrival order. */
  priority?: number;
  /** Aborting drops the request if it has not started yet; a started one runs to completion. */
  signal?: AbortSignal;
}

export class PoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolError';
  }
}

export class WorkerPool<Ops extends OpMap> {
  readonly size: number;
  readonly #spawn: () => Worker;
  #slots: Slot[] = [];
  #queue: Task[] = [];
  #nextId = 1;
  #closed: string | null = null;

  constructor(spawn: () => Worker, size: number = defaultPoolSize()) {
    this.#spawn = spawn;
    this.size = Math.max(1, Math.floor(size));
  }

  /** Workers started so far. */
  get started(): number {
    return this.#slots.length;
  }

  call<K extends keyof Ops & string>(op: K, args: Ops[K]['in'], opts: CallOptions = {}): Promise<Ops[K]['out']> {
    if (this.#closed) return Promise.reject(new PoolError(this.#closed));
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason ?? new PoolError('aborted'));
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const task: Task = { id, op, args, priority: opts.priority ?? 0, seq: id, resolve: resolve as (v: unknown) => void, reject, signal: opts.signal };
      if (opts.signal) {
        task.onAbort = () => {
          const i = this.#queue.indexOf(task);
          if (i >= 0) {
            this.#queue.splice(i, 1);
            reject(opts.signal!.reason ?? new PoolError('aborted'));
          }
        };
        opts.signal.addEventListener('abort', task.onAbort, { once: true });
      }
      this.#queue.push(task);
      this.#pump();
    });
  }

  /** Stops every worker (dropping their wasm memory) and fails whatever is pending. */
  terminate(reason = 'the signer was shut down'): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const s of this.#slots) {
      s.worker.terminate();
      if (s.task) this.#finish(s.task, new PoolError(reason));
    }
    this.#slots = [];
    for (const t of this.#queue.splice(0)) this.#finish(t, new PoolError(reason));
  }

  #finish(task: Task, error: Error | null, value?: unknown): void {
    if (task.onAbort) task.signal?.removeEventListener('abort', task.onAbort);
    if (error) task.reject(error);
    else task.resolve(value);
  }

  #next(): Task | undefined {
    let best = -1;
    for (let i = 0; i < this.#queue.length; i++) {
      const t = this.#queue[i]!;
      const b = best >= 0 ? this.#queue[best]! : null;
      if (!b || t.priority < b.priority || (t.priority === b.priority && t.seq < b.seq)) best = i;
    }
    return best >= 0 ? this.#queue.splice(best, 1)[0] : undefined;
  }

  #pump(): void {
    while (this.#queue.length && !this.#closed) {
      let slot = this.#slots.find((s) => !s.task);
      if (!slot) {
        if (this.#slots.length >= this.size) return;
        slot = this.#start();
      }
      const task = this.#next()!;
      slot.task = task;
      const msg: WorkerRequest = { id: task.id, op: task.op, args: task.args };
      slot.worker.postMessage(msg);
    }
  }

  /** Drops one worker; a fresh one starts when there is work for it. */
  #retire(slot: Slot): void {
    slot.worker.terminate();
    this.#slots = this.#slots.filter((s) => s !== slot);
  }

  #start(): Slot {
    const worker = this.#spawn();
    const slot: Slot = { worker, task: null };
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      const task = slot.task;
      if (!task || task.id !== data.id) return;
      slot.task = null;
      if (data.ok) this.#finish(task, null, data.value);
      else {
        if (data.fatal) this.#retire(slot);
        this.#finish(task, new PoolError(data.error));
      }
      this.#pump();
    };
    // A worker that fails to load or throws outside a request is not recoverable:
    // fail everything rather than respawning in a loop.
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.terminate(`a signer worker failed: ${e.message || 'it could not be started'}`);
    };
    worker.onmessageerror = () => this.terminate('a signer worker sent a message that could not be read');
    this.#slots.push(slot);
    return slot;
  }
}
