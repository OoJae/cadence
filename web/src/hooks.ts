import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------- shared 1 Hz clock

let current = Date.now() / 1000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function tick() {
  current = Date.now() / 1000;
  for (const l of listeners) l();
  // Align to wall-clock seconds so every countdown flips together.
  timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}

function subscribeClock(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    current = Date.now() / 1000;
    timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** Unix seconds, re-rendering once per second. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => current, () => current);
}

// ---------------------------------------------------------------- polling

export interface Poll<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refresh: () => void;
}

/**
 * Calls `fn` now and every `intervalMs`. Never overlaps requests, and pauses while the
 * tab is hidden so a background tab makes no requests at all.
 */
export function usePoll<T>(fn: (signal: AbortSignal) => Promise<T>, intervalMs: number, deps: unknown[] = []): Poll<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    const run = async () => {
      if (!alive) return;
      // Recurring polls wait while the tab is hidden; one-shot fetches (interval 0) just run.
      if (intervalMs > 0 && document.visibilityState === 'hidden') {
        t = setTimeout(run, Math.max(intervalMs, 1000));
        return;
      }
      try {
        const v = await fnRef.current(ctrl.signal);
        if (!alive) return;
        setData(v);
        setError(undefined);
      } catch (e) {
        if (!alive) return;
        setError(e as Error);
      } finally {
        if (alive) {
          setLoading(false);
          if (intervalMs > 0) t = setTimeout(run, intervalMs);
        }
      }
    };
    run();
    return () => {
      alive = false;
      ctrl.abort();
      if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}

// ---------------------------------------------------------------- tiny external store

export interface Store<T> {
  get(): T;
  set(next: Partial<T> | ((prev: T) => Partial<T>)): void;
  reset(): void;
  subscribe(cb: () => void): () => void;
}

/** In-memory only. Survives client-side navigation, never a reload. */
export function createStore<T extends object>(initial: () => T): Store<T> {
  let state = initial();
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((s) => s());
  return {
    get: () => state,
    set(next) {
      const patch = typeof next === 'function' ? next(state) : next;
      state = { ...state, ...patch };
      emit();
    },
    reset() {
      state = initial();
      emit();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ---------------------------------------------------------------- misc

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Cadence` : 'Cadence · shielded standing orders';
  }, [title]);
}
