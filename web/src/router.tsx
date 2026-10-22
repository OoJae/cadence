/**
 * A 60-line History API router: no dependency, no hash routing (the fragment is
 * reserved for offer data, which must never reach a server).
 */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

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

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const before = location.pathname;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAV_EVENT));
  if (location.pathname !== before) {
    window.scrollTo({ top: 0 });
    // Move focus to the new page for screen readers and keyboard users.
    requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
  }
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
