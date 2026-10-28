import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextPollMs } from '../hooks';
import { ApiError, isBusy } from './client';
import { HttpTransport, retryAfterSecs } from './http';

afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: string, headers: Record<string, string> = {}) {
  vi.stubGlobal('fetch', async () => new Response(body, { status, headers }));
  return new HttpTransport('https://runner.example').request({ method: 'GET', path: '/api/status' });
}

describe('a busy runner (429)', () => {
  it("says when to try again, from Retry-After, whatever the body is", async () => {
    const e = await answer(429, JSON.stringify({ error: 'the sandbox faucet is rate limited; try again in 2 min' }), { 'Retry-After': '17' }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 429, message: 'The runner is busy; try again in 17 s', retryAfterSecs: 17 });
    expect(isBusy(e)).toBe(true);
    const plain = await answer(429, 'Too Many Requests', { 'Retry-After': '3' }).catch((x) => x);
    expect(plain).toMatchObject({ status: 429, message: 'The runner is busy; try again in 3 s', retryAfterSecs: 3 });
  });

  it('still reads as busy when the header is missing or unreadable (a cross-origin page sees it only if the runner exposes it)', async () => {
    const e = (await answer(429, '').catch((x) => x)) as ApiError;
    expect(e).toMatchObject({ status: 429, message: 'The runner is busy; try again in a few seconds' });
    expect(e.retryAfterSecs).toBeUndefined();
  });

  it('leaves every other error as the runner wrote it', async () => {
    const e = await answer(409, JSON.stringify({ error: 'installment 3 opens in 41 s' })).catch((x) => x);
    expect(e).toMatchObject({ status: 409, message: 'installment 3 opens in 41 s' });
    expect(isBusy(e)).toBe(false);
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.UTC(2026, 9, 28, 12);
    expect(retryAfterSecs('0', now)).toBe(0);
    expect(retryAfterSecs(' 120 ', now)).toBe(120);
    expect(retryAfterSecs(new Date(now + 30_500).toUTCString(), now)).toBe(30);
    expect(retryAfterSecs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
    expect(retryAfterSecs('soon', now)).toBeNull();
    expect(retryAfterSecs('-5', now)).toBeNull();
    expect(retryAfterSecs(null, now)).toBeNull();
  });

  it('makes a poll wait at least as long as the runner asked, even a one-shot fetch', () => {
    const busy = (secs?: number) => new ApiError(429, 'busy', secs);
    expect(nextPollMs(3_000, busy(20))).toBe(20_000);
    expect(nextPollMs(30_000, busy(20))).toBe(30_000);
    expect(nextPollMs(0, busy(20))).toBe(20_000);
    expect(nextPollMs(0, busy())).toBe(5_000);
    expect(nextPollMs(3_000, new ApiError(502, 'HTTP 502'))).toBe(3_000);
    expect(nextPollMs(0, new ApiError(502, 'HTTP 502'))).toBe(0);
    expect(nextPollMs(1_000)).toBe(1_000);
  });
});
