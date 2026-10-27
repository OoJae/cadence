import { useSyncExternalStore } from 'react';
import { roundAt, roundTime } from '../lib/drand';

// One clock for every round display on the page. It ticks on drand quicknet's true round
// boundaries, counted from genesis on this device's clock: no network call, ever. The
// timer exists only while something is subscribed and the tab is visible.

let round = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const nowRound = () => roundAt(Date.now() / 1000);

function arm() {
  clearTimeout(timer);
  timer = undefined;
  if (!listeners.size || document.visibilityState === 'hidden') return;
  // 20 ms past the boundary, so the new round has certainly begun.
  timer = setTimeout(tick, Math.max(0, roundTime(round + 1) * 1000 - Date.now() + 20));
}

function tick() {
  const next = nowRound();
  if (next !== round) {
    round = next;
    for (const l of listeners) l();
  }
  arm();
}

function onVisibility() {
  if (document.visibilityState === 'visible') tick();
  else arm();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisibility);
    tick();
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
      timer = undefined;
      // The next page that shows the round starts from now, not from where this one left.
      round = 0;
    }
  };
}

const snapshot = () => (round ||= nowRound());

/** The current drand quicknet round, re-rendering on each new one (every 3 s). */
export function useDrandRound(): number {
  return useSyncExternalStore(subscribe, snapshot, () => 0);
}
