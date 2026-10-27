/**
 * A 60-line History API router: no dependency, no hash routing (the fragment is
 * reserved for offer data, which must never reach a server).
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { DUR, EASE_TOGGLE, motionOk } from './motion/tokens';

const NAV_EVENT = 'cadence:navigate';

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener('hashchange', cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener('hashchange', cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

const snapshot = () => location.pathname + location.search + location.hash;

export interface Loc {
  pathname: string;
  search: URLSearchParams;
  hash: string;
}

export function useLocation(): Loc {
  const href = useSyncExternalStore(subscribe, snapshot, () => '/');
  const url = new URL(href, 'http://local');
  return { pathname: url.pathname, search: url.searchParams, hash: url.hash };
}

// The href a view transition has yet to commit, and which transition owns html.vt-nav.
let pending: string | null = null;
let transitions = 0;

const focusMain = () => document.getElementById('main')?.focus({ preventScroll: true });
const ignore = () => {};

/**
 * Only a push to another page animates. Replaces, the browser's back button, and
 * hash or query changes (/subscribe#offer=, /status#sub=, ?compare=, ?nf=) swap at
 * once, as do reduced-motion and browsers without view transitions.
 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = new URL(to, location.href);
  const href = target.pathname + target.search + target.hash;
  // A second click while the first transition is still capturing the old page.
  if (href === pending) return;
  const pathChanges = target.pathname !== new URL(pending ?? location.href, location.href).pathname;
  const commit = () => {
    if (pending === href) pending = null;
    const before = location.pathname;
    if (opts.replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    window.dispatchEvent(new Event(NAV_EVENT));
    if (location.pathname !== before) window.scrollTo({ top: 0, behavior: 'instant' });
  };

  const animate = pathChanges && !opts.replace && typeof document.startViewTransition === 'function' && motionOk();
  if (!animate) {
    commit();
    // Move focus to the new page for screen readers and keyboard users.
    if (pathChanges) requestAnimationFrame(focusMain);
    return;
  }
  pending = href;
  transition(commit);
}

/** The page change itself; motion.css holds the choreography. */
function transition(commit: () => void): void {
  const html = document.documentElement;
  const id = ++transitions;
  // motion.css names the page, masthead, nav mark and tip line only while this is set,
  // so nothing else on any page lives in a stacking context it did not ask for.
  html.classList.add('vt-nav');
  // The old page is captured where it was scrolled to; the new one starts at the top.
  html.style.setProperty('--vt-scroll', `${-Math.round(window.scrollY)}px`);
  // Every caller is an event handler, so flushSync never runs inside a React render.
  const vt = document.startViewTransition(() => flushSync(commit));
  vt.updateCallbackDone.then(focusMain, focusMain);

  let tip: Animation | undefined;
  // ready rejects when a newer navigation skips this one; that one draws its own line.
  vt.ready.then(() => {
    // The pulled rung crossing the page, bottom to top.
    tip = document.querySelector<HTMLElement>('.tip-line')?.animate(
      [
        { transform: 'translateY(100vh)', opacity: 0 },
        { opacity: 0.7, offset: 0.12 },
        { opacity: 0.7, offset: 0.85 },
        { transform: 'translateY(0)', opacity: 0 },
      ],
      { duration: DUR.page, easing: EASE_TOGGLE },
    );
    // While a view transition runs, every click lands on <html>. Ease-reveal has covered
    // 97% of the new page's rise by half its run and the rest is invisible, so the page
    // takes clicks again from there instead of after the whole 0.9 s.
    const rise = document.getAnimations().find((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-new(page)');
    const timing = rise?.effect?.getComputedTiming();
    if (!rise || !timing) return;
    const settled = Number(timing.delay) + Number(timing.duration) / 2;
    const watch = () => {
      if (rise.playState !== 'running') return;
      if (Number(rise.currentTime) >= settled) vt.skipTransition();
      else requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }, ignore);

  // The snapshots are sized to the viewport they were taken in, and a rotation or a
  // full-page capture (which resizes and restores it) would stretch them: then the new page
  // simply stays, at rest. A height-only change is a phone's toolbar sliding, and harmless.
  const [w0, h0] = [window.innerWidth, window.innerHeight];
  const onResize = () => {
    if (window.innerWidth === w0 && window.innerHeight !== h0) return;
    vt.skipTransition();
    tip?.cancel();
  };
  window.addEventListener('resize', onResize);
  vt.finished.then(ignore, ignore).then(() => {
    window.removeEventListener('resize', onResize);
    if (id !== transitions) return;
    html.classList.remove('vt-nav');
    html.style.removeProperty('--vt-scroll');
  });
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(s[i]!);
      } catch {
        return null;
      }
    } else if (part !== s[i]) return null;
  }
  return params;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; children?: ReactNode };

export function Link({ to, onClick, ...rest }: LinkProps) {
  const { pathname } = useLocation();
  const current = to.split(/[?#]/)[0] === pathname;
  return (
    <a
      href={to}
      aria-current={current ? 'page' : undefined}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!to.startsWith('/')) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
