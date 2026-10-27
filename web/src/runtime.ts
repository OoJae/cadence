/**
 * Wires the app to either the in-memory mock (VITE_API=mock, the default) or real
 * runners over HTTP. The mock module is loaded with a dynamic import so it is never
 * fetched by builds pointed at a real runner.
 *
 * A build talks to one runner (VITE_API=self or a URL), or, on an app host of its own
 * (VITE_API=runners), to each runner in VITE_RUNNERS and to no other. `api` is the
 * default runner, for pages that have no runner of their own (the sandbox, the
 * merchant dashboard, the decoder). /subscribe and /manage talk to the runner the
 * offer or the cancel key names, through pickRunner(), and only if the build knows it.
 *
 * The signer is the mock unless the build sets VITE_SIGNER=wasm, which ships the
 * real cadence-core signer (src/signer/wasm.ts). That choice is a build-time
 * constant, so mock builds contain no trace of the WASM signer or its workers.
 */
import { ApiError, CadenceClient, type Transport } from './api/client';
import { HttpTransport } from './api/http';
import { parseApiSetting } from './config/apiSetting';
import { BUILD_INFO_FILE, parseBuildInfo, type BuildInfo } from './config/buildInfo';
import { askInTurn, listRunners, matchRunner, unknownRunnerMessage } from './config/runners';
import { MockSigner, UnavailableSigner } from './signer/mock';
import type { Signer } from './signer/types';

export const apiSetting = parseApiSetting(import.meta.env.VITE_API, {
  runners: import.meta.env.VITE_RUNNERS,
  defaultRunner: import.meta.env.VITE_DEFAULT_RUNNER,
});
export const isMock = apiSetting.kind === 'mock';

type MockModule = typeof import('./mock');
const mock: MockModule | null = apiSetting.kind === 'mock' ? await import('./mock') : null;

export const signerSetting = __CADENCE_SIGNER__;
type WasmModule = typeof import('./signer/wasm');
const wasm: WasmModule | null = __CADENCE_SIGNER__ === 'wasm' ? await import('./signer/wasm') : null;

const here = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** A runner this build may talk to. */
export interface Runner {
  /** Its absolute base URL, as offers and cancel keys name it (the CLI connects to it). */
  readonly url: string;
  /** Its origin, as the CSP connect-src allows it. */
  readonly origin: string;
  /** What the UI calls it. */
  readonly label: string;
  readonly api: CadenceClient;
}

function runnerOver(transport: Transport, url: string, origin: string): Runner {
  return { url, origin, label: transport.label, api: new CadenceClient(transport) };
}

/** Every runner this build may talk to, the default first. One client each, made once. */
function knownRunners(): Runner[] {
  if (mock) return [runnerOver(mock.transport, here, here)];
  switch (apiSetting.kind) {
    case 'runners': {
      const all = apiSetting.runners.map((origin) => runnerOver(new HttpTransport(origin), origin, origin));
      return [...all.filter((r) => r.origin === apiSetting.defaultRunner), ...all.filter((r) => r.origin !== apiSetting.defaultRunner)];
    }
    case 'http':
      return apiSetting.origin ? [runnerOver(new HttpTransport(apiSetting.base), apiSetting.base, apiSetting.origin)] : [runnerOver(new HttpTransport(''), here, here)];
    case 'mock':
      throw new Error('unreachable: the mock module is loaded for VITE_API=mock');
  }
}

/** The runners this build may talk to; the first is the default. */
export const runners: readonly Runner[] = knownRunners();
export const defaultRunner: Runner = runners[0]!;

export const api = defaultRunner.api;
export const apiLabel = defaultRunner.label;

/**
 * The default runner's absolute base URL, as a cancel key records it (the CLI connects to it).
 * With VITE_API=self (or the mock) that is this page's own origin.
 */
export const runnerUrl: string = defaultRunner.url;

/** The origins this page may talk to (mirrors the CSP connect-src): exactly the known runners. */
export const connectTargets: string[] = mock ? [] : runners.map((r) => r.origin);

/** The known runners, for copy: "A", "A or B", "A, B or C". */
export const runnersText: string = listRunners(runners.map((r) => r.url), 'or');

/** The known runner a URL names, by origin, or null. In mock builds the in-page runner stands in for every runner. */
export function runnerFor(url: string): Runner | null {
  return mock ? defaultRunner : matchRunner(runners, url);
}

/** The client for a known runner, by its URL or origin; null for a runner this build may not talk to. */
export function apiFor(url: string): CadenceClient | null {
  return runnerFor(url)?.api ?? null;
}

/** Whether this build knows more than one runner (an app host), so pages say which one answered. */
export const manyRunners: boolean = runners.length > 1;

/**
 * Asks the runners this build knows, `first` (default: the default runner) and then the
 * others, until one does not answer 404, and says which one answered: on an app host a
 * subscription or a txid may be another runner's, such as the mainnet runner's. A build
 * with one runner asks only that one, as before.
 */
export function askRunners<T>(ask: (client: CadenceClient) => Promise<T>, first: Runner = defaultRunner): Promise<{ value: T; runner: Runner }> {
  const order = [first, ...runners.filter((r) => r !== first)];
  return askInTurn(order, (r) => ask(r.api), (e) => e instanceof ApiError && e.status === 404);
}

/** "the mainnet runner (host)", from what its status says; just "the runner at host" before that. */
export function runnerName(runner: Runner, network: 'main' | 'test' | undefined): string {
  return network ? `the ${network === 'main' ? 'mainnet' : 'testnet'} runner (${runner.label})` : `the runner at ${runner.label}`;
}

export type RunnerPick = { ok: true; runner: Runner } | { ok: false; message: string };

/** The runner an offer's `runner_endpoint` or a cancel key's `runner` names, or why this page will not talk to it. */
export function pickRunner(named: string, what: 'offer' | 'cancel key'): RunnerPick {
  const runner = runnerFor(named);
  return runner ? { ok: true, runner } : { ok: false, message: unknownRunnerMessage(named, what, runners, apiSetting.kind === 'runners') };
}

/**
 * A client whose runner is picked later: /manage makes the signer before the cancel
 * key it decrypts says which runner it belongs to. Requests fail until use() is called.
 */
export function laterRunner(): { api: CadenceClient; use(runner: Runner): void } {
  let target: Transport | null = null;
  const transport: Transport = {
    get label() {
      return target?.label ?? 'no runner yet';
    },
    request: (req) => (target ? target.request(req) : Promise.reject(new ApiError(0, 'no runner picked yet'))),
  };
  return {
    api: new CadenceClient(transport),
    use(runner) {
      target = runner.api.transport;
    },
  };
}

/** A signer whose pocket the given runner watches (default: the default runner). */
export function createSigner(client: CadenceClient = api): Signer {
  if (wasm) return new wasm.WasmSigner(client);
  return mock ? new MockSigner(mock.ledger) : new UnavailableSigner();
}

let buildInfo: Promise<BuildInfo | null> | null = null;

/**
 * This build's identity (src/config/buildInfo.ts), read once from build.json on this
 * page's own origin, never from a runner. Null when there is none (the dev server).
 */
export function loadBuildInfo(): Promise<BuildInfo | null> {
  buildInfo ??= fetch(`${import.meta.env.BASE_URL}${BUILD_INFO_FILE}`, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' })
    .then((res) => (res.ok ? res.json() : null))
    .then(parseBuildInfo, () => null);
  return buildInfo;
}

/** Mock-only hooks (null against a real runner). */
export const mockHooks = mock
  ? {
      simulateWalletPayment: mock.simulateWalletPayment,
      adoptOffer: (o: Parameters<MockModule['runner']['adoptOffer']>[0]) => mock.runner.adoptOffer(o),
      provenanceOf: mock.provenanceOf,
      offerNameOf: mock.offerNameOf,
      demoMerchantUa: mock.DEMO_MERCHANT_UA,
      blockSecs: mock.MOCK_BLOCK_SECS,
    }
  : null;
