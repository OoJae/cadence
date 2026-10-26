import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_INFO_FILE, bundleManifest, parseBuildInfo, type BuildInfo } from './buildInfo';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('bundle hash', () => {
  it('hashes shasum-style lines sorted by path, leaving build.json out', () => {
    const files = { 'index.html': sha256('a'), 'assets/b.js': sha256('b'), 'Z.txt': sha256('z'), [BUILD_INFO_FILE]: sha256('{}') };
    expect(bundleManifest(files)).toBe(`${sha256('z')}  Z.txt\n${sha256('b')}  assets/b.js\n${sha256('a')}  index.html\n`);
    expect(bundleManifest({})).toBe('');
  });

  it('is what shasum and sort recompute from a copy of the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadence-bundle-'));
    try {
      const contents: Record<string, string> = { 'index.html': '<!doctype html>', 'assets/index-Ab_1.js': 'console.log(1)', 'assets/a.css': 'a{}', 'wasm/signer/x.wasm': '\0asm', 'csp.txt': "default-src 'self'" };
      const files: Record<string, string> = {};
      for (const [path, body] of Object.entries(contents)) {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), body);
        files[path] = sha256(body);
      }
      writeFileSync(join(dir, BUILD_INFO_FILE), '{}');
      // The recipe the docs give for checking a copy of the served files.
      const shell = "find . -type f ! -path ./build.json | sed 's|^\\./||' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1";
      const recomputed = execFileSync('sh', ['-c', shell], { cwd: dir, encoding: 'utf8' }).trim();
      expect(recomputed).toBe(sha256(bundleManifest(files)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('build.json', () => {
  const good: BuildInfo = {
    commit: 'acc751d',
    dirty: false,
    api: 'runners',
    runners: ['https://a.example'],
    signer: 'wasm',
    bundle_sha256: sha256('x'),
    files: { 'index.html': sha256('y') },
  };

  it('round-trips', () => {
    expect(parseBuildInfo(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseBuildInfo({ ...good, commit: null })).toEqual({ ...good, commit: null });
  });

  it('rejects anything else, such as the index.html a dev server answers with', () => {
    expect(parseBuildInfo(null)).toBeNull();
    expect(parseBuildInfo('<!doctype html>')).toBeNull();
    expect(parseBuildInfo({ ...good, bundle_sha256: 'abc' })).toBeNull();
    expect(parseBuildInfo({ ...good, commit: '<b>x</b>' })).toBeNull();
    expect(parseBuildInfo({ ...good, api: 'other' })).toBeNull();
    expect(parseBuildInfo({ ...good, files: { 'index.html': 'nope' } })).toBeNull();
    expect(parseBuildInfo({ ...good, dirty: 'no' })).toBeNull();
  });
});
