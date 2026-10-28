import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliCancelCommand, cliSweepCommand, isTrivialPassphrase, KIT_KIND, kitFileName, kitJson, kitTargetProblem, parseKit, passphraseProblem, shellPath, type KitFields } from './kit';

const SEED = '2a'.repeat(32);

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
  funding_tx_hex: '05000080' + 'ab'.repeat(200),
  funding_height: 4_529_700,
  birthday_height: 4_529_690,
  pocket_ua: `utest1${'p'.repeat(100)}`,
  notes: [
    { k: 0, note: 'cd'.repeat(116), nullifier: '01'.repeat(32), value_zat: 330_000 },
    { k: 1, note: 'ef'.repeat(116), nullifier: '02'.repeat(32), value_zat: 220_000 },
    { k: 2, note: '12'.repeat(116), nullifier: '03'.repeat(32), value_zat: 110_000 },
  ],
  ...extra,
});

/** The fields of `SubscriptionFile` in crates/cadence-cli/src/subscribe.rs, which `cadence cancel` and `cadence sweep` read. */
function cliSubscriptionFile(): Array<{ name: string; type: string; required: boolean }> {
  const src = readFileSync(fileURLToPath(new URL('../../../crates/cadence-cli/src/subscribe.rs', import.meta.url)), 'utf8');
  const body = /pub struct SubscriptionFile \{([\s\S]*?)\n\}/.exec(src)?.[1];
  if (!body) throw new Error('SubscriptionFile not found in subscribe.rs');
  const out: Array<{ name: string; type: string; required: boolean }> = [];
  let defaulted = false;
  for (const line of body.split('\n').map((l) => l.trim())) {
    if (line.startsWith('#[serde(default')) defaulted = true;
    const m = /^(?:pub\s+)?(\w+):\s*([^,]+),$/.exec(line);
    if (!m) continue;
    const type = m[2]!.trim();
    out.push({ name: m[1]!, type, required: !defaulted && !type.startsWith('Option<') });
    defaulted = false;
  }
  return out;
}

function matchesRust(value: unknown, type: string): boolean {
  const inner = /^Option<(.+)>$/.exec(type)?.[1];
  if (inner) return value === null || value === undefined || matchesRust(value, inner);
  switch (type) {
    case 'String':
      return typeof value === 'string';
    case 'u64':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'u32':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
    default:
      throw new Error(`no JSON mapping for Rust type ${type}`);
  }
}

describe('cancel key JSON', () => {
  it("has every field of the CLI's SubscriptionFile, with the right JSON types", () => {
    const rust = cliSubscriptionFile();
    expect(rust.map((f) => f.name)).toEqual(expect.arrayContaining(['network', 'seed_hex', 'runner', 'pocket_id', 'mandate_id', 'funding_tx_hex', 'funding_height']));
    const json = JSON.parse(kitJson(fields(), SEED)) as Record<string, unknown>;
    for (const f of rust) {
      if (f.required) expect(json, `required field ${f.name}`).toHaveProperty(f.name);
      expect(matchesRust(json[f.name], f.type), `${f.name}: ${JSON.stringify(json[f.name])} as ${f.type}`).toBe(true);
    }
    // Before the upload there is no subscription id; the CLI takes null as None.
    const early = JSON.parse(kitJson(fields({ subscription_id: null }), SEED)) as Record<string, unknown>;
    expect(early.subscription_id).toBeNull();
  });

  it('carries the values the CLI rebuilds the change notes from', () => {
    const json = JSON.parse(kitJson(fields(), SEED));
    expect(json.seed_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(json.mandate_id).toMatch(/^[0-9a-f]{32}$/);
    expect(['main', 'test']).toContain(json.network);
    expect(new URL(json.runner).origin).toBe('http://127.0.0.1:8737');
    expect(json.label).toBe('Sandbox standing order (pkt_abc123)');
    expect(json.funding_tx_hex).toMatch(/^[0-9a-f]+$/);
    // The web-only fields, which serde ignores.
    expect(json.kind).toBe(KIT_KIND);
    expect(json.birthday_height).toBe(4_529_690);
    expect(json.notes.map((n: { k: number }) => n.k)).toEqual([0, 1, 2]);
    expect(Object.keys(json.notes[0]).sort()).toEqual(['k', 'note', 'nullifier', 'value_zat']);
  });

  it('parses back to the same fields and splits off the seed', () => {
    const { fields: back, seedHex } = parseKit(JSON.parse(kitJson(fields(), SEED)));
    expect(seedHex).toBe(SEED);
    expect(back).toEqual(fields());
    expect(back).not.toHaveProperty('seed_hex');
  });

  it('refuses CLI files, other kinds and damaged kits with a clear reason', () => {
    const json = JSON.parse(kitJson(fields(), SEED));
    const { kind: _kind, ...cli } = json;
    expect(() => parseKit(cli)).toThrow(/CLI subscription file.*cadence cancel/);
    expect(() => parseKit({ ...json, kind: 'cadence-kit/9' })).toThrow(/unknown kind/);
    expect(() => parseKit({ ...json, seed_hex: 'abcd' })).toThrow(/seed is not 32 bytes/);
    expect(() => parseKit({ ...json, count: 1.5 })).toThrow(/count/);
    expect(() => parseKit({ ...json, network: 'regtest' })).toThrow(/network/);
    expect(() => parseKit({ ...json, notes: [{ k: 1, note: 'zz', nullifier: '00', value_zat: 1 }] })).toThrow(/note 0/);
    expect(() => parseKit([1, 2])).toThrow(/JSON object/);
  });

  it('checks the runner and network it belongs to', () => {
    expect(kitTargetProblem(fields(), { runner: 'http://127.0.0.1:8737/', network: 'test' })).toBeNull();
    expect(kitTargetProblem(fields(), { runner: 'https://runner.example', network: 'test' })).toMatchObject({ reason: 'runner' });
    expect(kitTargetProblem(fields(), { runner: 'https://runner.example' })!.message).toMatch(/http:\/\/127\.0\.0\.1:8737\/manage/);
    expect(kitTargetProblem(fields(), { runner: 'http://127.0.0.1:8737', network: 'main' })).toMatchObject({ reason: 'network' });
    // The runner's network is unknown when it cannot be reached; that is reported elsewhere.
    expect(kitTargetProblem(fields(), { runner: 'http://127.0.0.1:8737' })).toBeNull();
  });

  it('names the file for the local date and time it was saved, with no id in it', () => {
    expect(kitFileName('age', new Date(2026, 9, 28, 9, 5))).toBe('cadence-cancel-key-20261028-0905.age');
    expect(kitFileName('mock', new Date(2026, 0, 2, 23, 59))).toBe('cadence-cancel-key-20260102-2359.mock');
    expect(kitFileName()).toMatch(/^cadence-cancel-key-\d{8}-\d{4}\.age$/);
  });

  it('prints the CLI commands, quoting a path the shell would split or expand', () => {
    expect(cliSweepCommand('cadence-cancel-key-20261028-0905.age', ' utest1me ')).toBe('cadence sweep --pocket cadence-cancel-key-20261028-0905.age --to utest1me');
    expect(cliCancelCommand('k.age')).toBe('cadence cancel --subscription k.age --to <your UA>');
    expect(cliCancelCommand('~/keys/k_1.age')).toBe("cadence cancel --subscription '~/keys/k_1.age' --to <your UA>");
    // A second download of the same name, as browsers save it.
    expect(cliSweepCommand('cadence-cancel-key (1).age')).toBe("cadence sweep --pocket 'cadence-cancel-key (1).age' --to <your UA>");
    expect(cliCancelCommand("Oluwa's key (2).age", 'utest1me')).toBe("cadence cancel --subscription 'Oluwa'\\''s key (2).age' --to utest1me");
    expect(shellPath('a/b-c_d.age')).toBe('a/b-c_d.age');
    expect(shellPath('$HOME/k.age')).toBe("'$HOME/k.age'");
    expect(shellPath('')).toBe("''");
    expect(shellPath("'")).toBe("''\\'''");
  });

  it('wants a new key to have 12 characters or 4 words, counted as the Rust side counts them', () => {
    expect(passphraseProblem('short')).toMatch(/at least 12 characters, or 4 words/);
    expect(passphraseProblem('elevenchars')).toMatch(/at least 12/);
    expect(passphraseProblem('red lantern')).toMatch(/at least 12/);
    expect(passphraseProblem('mauve tundra')).toBeNull();
    // Four words, though fewer than 12 characters.
    expect(passphraseProblem('my ox is up')).toBeNull();
    // Not four different words.
    expect(passphraseProblem('ox ox ox ox')).toMatch(/at least 12/);
    // Twelve characters, more than twelve UTF-16 units; and fewer than the 8 cadence-seal needs, even as words.
    expect(passphraseProblem('🔑🗝🔒🔓🚪🏠🌙⭐🌊🍀🎲🧭')).toBeNull();
    expect(passphraseProblem('🔑🗝🔒🔓')).toMatch(/at least 12/);
  });

  it('refuses common passwords and trivial patterns, whatever their case, spacing and digits', () => {
    for (const p of [
      'password1234',
      'Password 2026!',
      'P@ssw0rd2026',
      'iloveyou1234',
      'Correct Horse Battery Staple',
      'trustno1trustno1',
      '123456789012',
      '0987654321098',
      'qwertyuiopas',
      'QWERTY123456',
      'asdfghjkl;123',
      '1qaz2wsx3edc',
      'abcdefghijkl',
      'aaaaaaaaaaaa',
      'abcabcabcabc',
      'ab ab ab ab ab ab',
      'password password',
      '!@#$%^&*()_+',
      '🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑',
    ]) {
      expect(isTrivialPassphrase(p), p).toBe(true);
      expect(passphraseProblem(p), p).toMatch(/common password or a simple pattern|at least 12/);
    }
    for (const p of ['judge path lq3k9 4fzyo82mw3k', 'smoke test passphrase', 'correct horse battery', 'my password is purple banana', 'x7Kp2mQ9vL4w', 'パスフレーズはとても長いです', 'maple tree 1987 river']) {
      expect(isTrivialPassphrase(p), p).toBe(false);
      expect(passphraseProblem(p), p).toBeNull();
    }
  });
});
