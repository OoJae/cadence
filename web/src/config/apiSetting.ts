/**
 * Parses the `VITE_API` build setting, and for `runners` also `VITE_RUNNERS` and
 * `VITE_DEFAULT_RUNNER`. Shared by the app and by vite.config.ts, which turns the
 * result into the Content-Security-Policy `connect-src`.
 *
 *   VITE_API=mock                      in-memory mock runner (default, no network at all)
 *   VITE_API=self                      the runner serves this app; same origin
 *   VITE_API=https://runner.example    a runner on another origin (added to connect-src)
 *   VITE_API=http://xyz….onion         a runner behind a Tor onion service
 *   VITE_API=runners                   an app host of its own, so no runner serves the code
 *                                      that holds the pocket key. It talks to each origin in
 *                                      VITE_RUNNERS (comma-separated, all added to connect-src)
 *                                      and to no other. VITE_DEFAULT_RUNNER (default: the first)
 *                                      serves the pages that have no runner of their own.
 */
export type ApiSetting =
  | { kind: 'mock' }
  | { kind: 'http'; /** Prefix for every request path, without a trailing slash. */ base: string; /** Origin to add to connect-src, or null when same-origin. */ origin: string | null }
  | { kind: 'runners'; /** Runner origins, in the order given, without duplicates. */ runners: string[]; /** One of `runners`. */ defaultRunner: string };

/** `VITE_RUNNERS` and `VITE_DEFAULT_RUNNER`, read only with `VITE_API=runners`. */
export interface RunnersEnv {
  runners?: string;
  defaultRunner?: string;
}

/** An absolute runner URL: https, or http for .onion and localhost only; no credentials, query or fragment. */
function runnerUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(name === 'VITE_API' ? `VITE_API must be "mock", "self", "runners" or an absolute URL, got "${value}"` : `${name} must list absolute URLs, got "${value}"`);
  }
  const onion = url.hostname.endsWith('.onion');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (onion || local))) {
    throw new Error(`${name} must use https (http is accepted only for .onion and localhost), got "${value}"`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not carry credentials, a query or a fragment`);
  }
  // URL accepts "*" (and other CSP syntax) in a host; connect-src must get one exact host.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(url.hostname) && !/^\[[0-9a-f:.]+\]$/.test(url.hostname)) {
    throw new Error(`${name} must name one exact host (no wildcards), got "${value}"`);
  }
  return url;
}

/** A runner origin, as VITE_RUNNERS lists them: scheme, host and port only. */
function runnerOrigin(value: string, name: string): string {
  const url = runnerUrl(value, name);
  if (url.pathname !== '/') throw new Error(`${name} lists origins only (scheme://host[:port], no path), got "${value}"`);
  return url.origin;
}

function parseRunners(env: RunnersEnv): ApiSetting {
  const runners: string[] = [];
  for (const entry of (env.runners ?? '').split(',')) {
    if (!entry.trim()) continue;
    const origin = runnerOrigin(entry.trim(), 'VITE_RUNNERS');
    if (!runners.includes(origin)) runners.push(origin);
  }
  if (runners.length === 0) throw new Error('VITE_API=runners needs VITE_RUNNERS: a comma-separated list of runner origins');
  const named = (env.defaultRunner ?? '').trim();
  const defaultRunner = named ? runnerOrigin(named, 'VITE_DEFAULT_RUNNER') : runners[0]!;
  if (!runners.includes(defaultRunner)) throw new Error(`VITE_DEFAULT_RUNNER must be one of VITE_RUNNERS, got "${named}"`);
  return { kind: 'runners', runners, defaultRunner };
}

export function parseApiSetting(raw: string | undefined, env: RunnersEnv = {}): ApiSetting {
  const value = (raw ?? '').trim();
  if (value === 'runners') return parseRunners(env);
  if ((env.runners ?? '').trim() || (env.defaultRunner ?? '').trim()) {
    throw new Error('VITE_RUNNERS and VITE_DEFAULT_RUNNER are read only with VITE_API=runners');
  }
  if (value === '' || value === 'mock') return { kind: 'mock' };
  if (value === 'self' || value === '/') return { kind: 'http', base: '', origin: null };

  const url = runnerUrl(value, 'VITE_API');
  const path = url.pathname.replace(/\/+$/, '');
  return { kind: 'http', base: url.origin + path, origin: url.origin };
}
