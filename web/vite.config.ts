/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { parseApiSetting } from './src/config/apiSetting.ts';
import { buildCsp } from './src/config/csp.ts';
import { parseSignerSetting, type SignerSetting } from './src/config/signerSetting.ts';

const CSP_PLACEHOLDER = '<!--cadence:csp-->';

/**
 * Replaces the placeholder right after <meta charset> with the Content-Security-Policy
 * meta tag, so the policy is parsed before any script or stylesheet. Fails the build if
 * the placeholder is missing.
 */
function cspPlugin(apiRaw: string | undefined, signer: SignerSetting): Plugin {
  const api = parseApiSetting(apiRaw);
  let command: 'build' | 'serve' = 'build';
  return {
    name: 'cadence-csp',
    configResolved(config) {
      command = config.command;
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(CSP_PLACEHOLDER)) throw new Error('index.html lost its CSP placeholder');
        const policy = buildCsp(api, command, signer).replace(/"/g, '&quot;');
        return html.replace(CSP_PLACEHOLDER, `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

/** The wasm-bindgen output of `pnpm build:wasm` (gitignored), and the files each module has. */
const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'src/wasm');
const WASM_FILES = ['signer/cadence_wasm.js', 'signer/cadence_wasm_bg.wasm', 'prover/cadence_wasm.js', 'prover/cadence_wasm_bg.wasm'];

/**
 * Serves the signer's wasm modules from this origin at /wasm/, in WASM-signer builds
 * only: the build emits them as fixed-name assets (dist/wasm/...), and the dev server
 * serves them from src/wasm/. Mock builds ship none of it.
 */
function wasmAssetsPlugin(signer: SignerSetting): Plugin {
  return {
    name: 'cadence-wasm-assets',
    apply: () => signer === 'wasm',
    configureServer(server) {
      server.middlewares.use('/wasm/', (req, res, next) => {
        const rel = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        if (!WASM_FILES.includes(rel)) return next();
        const file = join(WASM_DIR, rel);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end('run pnpm build:wasm');
          return;
        }
        res.setHeader('Content-Type', rel.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const rel of WASM_FILES) {
        const file = join(WASM_DIR, rel);
        if (!existsSync(file)) this.error(`VITE_SIGNER=wasm needs ${file}: run pnpm build:wasm first`);
        this.emitFile({ type: 'asset', fileName: `wasm/${rel}`, source: readFileSync(file) });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const signer = parseSignerSetting(env.VITE_SIGNER ?? process.env.VITE_SIGNER);
  return {
    plugins: [react(), cspPlugin(env.VITE_API ?? process.env.VITE_API, signer), wasmAssetsPlugin(signer)],
    // A build-time constant, so a mock build drops the WASM signer (and its workers) entirely.
    define: { __CADENCE_SIGNER__: JSON.stringify(signer) },
    // The signer's workers are module workers that load the wasm-bindgen glue with import().
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: false,
      // Keep every asset as a separate same-origin file: no data: URIs, so img-src and
      // font-src can stay 'self'.
      assetsInlineLimit: 0,
      // The modulepreload polyfill is unnecessary for the browsers we target and adds
      // a fetch() of its own; turn it off to keep the request list minimal.
      modulePreload: { polyfill: false },
    },
    server: { port: 5173 },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
