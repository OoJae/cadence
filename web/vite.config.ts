/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { parseApiSetting, type ApiSetting } from './src/config/apiSetting.ts';
import { BUILD_INFO_FILE, bundleManifest, CSP_HEADER_FILE, type BuildInfo } from './src/config/buildInfo.ts';
import { buildCsp, buildHeaderCsp, runnerOrigins } from './src/config/csp.ts';
import { parseSignerSetting, type SignerSetting } from './src/config/signerSetting.ts';

const CSP_PLACEHOLDER = '<!--cadence:csp-->';
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Replaces the placeholder right after <meta charset> with the Content-Security-Policy
 * meta tag, so the policy is parsed before any script or stylesheet. Fails the build if
 * the placeholder is missing.
 */
function cspPlugin(api: ApiSetting, signer: SignerSetting): Plugin {
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

/** The checkout's short commit hash and whether it has uncommitted changes; null outside git. */
function gitCommit(): { commit: string | null; dirty: boolean } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return { commit: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain') !== '' };
  } catch {
    return { commit: null, dirty: false };
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

/**
 * Build identity (src/config/buildInfo.ts). Emits csp.txt, the response-header policy a
 * static host sends (deploy/railway-app/Caddyfile reads it), and once everything is on
 * disk, hashes every file in the output directory and writes build.json beside them.
 */
function buildInfoPlugin(api: ApiSetting, signer: SignerSetting): Plugin {
  return {
    name: 'cadence-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: CSP_HEADER_FILE, source: buildHeaderCsp(api, signer) });
    },
    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) this.error('cadence-build-info needs an output directory');
      const files: Record<string, string> = {};
      for (const file of filesUnder(outDir)) {
        const path = relative(outDir, file).split(sep).join('/');
        if (path !== BUILD_INFO_FILE) files[path] = createHash('sha256').update(readFileSync(file)).digest('hex');
      }
      const info: BuildInfo = {
        ...gitCommit(),
        api: api.kind,
        runners: runnerOrigins(api),
        signer,
        bundle_sha256: createHash('sha256').update(bundleManifest(files)).digest('hex'),
        files,
      };
      writeFileSync(join(outDir, BUILD_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
    },
  };
}

/** The wasm-bindgen output of `pnpm build:wasm` (gitignored), and the files each module has. */
const WASM_DIR = join(HERE, 'src/wasm');
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
  const api = parseApiSetting(env.VITE_API ?? process.env.VITE_API, {
    runners: env.VITE_RUNNERS ?? process.env.VITE_RUNNERS,
    defaultRunner: env.VITE_DEFAULT_RUNNER ?? process.env.VITE_DEFAULT_RUNNER,
  });
  return {
    plugins: [react(), cspPlugin(api, signer), wasmAssetsPlugin(signer), buildInfoPlugin(api, signer)],
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
