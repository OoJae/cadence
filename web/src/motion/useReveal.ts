import { useEffect, type RefObject } from 'react';
import { motionOk } from './tokens';

/**
 * Scroll reveals for every [data-reveal] inside `root`: masked lines rise, paragraphs fade
 * up 12 px, once, as their top passes 85% of the viewport.
 *
 * Nothing is hidden until the first real scroll (scrollY > 0), and then only what is still
 * wholly below the viewport. What has been seen never disappears, and a full-page capture
 * taken without scrolling shows every section. The hidden state itself is CSS scoped to
 * html.motion-ok, so reduced motion sees the final state.
 *
 * Elements marked data-reveal-on="moment" are armed the same way but revealed by their
 * owner (see revealNow), not by scrolling.
 */
export function useReveals(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current;
    if (!el || !motionOk() || typeof IntersectionObserver !== 'function') return;
    let io: IntersectionObserver | null = null;
    const arm = () => {
      if (window.scrollY <= 0) return;
      window.removeEventListener('scroll', arm);
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            io?.unobserve(e.target);
            (e.target as HTMLElement).dataset.revealState = 'in';
          }
        },
        { rootMargin: '0px 0px -15% 0px' },
      );
      const fold = window.innerHeight;
      for (const t of el.querySelectorAll<HTMLElement>('[data-reveal]')) {
        if (t.dataset.revealState || t.getBoundingClientRect().top <= fold) continue;
        t.dataset.revealState = 'pending';
        if (t.dataset.revealOn !== 'moment') io.observe(t);
      }
    };
    window.addEventListener('scroll', arm, { passive: true });
    return () => {
      window.removeEventListener('scroll', arm);
      io?.disconnect();
    };
  }, [root]);
}

/** Reveals an armed element now (after `delayMs`), or does nothing if it was never hidden. */
export function revealNow(el: HTMLElement | null, delayMs = 0): void {
  if (!el || el.dataset.revealState !== 'pending') return;
  el.style.setProperty('--reveal-delay', `${delayMs}ms`);
  el.dataset.revealState = 'in';
}
