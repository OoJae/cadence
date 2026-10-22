/**
 * Wires the app to either the in-memory mock (VITE_API=mock, the default) or a real
 * runner over HTTP. The mock module is loaded with a dynamic import so it is never
 * fetched by builds pointed at a real runner.
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

const transport: Transport = mock ? mock.transport : new HttpTransport(apiSetting.kind === 'http' ? apiSetting.base : '');

export const api = new CadenceClient(transport);
export const apiLabel = transport.label;

/** The origins this page may talk to (mirrors the CSP connect-src). */
export const connectTargets: string[] =
  apiSetting.kind === 'mock' ? [] : [apiSetting.origin ?? (typeof location !== 'undefined' ? location.origin : 'same origin')];

export function createSigner(): Signer {
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
