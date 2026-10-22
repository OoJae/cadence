/**
 * Parses the `VITE_SIGNER` build setting. Shared by the app (through the
 * `__CADENCE_SIGNER__` constant vite.config.ts defines) and by the CSP.
 *
 *   VITE_SIGNER=mock    the in-memory MockSigner (default; only with VITE_API=mock)
 *   VITE_SIGNER=wasm    the real signer: cadence-core compiled to WebAssembly, in a
 *                       pool of Web Workers. Needs `pnpm build:wasm` first, and a
 *                       real runner (it registers the pocket with POST /api/pockets).
 */
export type SignerSetting = 'mock' | 'wasm';

export function parseSignerSetting(raw: string | undefined): SignerSetting {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'mock') return 'mock';
  if (value === 'wasm') return 'wasm';
  throw new Error(`VITE_SIGNER must be "mock" or "wasm", got "${value}"`);
}
