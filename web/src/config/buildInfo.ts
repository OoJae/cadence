/**
 * Build identity. vite.config.ts writes it to dist/build.json once every other file
 * is written; the footer reads it back from this origin. It says which commit a build
 * was made from and fingerprints what it emitted. It does not make a build
 * reproducible: it lets anyone check that the files a host serves are the ones a
 * given build produced.
 *
 * `bundle_sha256` is the SHA-256 of a manifest with one line per emitted file, every
 * file except build.json itself, sorted by path (byte order, as `LC_ALL=C sort`), each
 * line as `shasum -a 256` prints it:
 *
 *   <sha256 hex><two spaces><path relative to dist/>\n
 *
 * so standard tools recompute it from a copy of the files (see web/README.md).
 */
import type { ApiSetting } from './apiSetting.ts';
import type { SignerSetting } from './signerSetting.ts';

/** The file that records the build, left out of its own hash. */
export const BUILD_INFO_FILE = 'build.json';
/** The CSP response header for this build (buildHeaderCsp), for the static host to send. */
export const CSP_HEADER_FILE = 'csp.txt';

export interface BuildInfo {
  /** Short hash of the commit checked out at build time, or null outside a git checkout. */
  commit: string | null;
  /** Whether the checkout had uncommitted changes (tracked or untracked, not ignored files). */
  dirty: boolean;
  api: ApiSetting['kind'];
  /** The runner origins the build may talk to (its CSP connect-src, besides 'self'). */
  runners: string[];
  signer: SignerSetting;
  bundle_sha256: string;
  /** SHA-256 of every file in the bundle, by path relative to dist/. */
  files: Record<string, string>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{4,64}$/;

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The manifest `bundle_sha256` hashes: `shasum -a 256` lines, sorted by path. */
export function bundleManifest(files: Record<string, string>): string {
  return Object.keys(files)
    .filter((path) => path !== BUILD_INFO_FILE)
    .sort(byteOrder)
    .map((path) => `${files[path]}  ${path}\n`)
    .join('');
}

/** Validates a build.json as fetched; null for anything else (a dev server answers with index.html). */
export function parseBuildInfo(json: unknown): BuildInfo | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (o.commit !== null && !(typeof o.commit === 'string' && COMMIT.test(o.commit))) return null;
  if (typeof o.dirty !== 'boolean' || typeof o.bundle_sha256 !== 'string' || !HEX64.test(o.bundle_sha256)) return null;
  if (o.api !== 'mock' && o.api !== 'http' && o.api !== 'runners') return null;
  if (o.signer !== 'mock' && o.signer !== 'wasm') return null;
  if (!Array.isArray(o.runners) || !o.runners.every((r) => typeof r === 'string')) return null;
  if (!o.files || typeof o.files !== 'object' || !Object.values(o.files).every((v) => typeof v === 'string' && HEX64.test(v))) return null;
  return {
    commit: o.commit as string | null,
    dirty: o.dirty,
    api: o.api,
    runners: o.runners as string[],
    signer: o.signer,
    bundle_sha256: o.bundle_sha256,
    files: o.files as Record<string, string>,
  };
}
