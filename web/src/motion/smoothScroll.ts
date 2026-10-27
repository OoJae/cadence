import Lenis from 'lenis';
import { useEffect, useRef, type RefObject } from 'react';

/**
 * Lenis smooth scrolling for a long page (the landing, /brand), only while motion is
 * allowed. It eases the wheel and nothing else: no pinning, no snapping, native touch.
 * Tables that scroll sideways keep their own scrolling. Destroyed on unmount.
 */
export function useSmoothScroll(): RefObject<Lenis | null> {
  const lenis = useRef<Lenis | null>(null);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: no-preference)');
    const sync = () => {
      if (query.matches && !lenis.current) {
        lenis.current = new Lenis({ lerp: 0.1, syncTouch: false, autoRaf: true, prevent: (n) => !!n.closest('.table-wrap') });
      } else if (!query.matches && lenis.current) {
        lenis.current.destroy();
        lenis.current = null;
      }
    };
    sync();
    query.addEventListener('change', sync);
    return () => {
      query.removeEventListener('change', sync);
      lenis.current?.destroy();
      lenis.current = null;
    };
  }, []);
  return lenis;
}

/** Scrolls an element into view: eased by Lenis when it runs, instant under reduced motion. */
export function scrollToElement(el: HTMLElement, lenis: Lenis | null, offset = 0): void {
  if (lenis) lenis.scrollTo(el, { offset: -offset });
  else el.scrollIntoView({ block: 'start' });
}
