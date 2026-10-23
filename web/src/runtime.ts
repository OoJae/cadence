/**
 * Wires the app to either the in-memory mock (VITE_API=mock, the default) or a real
 * runner over HTTP. The mock module is loaded with a dynamic import so it is never
 * fetched by builds pointed at a real runner.
 *
 * The signer is the mock unless the build sets VITE_SIGNER=wasm, which ships the
 * real cadence-core signer (src/signer/wasm.ts). That choice is a build-time
 * constant, so mock builds contain no trace of the WASM signer or its workers.
 */
import { CadenceClient, type Transport } from './api/client';
import { HttpTransport } from './api/http';
import { parseApiSetting } from './config/apiSetting';
import { MockSigner, UnavailableSigner } from './signer/mock';
import type { Signer } from './signer/types';

export const apiSetting = parseApiSetting(import.meta.env.VITE_API);
export const isMock = apiSetting.kind === 'mock';

type MockModule = typeof import('./mock');
const mock: MockModule | null = apiSetting.kind === 'mock' ? await import('./mock') : null;

export const signerSetting = __CADENCE_SIGNER__;
type WasmModule = typeof import('./signer/wasm');
const wasm: WasmModule | null = __CADENCE_SIGNER__ === 'wasm' ? await import('./signer/wasm') : null;

const transport: Transport = mock ? mock.transport : new HttpTransport(apiSetting.kind === 'http' ? apiSetting.base : '');

export const api = new CadenceClient(transport);
export const apiLabel = transport.label;

/**
 * The runner's absolute base URL, as a cancel key records it (the CLI connects to it).
 * With VITE_API=self (or the mock) that is this page's own origin.
 */
export const runnerUrl: string =
  apiSetting.kind === 'http' && apiSetting.base ? apiSetting.base : typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** The origins this page may talk to (mirrors the CSP connect-src). */
export const connectTargets: string[] =
  apiSetting.kind === 'mock' ? [] : [apiSetting.origin ?? (typeof location !== 'undefined' ? location.origin : 'same origin')];

export function createSigner(): Signer {
  if (wasm) return new wasm.WasmSigner(api);
  return mock ? new MockSigner(mock.ledger) : new UnavailableSigner();
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
