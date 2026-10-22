/**
 * Parses the `VITE_API` build setting. Shared by the app and by vite.config.ts,
 * which turns the result into the Content-Security-Policy `connect-src`.
 *
 *   VITE_API=mock                      in-memory mock runner (default, no network at all)
 *   VITE_API=self                      the runner serves this app; same origin
 *   VITE_API=https://runner.example    a runner on another origin (added to connect-src)
 *   VITE_API=http://xyz….onion         a runner behind a Tor onion service
 */
export type ApiSetting =
  | { kind: 'mock' }
  | { kind: 'http'; /** Prefix for every request path, without a trailing slash. */ base: string; /** Origin to add to connect-src, or null when same-origin. */ origin: string | null };

export function parseApiSetting(raw: string | undefined): ApiSetting {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'mock') return { kind: 'mock' };
  if (value === 'self' || value === '/') return { kind: 'http', base: '', origin: null };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_API must be "mock", "self" or an absolute URL, got "${value}"`);
  }
  const onion = url.hostname.endsWith('.onion');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (onion || local))) {
    throw new Error(`VITE_API must use https (http is accepted only for .onion and localhost), got "${value}"`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('VITE_API must not carry credentials, a query or a fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { kind: 'http', base: url.origin + path, origin: url.origin };
}
