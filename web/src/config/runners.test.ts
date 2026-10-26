import { describe, expect, it } from 'vitest';
import { listRunners, matchRunner, unknownRunnerMessage } from './runners';

const SANDBOX = { url: 'https://sandbox-production-1e16.up.railway.app', origin: 'https://sandbox-production-1e16.up.railway.app' };
const MAIN = { url: 'https://main-production-d975.up.railway.app', origin: 'https://main-production-d975.up.railway.app' };
const known = [SANDBOX, MAIN];

describe('runner selection', () => {
  it('matches a named runner by origin only', () => {
    expect(matchRunner(known, MAIN.url)).toBe(MAIN);
    expect(matchRunner(known, `${MAIN.url}/`)).toBe(MAIN);
    expect(matchRunner(known, ` ${SANDBOX.url}/some/path `)).toBe(SANDBOX);
    expect(matchRunner(known, 'HTTPS://MAIN-PRODUCTION-D975.UP.RAILWAY.APP')).toBe(MAIN);
  });

  it('matches nothing else', () => {
    expect(matchRunner(known, 'https://evil.example')).toBeNull();
    // Same host, other scheme or port: another origin.
    expect(matchRunner(known, 'http://main-production-d975.up.railway.app')).toBeNull();
    expect(matchRunner(known, 'https://main-production-d975.up.railway.app:8443')).toBeNull();
    // A lookalike host.
    expect(matchRunner(known, 'https://main-production-d975.up.railway.app.evil.example')).toBeNull();
    expect(matchRunner(known, 'https://sub.sandbox-production-1e16.up.railway.app')).toBeNull();
    expect(matchRunner(known, 'not a url')).toBeNull();
    expect(matchRunner(known, '')).toBeNull();
    expect(matchRunner(known, 'javascript:alert(1)')).toBeNull();
    expect(matchRunner(known, 'data:text/plain,x')).toBeNull();
    expect(matchRunner([], MAIN.url)).toBeNull();
  });

  it('lists runners for copy', () => {
    expect(listRunners([])).toBe('no runner');
    expect(listRunners(['A'])).toBe('A');
    expect(listRunners(['A', 'B'])).toBe('A and B');
    expect(listRunners(['A', 'B', 'C'], 'or')).toBe('A, B or C');
  });
});

describe('unknown runner messages', () => {
  it("on an app host, name every known runner and point to the runner's own app", () => {
    const offer = unknownRunnerMessage('https://other.example/', 'offer', known, true);
    expect(offer).toBe(
      `This offer names the runner https://other.example/, but this app talks only to ${SANDBOX.origin} and ${MAIN.origin}. Open the link in that runner's own app instead: https://other.example/subscribe with the same #offer=… part.`,
    );
    const key = unknownRunnerMessage('https://other.example', 'cancel key', known, true);
    expect(key).toBe(
      `This cancel key belongs to the runner at https://other.example, but this app talks only to ${SANDBOX.url} and ${MAIN.url}. Open it in that runner's own app (https://other.example/manage) instead, or use the CLI.`,
    );
  });

  it('with one runner, keep the wording /subscribe and kitTargetProblem() always used', () => {
    const self = [{ url: 'https://app.example', origin: 'https://app.example' }];
    expect(unknownRunnerMessage('https://other.example', 'offer', self, false)).toBe(
      "This offer names the runner https://other.example, but this page is built to talk only to https://app.example. Open the link on that runner's own page.",
    );
    expect(unknownRunnerMessage('https://other.example/', 'cancel key', self, false)).toBe(
      'This cancel key belongs to the runner at https://other.example/, but this page talks only to https://app.example. Open https://other.example/manage instead, or use the CLI.',
    );
  });
});
