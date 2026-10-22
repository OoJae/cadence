import { describe, expect, it } from 'vitest';
import { parseApiSetting } from './apiSetting';
import { buildCsp } from './csp';

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

  it('adds exactly the configured runner origin to connect-src', () => {
    const csp = buildCsp(parseApiSetting('https://runner.example/api-root'), 'build');
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://runner.example");
    expect(directive(csp, 'img-src')).toBe("img-src 'self'");
  });
});
