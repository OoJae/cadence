/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { parseApiSetting } from './src/config/apiSetting.ts';
import { buildCsp } from './src/config/csp.ts';

const CSP_PLACEHOLDER = '<!--cadence:csp-->';

/**
 * Replaces the placeholder right after <meta charset> with the Content-Security-Policy
 * meta tag, so the policy is parsed before any script or stylesheet. Fails the build if
 * the placeholder is missing.
 */
function cspPlugin(apiRaw: string | undefined): Plugin {
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
        const policy = buildCsp(api, command).replace(/"/g, '&quot;');
        return html.replace(CSP_PLACEHOLDER, `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), cspPlugin(env.VITE_API ?? process.env.VITE_API)],
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
