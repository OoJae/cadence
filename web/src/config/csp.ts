import type { ApiSetting } from './apiSetting.ts';
import type { SignerSetting } from './signerSetting.ts';

/** The one Trusted Types policy a WASM-signer build may create: same-origin worker script URLs only. */
export const WORKER_TRUSTED_TYPES_POLICY = 'cadence-worker';

/**
 * The Content-Security-Policy shipped in index.html.
 *
 * Production (`vite build`, also what `vite preview` serves):
 *   - everything is 'self'; the only extra origin is the configured runner in connect-src
 *   - no inline scripts or styles, no eval
 *   - 'wasm-unsafe-eval' lets the upcoming WASM signer compile its module; it does not
 *     allow JavaScript eval
 *   - Trusted Types are required, so no code path can assign strings to innerHTML.
 *     Mock builds allow no policy at all. WASM-signer builds allow exactly one,
 *     'cadence-worker', because `new Worker(url)` is a Trusted Types sink; it only
 *     passes same-origin http(s) script URLs (src/signer/wasmPool.ts)
 *
 * Development (`vite dev`) needs inline scripts and styles for hot reload, plus a
 * websocket back to the dev server, so it gets a looser policy. Never deploy dev output.
 *
 * frame-ancestors cannot be set from a meta tag; see README for the response headers.
 */
export function buildCsp(api: ApiSetting, command: 'build' | 'serve', signer: SignerSetting = 'mock'): string {
  const connect = ["'self'"];
  if (api.kind === 'http' && api.origin) connect.push(api.origin);
  const dev = command === 'serve';
  if (dev) connect.push('ws:', 'wss:');

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', dev ? ["'self'", "'unsafe-inline'"] : ["'self'", "'wasm-unsafe-eval'"]],
    ['style-src', dev ? ["'self'", "'unsafe-inline'"] : ["'self'"]],
    ['img-src', ["'self'"]],
    ['font-src', ["'self'"]],
    ['connect-src', connect],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ];
  if (!dev) {
    directives.push(['require-trusted-types-for', ["'script'"]], ['trusted-types', [signer === 'wasm' ? WORKER_TRUSTED_TYPES_POLICY : "'none'"]]);
  }
  return directives.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}
