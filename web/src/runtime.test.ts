import { afterEach, describe, expect, it, vi } from 'vitest';
import { CadenceClient, type ApiRequest, type Transport } from './api/client';

const SANDBOX = 'https://sandbox-production-1e16.up.railway.app';
const MAIN = 'https://main-production-d975.up.railway.app';

/** A fresh runtime.ts, evaluated with these build settings. */
async function runtimeWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('./runtime');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('runtime on an app host (VITE_API=runners)', () => {
  const env = { VITE_API: 'runners', VITE_RUNNERS: `${MAIN}, ${SANDBOX}/`, VITE_DEFAULT_RUNNER: SANDBOX };

  it('knows exactly the listed runners, the default first, and talks to no other', async () => {
    const rt = await runtimeWith(env);
    expect(rt.isMock).toBe(false);
    expect(rt.runners.map((r) => r.origin)).toEqual([SANDBOX, MAIN]);
    expect(rt.connectTargets).toEqual([SANDBOX, MAIN]);
    expect(rt.defaultRunner.origin).toBe(SANDBOX);
    expect(rt.api).toBe(rt.defaultRunner.api);
    expect(rt.runnerUrl).toBe(SANDBOX);
    expect(rt.apiLabel).toBe('sandbox-production-1e16.up.railway.app');
    expect(rt.runnersText).toBe(`${SANDBOX} or ${MAIN}`);
  });

  it("picks the runner an offer or a cancel key names, by origin, with one client per runner", async () => {
    const rt = await runtimeWith(env);
    const main = rt.runners[1]!;
    const pick = rt.pickRunner(`${MAIN}/`, 'offer');
    expect(pick).toEqual({ ok: true, runner: main });
    expect(rt.apiFor(MAIN)).toBe(main.api);
    expect(rt.apiFor(`${SANDBOX}/whatever`)).toBe(rt.api);
    expect((main.api.transport as unknown as { base: string }).base).toBe(MAIN);
  });

  it("refuses any other runner and says where to go instead", async () => {
    const rt = await runtimeWith(env);
    expect(rt.apiFor('https://evil.example')).toBeNull();
    expect(rt.apiFor('http://main-production-d975.up.railway.app')).toBeNull();
    const offer = rt.pickRunner('https://evil.example', 'offer');
    expect(offer.ok).toBe(false);
    if (offer.ok) return;
    expect(offer.message).toContain(`this app talks only to ${SANDBOX} and ${MAIN}`);
    expect(offer.message).toContain('https://evil.example/subscribe');
    const key = rt.pickRunner('https://evil.example', 'cancel key');
    expect(!key.ok && key.message).toContain('https://evil.example/manage');
  });

  it('a later runner fails every request until /manage picks one, then forwards to it', async () => {
    const rt = await runtimeWith(env);
    const later = rt.laterRunner();
    // (resetModules gives runtime.ts its own copy of ApiError, so match by shape.)
    await expect(later.api.status()).rejects.toMatchObject({ name: 'ApiError', status: 0 });
    const seen: ApiRequest[] = [];
    const fake: Transport = {
      label: 'fake',
      request: async <T,>(req: ApiRequest) => {
        seen.push(req);
        return { network: 'test', tip: 1 } as T;
      },
    };
    later.use({ url: MAIN, origin: MAIN, label: 'fake', api: new CadenceClient(fake) });
    expect(later.api.transport.label).toBe('fake');
    await expect(later.api.status()).resolves.toEqual({ network: 'test', tip: 1 });
    expect(seen.map((r) => r.path)).toEqual(['/api/status']);
  });

  it('asks the other runner when the default does not know an id, and says which one answered', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(MAIN) ? new Response(JSON.stringify({ subscription_id: 'sub_x' }), { status: 200 }) : new Response(JSON.stringify({ error: 'no such subscription' }), { status: 404 }),
    );
    vi.stubGlobal('fetch', fetch);
    const rt = await runtimeWith(env);
    expect(rt.manyRunners).toBe(true);
    const r = await rt.askRunners((c) => c.getSubscription('sub_x'));
    expect(r.runner.origin).toBe(MAIN);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`${SANDBOX}/api/subscriptions/sub_x`, `${MAIN}/api/subscriptions/sub_x`]);
    expect(rt.runnerName(r.runner, 'main')).toBe('the mainnet runner (main-production-d975.up.railway.app)');
    // Asked from the runner that answered, it goes there first.
    fetch.mockClear();
    await rt.askRunners((c) => c.decode('ab'.repeat(32)), r.runner);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`${MAIN}/api/decode/${'ab'.repeat(32)}`]);
  });

  it('makes no request when loaded, and reads build.json from its own origin only, once', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const rt = await runtimeWith(env);
    expect(fetch).not.toHaveBeenCalled();
    await expect(rt.loadBuildInfo()).resolves.toBeNull();
    await rt.loadBuildInfo();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/build.json', expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })]);
  });
});

describe('runtime with one runner', () => {
  it('VITE_API=self: the same origin, as before', async () => {
    const rt = await runtimeWith({ VITE_API: 'self' });
    expect(rt.runners).toHaveLength(1);
    expect(rt.apiLabel).toBe('same-origin runner');
    expect(rt.connectTargets).toEqual([rt.runnerUrl]);
    expect(rt.pickRunner(`${rt.runnerUrl}/`, 'offer').ok).toBe(true);
    const other = rt.pickRunner(MAIN, 'offer');
    expect(!other.ok && other.message).toBe(`This offer names the runner ${MAIN}, but this page is built to talk only to ${rt.runnerUrl}. Open the link on that runner's own page.`);
  });

  it('a 404 from the one runner stands: there is no other to ask', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'no such subscription' }), { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const rt = await runtimeWith({ VITE_API: 'self' });
    expect(rt.manyRunners).toBe(false);
    await expect(rt.askRunners((c) => c.getSubscription('sub_x'))).rejects.toMatchObject({ status: 404, message: 'no such subscription' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('VITE_API=<url>: that runner, path included', async () => {
    const rt = await runtimeWith({ VITE_API: `${MAIN}/cadence/` });
    expect(rt.runnerUrl).toBe(`${MAIN}/cadence`);
    expect(rt.connectTargets).toEqual([MAIN]);
    expect(rt.apiFor(`${MAIN}/cadence`)).toBe(rt.api);
    expect(rt.apiFor(SANDBOX)).toBeNull();
  });

  it('VITE_API=mock: the in-page runner stands in for every runner', async () => {
    const rt = await runtimeWith({ VITE_API: 'mock' });
    expect(rt.isMock).toBe(true);
    expect(rt.connectTargets).toEqual([]);
    expect(rt.apiFor('https://anything.example')).toBe(rt.api);
    expect(rt.pickRunner('https://anything.example', 'offer')).toEqual({ ok: true, runner: rt.defaultRunner });
  });
});
