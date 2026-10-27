import { useEffect, useRef, type RefObject } from 'react';
import type { BeatId } from '../stage/timeline';

export interface BeatHandlers {
  /** The passage crossing mid-viewport changed: [data-beat], or a [data-sub] inside one. */
  beat(beat: BeatId): void;
  /** A [data-moment] element crossed mid-viewport, once per page view. */
  moment(name: string): void;
}

/**
 * One IntersectionObserver whose root is a zero-height line at mid-viewport. The passage
 * on that line is the active beat; a sub-beat inside it wins while it is on the line.
 */
export function observeBeats(root: HTMLElement, on: BeatHandlers): () => void {
  const beats = [...root.querySelectorAll<HTMLElement>('[data-beat]')];
  const subs = [...root.querySelectorAll<HTMLElement>('[data-sub]')];
  const moments = [...root.querySelectorAll<HTMLElement>('[data-moment]')];
  const live = new Set<Element>();
  let current: BeatId | null = null;

  // A capture that sizes the viewport to the whole page has no reading position: keep the
  // poster rather than whichever passage happens to sit at the page's middle.
  const whole = () => root.getBoundingClientRect().height <= window.innerHeight;

  const io = new IntersectionObserver(
    (entries) => {
      const flat = whole();
      for (const e of entries) {
        if (e.isIntersecting) live.add(e.target);
        else live.delete(e.target);
        const name = (e.target as HTMLElement).dataset.moment;
        if (name && e.isIntersecting && !flat) {
          io.unobserve(e.target);
          on.moment(name);
        }
      }
      let next: BeatId | null = flat ? 'hero' : null;
      for (const el of subs) if (!next && live.has(el)) next = el.dataset.sub as BeatId;
      for (const el of beats) if (!next && live.has(el)) next = el.dataset.beat as BeatId;
      if (next && next !== current) {
        current = next;
        on.beat(next);
      }
    },
    { rootMargin: '-50% 0px -50% 0px' },
  );
  for (const el of [...beats, ...subs, ...moments]) io.observe(el);
  return () => io.disconnect();
}

/** observeBeats for a component's lifetime. Handlers may change between renders. */
export function useBeats(root: RefObject<HTMLElement | null>, handlers: BeatHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    return observeBeats(el, { beat: (b) => latest.current.beat(b), moment: (m) => latest.current.moment(m) });
  }, [root]);
}
