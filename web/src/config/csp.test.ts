import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseApiSetting } from './apiSetting';
import { buildCsp, buildHeaderCsp, runnerOrigins } from './csp';
import { parseSignerSetting } from './signerSetting';

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const SANDBOX = 'https://sandbox-production-1e16.up.railway.app';
const MAIN = 'https://main-production-d975.up.railway.app';
const appHost = parseApiSetting('runners', { runners: `${SANDBOX},${MAIN}`, defaultRunner: SANDBOX });

const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));

describe('VITE_API setting', () => {
  it('defaults to the in-memory mock', () => {
    expect(parseApiSetting(undefined)).toEqual({ kind: 'mock' });
    expect(parseApiSetting('')).toEqual({ kind: 'mock' });
    expect(parseApiSetting('mock')).toEqual({ kind: 'mock' });
  });

  it('accepts https, same-origin and onion runners', () => {
    expect(parseApiSetting('https://runner.example/')).toEqual({ kind: 'http', base: 'https://runner.example', origin: 'https://runner.example' });
    expect(parseApiSetting('https://x.example/cadence/')).toEqual({ kind: 'http', base: 'https://x.example/cadence', origin: 'https://x.example' });
    expect(parseApiSetting('self')).toEqual({ kind: 'http', base: '', origin: null });
    expect(parseApiSetting('http://abcdefghijklmnop.onion').kind).toBe('http');
  });

  it('refuses plain http to the open internet, credentials and junk', () => {
    expect(() => parseApiSetting('http://runner.example')).toThrow(/https/);
    expect(() => parseApiSetting('https://user:pw@runner.example')).toThrow();
    expect(() => parseApiSetting('runner.example')).toThrow();
    expect(() => parseApiSetting('https://*.example')).toThrow(/no wildcards/);
    expect(parseApiSetting('https://xn--bcher-kva.example').kind).toBe('http');
    expect(parseApiSetting('http://[::1]:8737').kind).toBe('http');
  });

  it('reads VITE_RUNNERS and VITE_DEFAULT_RUNNER for an app host of its own', () => {
    expect(appHost).toEqual({ kind: 'runners', runners: [SANDBOX, MAIN], defaultRunner: SANDBOX });
    // Trailing slashes, spaces, empty entries and duplicates; the default is the first unless named.
    expect(parseApiSetting(' runners ', { runners: ` ${MAIN}/ , ,${SANDBOX},${MAIN}` })).toEqual({ kind: 'runners', runners: [MAIN, SANDBOX], defaultRunner: MAIN });
    expect(parseApiSetting('runners', { runners: 'http://abcdefghijklmnop.onion,http://localhost:8737' }).kind).toBe('runners');
  });

  it('refuses a runner list it cannot pin down to origins', () => {
    expect(() => parseApiSetting('runners')).toThrow(/VITE_RUNNERS/);
    expect(() => parseApiSetting('runners', { runners: ' , ' })).toThrow(/VITE_RUNNERS/);
    expect(() => parseApiSetting('runners', { runners: 'https://runner.example/cadence' })).toThrow(/origins only/);
    expect(() => parseApiSetting('runners', { runners: 'http://runner.example' })).toThrow(/https/);
    expect(() => parseApiSetting('runners', { runners: 'https://*.up.railway.app' })).toThrow(/no wildcards/);
    expect(() => parseApiSetting('runners', { runners: "https://a.example 'unsafe-inline'" })).toThrow();
    expect(() => parseApiSetting('runners', { runners: 'https://user:pw@runner.example' })).toThrow(/credentials/);
    expect(() => parseApiSetting('runners', { runners: 'https://runner.example?x=1' })).toThrow(/query/);
    expect(() => parseApiSetting('runners', { runners: 'runner.example' })).toThrow(/absolute/);
    expect(() => parseApiSetting('runners', { runners: SANDBOX, defaultRunner: MAIN })).toThrow(/VITE_DEFAULT_RUNNER/);
  });

  it('refuses runner variables in any other mode, so a build is never silently single-runner', () => {
    expect(() => parseApiSetting('self', { runners: SANDBOX })).toThrow(/only with VITE_API=runners/);
    expect(() => parseApiSetting(undefined, { defaultRunner: SANDBOX })).toThrow(/only with VITE_API=runners/);
    expect(parseApiSetting('self', { runners: ' ', defaultRunner: '' })).toEqual({ kind: 'http', base: '', origin: null });
  });
});

describe('VITE_SIGNER setting', () => {
  it('defaults to the mock and accepts wasm', () => {
    expect(parseSignerSetting(undefined)).toBe('mock');
    expect(parseSignerSetting(' mock ')).toBe('mock');
    expect(parseSignerSetting('wasm')).toBe('wasm');
    expect(() => parseSignerSetting('native')).toThrow(/VITE_SIGNER/);
  });
});

describe('Content-Security-Policy', () => {
  it('is self-only in mock builds, with no inline code and no eval', () => {
    const csp = buildCsp({ kind: 'mock' }, 'build');
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(directive(csp, 'style-src')).toBe("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(csp).not.toContain('*');
    expect(csp).not.toMatch(/https?:/);
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'require-trusted-types-for')).toBe("require-trusted-types-for 'script'");
  });

  it('allows one same-origin worker policy, and nothing else, in WASM-signer builds', () => {
    const mock = buildCsp({ kind: 'mock' }, 'build');
    expect(directive(mock, 'trusted-types')).toBe("trusted-types 'none'");
    const csp = buildCsp(parseApiSetting('self'), 'build', 'wasm');
    expect(directive(csp, 'trusted-types')).toBe('trusted-types cadence-worker');
    expect(directive(csp, 'require-trusted-types-for')).toBe("require-trusted-types-for 'script'");
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(directive(csp, 'worker-src')).toBe("worker-src 'self'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(csp).not.toContain('allow-duplicates');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(csp).not.toMatch(/https?:|blob:|data:/);
    expect(csp.replace('trusted-types cadence-worker', "trusted-types 'none'")).toBe(buildCsp(parseApiSetting('self'), 'build'));
  });

  it('adds exactly the configured runner origin to connect-src', () => {
    const csp = buildCsp(parseApiSetting('https://runner.example/api-root'), 'build');
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://runner.example");
    expect(directive(csp, 'img-src')).toBe("img-src 'self'");
  });

  it('on an app host, adds exactly each known runner to connect-src and changes nothing else', () => {
    expect(runnerOrigins(appHost)).toEqual([SANDBOX, MAIN]);
    const csp = buildCsp(appHost, 'build', 'wasm');
    expect(directive(csp, 'connect-src')).toBe(`connect-src 'self' ${SANDBOX} ${MAIN}`);
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(csp).not.toMatch(/blob:|data:|wss?:/);
    // Every other directive is the same-origin WASM build's, Trusted Types and 'wasm-unsafe-eval' included.
    expect(csp.replace(` ${SANDBOX} ${MAIN}`, '')).toBe(buildCsp(parseApiSetting('self'), 'build', 'wasm'));
    expect(directive(csp, 'trusted-types')).toBe('trusted-types cadence-worker');
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });
});

describe('Content-Security-Policy response header', () => {
  it('is the meta policy plus frame-ancestors', () => {
    expect(buildHeaderCsp(appHost, 'wasm')).toBe(`${buildCsp(appHost, 'build', 'wasm')}; frame-ancestors 'none'`);
    expect(directive(buildHeaderCsp(appHost, 'wasm'), 'connect-src')).toBe(`connect-src 'self' ${SANDBOX} ${MAIN}`);
  });

  it("matches what the runner and deploy/Caddyfile send for a same-origin WASM build", () => {
    const rust = /const WEB_CSP: &str = "([^"]*)";/.exec(repoFile('crates/cadence-runner/src/api.rs'));
    expect(rust).not.toBeNull();
    const header = buildHeaderCsp(parseApiSetting('self'), 'wasm');
    expect(rust![1]!.replace(/\\\n\s*/g, '')).toBe(header);
    const caddy = [...repoFile('deploy/Caddyfile').matchAll(/Content-Security-Policy "([^"]*)"/g)].map((m) => m[1]);
    expect(caddy.length).toBeGreaterThan(0);
    for (const policy of caddy) expect(policy).toBe(header);
  });

  it("is what deploy/railway-app/Caddyfile sends: the build's csp.txt, beside the same other headers as deploy/Caddyfile", () => {
    const headers = (caddyfile: string) => {
      const block = /\theader \{\n([\s\S]*?)\n\t\}/.exec(caddyfile)![1]!;
      return block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    };
    const app = headers(repoFile('deploy/railway-app/Caddyfile'));
    expect(app).toContain('Content-Security-Policy "{file./srv/web/csp.txt}"');
    const others = (h: string[]) => h.filter((l) => !l.startsWith('Content-Security-Policy')).sort();
    expect(others(app)).toEqual(others(headers(repoFile('deploy/Caddyfile'))));
    expect(app).toEqual(expect.arrayContaining(['Cross-Origin-Opener-Policy same-origin', 'Cross-Origin-Embedder-Policy require-corp', 'Cross-Origin-Resource-Policy same-origin', 'X-Content-Type-Options nosniff', 'Referrer-Policy no-referrer']));
  });
});
