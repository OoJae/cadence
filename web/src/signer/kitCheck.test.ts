import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { checkKit, hexToBytes, isAgeKit, KIT_KIND, MAX_KIT_BYTES, passphraseProblem, WRONG_PASSPHRASE, type KitExpectation, type KitFields, type KitOpener, type OpenedKit } from './kit';
import { SignerError } from './types';

const SEED = '2a'.repeat(32);
const POCKET_UA = `utest1${'p'.repeat(100)}`;

const fields = (extra: Partial<KitFields> = {}): KitFields => ({
  kind: KIT_KIND,
  network: 'test',
  runner: 'http://127.0.0.1:8737',
  offer_id: 'off_sandbox1',
  pocket_id: 'pkt_abc123',
  subscription_id: 'sub_xyz789',
  mandate_id: '05'.repeat(16),
  label: 'Sandbox standing order (pkt_abc123)',
  amount_zat: 100_000,
  count: 3,
  period_secs: 90,
  first_release_at: 1_800_000_060,
  first_in_secs: 60,
  merchant_ua: `utest1${'q'.repeat(100)}`,
  funding_tx_hex: null,
  funding_height: 4_529_700,
  birthday_height: 4_529_690,
  pocket_ua: POCKET_UA,
  notes: [],
  ...extra,
});

const expected: KitExpectation = { network: 'test', pocket_id: 'pkt_abc123', pocket_ua: POCKET_UA, fileName: 'cadence-cancel-key-20261028-0905.age' };

/** The first bytes of a kit sealed by cadence-seal: an age header with one scrypt stanza. */
const AGE_KIT = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt ZlBp4Wuk64tfSpPMBpVebw 17\nj6xx\n--- mac\n\u0000\u0001');

/** An opener that opens `AGE_KIT` to `opened` with the passphrase "correct horse", and whose seed makes `POCKET_UA`. */
function opener(opened: () => OpenedKit = () => ({ fields: fields(), seed: hexToBytes(SEED) }), seedUa = POCKET_UA) {
  const seen: Uint8Array[] = [];
  const o: KitOpener = {
    looksLikeKit: isAgeKit,
    open: vi.fn(async (_bytes: Uint8Array, passphrase: string) => {
      if (passphrase !== 'correct horse') throw new SignerError(WRONG_PASSPHRASE);
      const kit = opened();
      seen.push(kit.seed);
      return kit;
    }),
    addressOf: vi.fn(async (_network, seed: Uint8Array) => (Array.from(seed).every((b) => b === 0x2a) ? seedUa : `utest1${'z'.repeat(100)}`)),
  };
  return { o, seen };
}

describe('checking a re-picked cancel key', () => {
  it("accepts this pocket's key, and zeroises the seed it opened", async () => {
    const { o, seen } = opener();
    expect(await checkKit(AGE_KIT, 'correct horse', expected, o)).toEqual({ ok: true });
    expect(o.addressOf).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.every((b) => b === 0)).toBe(true);
  });

  it('calls a file that is not a cancel key the wrong file, without trying to open it', async () => {
    const { o } = opener();
    const cases = [
      new Uint8Array(0),
      new TextEncoder().encode('{"seed_hex":"00"}'),
      new TextEncoder().encode('cadence-mock-kit/1\n' + 'x'.repeat(40)),
      // An age file, but encrypted to a key rather than a passphrase.
      new TextEncoder().encode('age-encryption.org/v1\n-> X25519 abc\nxyz\n--- mac\n'),
      new Uint8Array(MAX_KIT_BYTES + 1).fill(0x61),
    ];
    for (const bytes of cases) {
      const r = await checkKit(bytes, 'correct horse', expected, o);
      expect(r).toMatchObject({ ok: false, reason: 'file' });
      expect(!r.ok && r.message).toBe('Wrong file: this is not a Cadence cancel key. Pick cadence-cancel-key-20261028-0905.age, the file you just downloaded.');
    }
    expect(o.open).not.toHaveBeenCalled();
  });

  it('says the passphrase is wrong when the file does not open with it', async () => {
    const { o } = opener();
    const r = await checkKit(AGE_KIT, 'correct horse!', expected, o);
    expect(r).toMatchObject({ ok: false, reason: 'passphrase' });
    expect(!r.ok && r.message).toMatch(/^Wrong passphrase: the file does not open with it\./);
    // The WASM pool hands the worker's error on as a plain Error with the same words.
    const pooled: KitOpener = { ...o, open: async () => Promise.reject(new Error(WRONG_PASSPHRASE)) };
    expect(await checkKit(AGE_KIT, 'x', expected, pooled)).toMatchObject({ ok: false, reason: 'passphrase' });
  });

  it("says when the key is another pocket's", async () => {
    for (const other of [fields({ pocket_id: 'pkt_other9' }), fields({ network: 'main' })]) {
      const { o, seen } = opener(() => ({ fields: other, seed: hexToBytes(SEED) }));
      const r = await checkKit(AGE_KIT, 'correct horse', expected, o);
      expect(r).toMatchObject({ ok: false, reason: 'pocket' });
      expect(o.addressOf).not.toHaveBeenCalled();
      expect(seen[0]!.every((b) => b === 0)).toBe(true);
    }
    const { o } = opener(() => ({ fields: fields({ pocket_id: 'pkt_other9' }), seed: hexToBytes(SEED) }));
    const r = await checkKit(AGE_KIT, 'correct horse', expected, o);
    expect(!r.ok && r.message).toBe(
      'Wrong file: this is the cancel key of another pocket (pkt_other9), not of this one (pkt_abc123). Pick cadence-cancel-key-20261028-0905.age, the file you just downloaded.',
    );
    const { o: ua } = opener(() => ({ fields: fields({ pocket_ua: `utest1${'r'.repeat(100)}` }), seed: hexToBytes(SEED) }));
    expect(await checkKit(AGE_KIT, 'correct horse', expected, ua)).toMatchObject({ ok: false, reason: 'pocket' });
  });

  it("refuses a key whose seed does not make the pocket's address", async () => {
    const { o, seen } = opener(() => ({ fields: fields(), seed: hexToBytes('2b'.repeat(32)) }));
    const r = await checkKit(AGE_KIT, 'correct horse', expected, o);
    expect(r).toMatchObject({ ok: false, reason: 'damaged' });
    expect(!r.ok && r.message).toMatch(/seed does not make this pocket's address/);
    expect(seen[0]!.every((b) => b === 0)).toBe(true);
  });

  it('passes on why a file that looks like a key did not open', async () => {
    const { o } = opener(() => {
      throw new SignerError('this cancel key is damaged or not from Cadence: notes is missing');
    });
    const r = await checkKit(AGE_KIT, 'correct horse', expected, o);
    expect(r).toMatchObject({ ok: false, reason: 'damaged' });
    expect(!r.ok && r.message).toBe('The file did not open: this cancel key is damaged or not from Cadence: notes is missing. Download the key again and pick the new file.');
  });

  it("uses cadence-seal's own wrong-passphrase message and file header", () => {
    const seal = readFileSync(fileURLToPath(new URL('../../../crates/cadence-seal/src/lib.rs', import.meta.url)), 'utf8');
    expect(seal).toContain(`#[error("${WRONG_PASSPHRASE}")]`);
    const kit = readFileSync(fileURLToPath(new URL('../../../crates/cadence-seal/src/kit.rs', import.meta.url)), 'utf8');
    expect(kit).toContain('bytes.starts_with(b"age-encryption.org/v1\\n")');
    expect(kit).toContain('age::scrypt::Recipient');
  });
});

// The real signer's code path, without the Web Worker: the worker's own handlers over
// the cadence-wasm build in src/wasm (copied in or built by `pnpm build:wasm`).
const wasmDir = new URL('../wasm/signer/', import.meta.url);
const haveWasm = existsSync(fileURLToPath(new URL('cadence_wasm_bg.wasm', wasmDir)));

describe.skipIf(!haveWasm)('checking a cancel key with the WASM signer', () => {
  async function load() {
    const glue = (await import(/* @vite-ignore */ new URL('cadence_wasm.js', wasmDir).href)) as { initSync(o: { module: Uint8Array }): unknown };
    glue.initSync({ module: readFileSync(fileURLToPath(new URL('cadence_wasm_bg.wasm', wasmDir))) });
    // The worker module installs its message handler on `self` when it loads. Only
    // for that: the wasm module finds its randomness on the real global.
    vi.stubGlobal('self', { location: { href: 'http://localhost/' }, onmessage: null, postMessage() {} });
    const { handlers } = await import('./wasmWorker');
    vi.unstubAllGlobals();
    const w = glue as unknown as Parameters<typeof handlers.openKit>[0];
    const opener: KitOpener = {
      looksLikeKit: isAgeKit,
      open: async (bytes, passphrase) => handlers.openKit(w, { bytes, passphrase }),
      addressOf: async (network, seed) => handlers.pocketInfo(w, { network, seed }).ua,
    };
    const pocket = (seed: Uint8Array) => handlers.pocketInfo(w, { network: 'test', seed });
    const seal = (f: KitFields, seed: Uint8Array, passphrase: string) => handlers.sealKit(w, { fields: f, seed, passphrase });
    return { opener, pocket, seal };
  }

  it('opens a real age kit, and tells a wrong passphrase, a wrong file and another pocket apart', { timeout: 60_000 }, async () => {
    const { opener, pocket, seal } = await load();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const ua = pocket(seed).ua;
    const mine = { ...expected, pocket_ua: ua };
    const bytes = seal(fields({ pocket_ua: ua }), seed, 'correct horse battery');
    expect(isAgeKit(bytes)).toBe(true);

    expect(await checkKit(bytes, 'correct horse battery', mine, opener)).toEqual({ ok: true });
    expect(await checkKit(bytes, 'Correct horse battery', mine, opener)).toMatchObject({ ok: false, reason: 'passphrase' });
    expect(await checkKit(new TextEncoder().encode('not a key'), 'correct horse battery', mine, opener)).toMatchObject({ ok: false, reason: 'file' });

    // Another pocket's kit, sealed with the same passphrase.
    const otherSeed = crypto.getRandomValues(new Uint8Array(32));
    const other = seal(fields({ pocket_id: 'pkt_other9', pocket_ua: pocket(otherSeed).ua }), otherSeed, 'correct horse battery');
    expect(await checkKit(other, 'correct horse battery', mine, opener)).toMatchObject({ ok: false, reason: 'pocket' });
    // This pocket's id and address, but another seed: it could not cancel.
    const forged = seal(fields({ pocket_ua: ua }), otherSeed, 'correct horse battery');
    expect(await checkKit(forged, 'correct horse battery', mine, opener)).toMatchObject({ ok: false, reason: 'damaged' });
  });

  it('still opens a key saved before new keys needed a stronger passphrase', { timeout: 60_000 }, async () => {
    const { opener, pocket, seal } = await load();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const ua = pocket(seed).ua;
    // Eight characters, all cadence-seal asks for: a new key may not use it, an old one opens with it.
    expect(passphraseProblem('12345678')).not.toBeNull();
    const bytes = seal(fields({ pocket_ua: ua }), seed, '12345678');
    expect((await opener.open(bytes, '12345678')).fields.pocket_ua).toBe(ua);
    expect(await checkKit(bytes, '12345678', { ...expected, pocket_ua: ua }, opener)).toEqual({ ok: true });
  });
});
