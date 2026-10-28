/**
 * The payer's cancel key: a recovery kit, encrypted to a passphrase, that the payer
 * downloads before closing the tab. With it they can cancel later from /manage, or
 * with the CLI (`cadence cancel --subscription <kit>`, `cadence sweep --pocket <kit>`).
 *
 * The plaintext is the CLI's `SubscriptionFile` (crates/cadence-cli/src/subscribe.rs)
 * plus web-only fields the CLI ignores: `kind`, `birthday_height`, `pocket_ua` and
 * `notes`, the pocket notes the signer computed while pre-signing, so restoring in
 * the browser does not re-sign anything. The CLI does not need them: it decrypts the
 * live note from the transaction that created it, and `cadence sweep` scans the
 * chain from `funding_height`.
 *
 * The WASM signer builds and parses the JSON inside a worker, so the seed exists as
 * hex only there; the page sees the sealed bytes, or the seed as a Uint8Array.
 */
import type { NetworkId } from '../lib/zat';
import { SignerError } from './types';

export const KIT_KIND = 'cadence-kit/1';
/** `cadence_seal::MIN_PASSPHRASE_CHARS`: the least cadence-seal seals with. A key saved with fewer opens as before. */
export const MIN_PASSPHRASE_CHARS = 8;
/** What a new cancel key asks for: this many characters, or NEW_KEY_MIN_WORDS different words. */
export const NEW_KEY_MIN_CHARS = 12;
export const NEW_KEY_MIN_WORDS = 4;
export const PASSPHRASE_HINT = `At least ${NEW_KEY_MIN_CHARS} characters, or ${NEW_KEY_MIN_WORDS} words or more, and not a common password or a pattern like 123456. A few random words work well.`;

/** A pocket note the signer created: the funding note (k = 0) or C(k), the change of installment k. */
export interface KitNote {
  k: number;
  /** cadence-wasm's note encoding (hex). Secret. */
  note: string;
  nullifier: string;
  value_zat: number;
}

/** Everything in a kit except the seed. */
export interface KitFields {
  kind: typeof KIT_KIND;
  network: NetworkId;
  /** The runner's absolute base URL (this origin when the runner serves the app). */
  runner: string;
  offer_id: string;
  pocket_id: string;
  subscription_id: string | null;
  /** 16 bytes hex: the mandate id the rung seeds were derived with. */
  mandate_id: string;
  /** The memo label of every installment (plan name and pocket id). */
  label: string;
  amount_zat: number;
  count: number;
  period_secs: number;
  /** Unix seconds installment 1 became releasable from. */
  first_release_at: number;
  first_in_secs: number;
  merchant_ua: string;
  funding_tx_hex: string | null;
  funding_height: number | null;
  /** The height the runner scans the pocket from. */
  birthday_height: number;
  /** The pocket's funding address, derived from the seed; restore checks it. */
  pocket_ua: string;
  notes: KitNote[];
}

/** An opened kit: its fields, and the seed as bytes. */
export interface OpenedKit {
  fields: KitFields;
  seed: Uint8Array;
}

/** What `Signer.sealKit` returns: the encrypted kit and the name to save it under. */
export interface SealedKit {
  bytes: Uint8Array;
  fileName: string;
}

/**
 * The name to save a cancel key under: the local date and time, to the minute, and no
 * id. A pocket id is a lookup key at the runner, and file names travel (Downloads,
 * backups, recent-file lists). A second save in the same minute is renamed by the
 * browser, as any download is.
 */
export function kitFileName(ext = 'age', at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `cadence-cancel-key-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.${ext}`;
}

/** Very common passwords, as letters and digits only. A passphrase that is one of them (give or take digits around it) is refused. */
const COMMON = new Set([
  'password', 'passphrase', 'mypassword', 'secret', 'mysecret', 'qwerty', 'letmein', 'iloveyou', 'welcome', 'admin', 'administrator', 'login', 'master',
  'monkey', 'dragon', 'football', 'baseball', 'basketball', 'soccer', 'hockey', 'sunshine', 'princess', 'shadow', 'superman', 'batman', 'trustno', 'trustnoone',
  'charlie', 'michael', 'jennifer', 'hunter', 'freedom', 'whatever', 'starwars', 'pokemon', 'computer', 'internet', 'changeme', 'default', 'opensesame',
  'zcash', 'cadence', 'bitcoin', 'satoshi', 'crypto', 'wallet', 'correcthorsebatterystaple', 'thequickbrownfox', 'thequickbrownfoxjumpsoverthelazydog',
]);

/** Runs a passphrase may not be: keyboard rows and columns, the digits and the alphabet, each also backwards. */
const RUNS = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'qwertzuiop', 'azertyuiop', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p', 'qazwsxedcrfvtgbyhnujmikolp', '!@#$%^&*()_+'].flatMap((r) => {
  // Three laps, so a run that wraps (7890123…) is one too.
  const laps = r.repeat(3);
  return [laps, [...laps].reverse().join('')];
});

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/**
 * Whether letters and digits `s` are a common password, a run, a short unit repeated
 * (or a trivial one repeated), or one of these with digits before or after it.
 */
function trivialCore(s: string): boolean {
  if (s.length < 3) return true;
  if (COMMON.has(s) || COMMON.has([...s].map((c) => LEET[c] ?? c).join(''))) return true;
  if (RUNS.some((r) => r.includes(s))) return true;
  for (let n = 1; n <= s.length / 2; n++) {
    if (s.length % n === 0 && s === s.slice(0, n).repeat(s.length / n) && (n <= 6 || trivialCore(s.slice(0, n)))) return true;
  }
  const inner = s.replace(/^\d+|\d+$/g, '');
  return inner.length >= 3 && inner !== s && trivialCore(inner);
}

/** Whether a passphrase is a common password or a trivial pattern, ignoring case, spaces, punctuation and digits around it. */
export function isTrivialPassphrase(passphrase: string): boolean {
  const lower = passphrase.toLowerCase();
  const compact = [...lower.replace(/\s+/g, '')];
  // The same character (an emoji, say) over and over, or a run of symbols.
  if (compact.length > 0 && compact.every((c) => c === compact[0])) return true;
  if (RUNS.some((r) => r.includes(compact.join('')))) return true;
  const plain = lower.replace(/[^a-z0-9]/g, '');
  // Letters and digits that are less than half of it: a passphrase in another script, not one of these patterns.
  if (plain.length * 2 < compact.length) return false;
  // As typed, and with p@$$word's symbols read as letters.
  return trivialCore(plain) || trivialCore(lower.replace(/[@$]/g, (c) => LEET[c]!).replace(/[^a-z0-9]/g, ''));
}

/** Why a passphrase is too weak for a new cancel key, or null. Opening a key never asks this. */
export function passphraseProblem(passphrase: string): string | null {
  const chars = [...passphrase].length;
  const words = new Set(
    passphrase
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 2),
  );
  if (chars < MIN_PASSPHRASE_CHARS || (chars < NEW_KEY_MIN_CHARS && words.size < NEW_KEY_MIN_WORDS)) {
    return `use a passphrase of at least ${NEW_KEY_MIN_CHARS} characters, or ${NEW_KEY_MIN_WORDS} words or more`;
  }
  if (isTrivialPassphrase(passphrase)) return 'that is a common password or a simple pattern, which is guessed first; use a few random words instead';
  return null;
}

/** The kit's JSON, fields in the CLI's order. `seedHex` is the 32-byte pocket seed. */
export function kitJson(fields: KitFields, seedHex: string): string {
  const { kind, network, runner, offer_id, pocket_id, subscription_id, mandate_id, label, amount_zat, count, period_secs, first_release_at, first_in_secs, merchant_ua, funding_tx_hex, funding_height, ...web } = fields;
  return JSON.stringify(
    {
      network,
      seed_hex: seedHex,
      runner,
      offer_id,
      pocket_id,
      subscription_id,
      mandate_id,
      label,
      amount_zat,
      count,
      period_secs,
      first_release_at,
      first_in_secs,
      merchant_ua,
      funding_tx_hex,
      funding_height,
      kind,
      birthday_height: web.birthday_height,
      pocket_ua: web.pocket_ua,
      notes: web.notes.map(({ k, note, nullifier, value_zat }) => ({ k, note, nullifier, value_zat })),
    },
    null,
    2,
  );
}

const HEX = /^(?:[0-9a-f]{2})+$/;
const U32 = 0xffff_ffff;

function bad(what: string): never {
  throw new SignerError(`this cancel key is damaged or not from Cadence: ${what}`);
}

const str = (v: unknown, what: string): string => (typeof v === 'string' && v.length > 0 ? v : bad(`${what} is missing`));
const uint = (v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : bad(`${what} is not a whole number`);
const hexOf = (v: unknown, what: string, bytes?: number): string => {
  const s = str(v, what).toLowerCase();
  if (!HEX.test(s) || (bytes !== undefined && s.length !== bytes * 2)) bad(`${what} is not ${bytes ? `${bytes} bytes of ` : ''}hex`);
  return s;
};

/**
 * Checks a kit's decrypted JSON and splits off the seed. A CLI subscription file
 * (no `kind`) is refused with a pointer to the CLI, which reads it directly.
 */
export function parseKit(json: unknown): { fields: KitFields; seedHex: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) bad('it is not a JSON object');
  const o = json as Record<string, unknown>;
  if (o.kind === undefined && typeof o.seed_hex === 'string') {
    throw new SignerError('this is a CLI subscription file, not a cancel key saved by the web app; cancel with `cadence cancel --subscription <file> --to <your address>`');
  }
  if (o.kind !== KIT_KIND) bad(`unknown kind ${JSON.stringify(o.kind)} (expected ${KIT_KIND})`);
  if (o.network !== 'main' && o.network !== 'test') bad('unknown network');
  const seedHex = hexOf(o.seed_hex, 'the seed', 32);
  if (!Array.isArray(o.notes)) bad('notes is missing');
  const notes = o.notes.map((n: unknown, i): KitNote => {
    const x = (n ?? {}) as Record<string, unknown>;
    return { k: uint(x.k, `note ${i}'s k`, U32), note: hexOf(x.note, `note ${i}`), nullifier: hexOf(x.nullifier, `note ${i}'s nullifier`, 32), value_zat: uint(x.value_zat, `note ${i}'s value`) };
  });
  const fields: KitFields = {
    kind: KIT_KIND,
    network: o.network,
    runner: str(o.runner, 'runner'),
    offer_id: str(o.offer_id, 'offer_id'),
    pocket_id: str(o.pocket_id, 'pocket_id'),
    subscription_id: o.subscription_id == null ? null : str(o.subscription_id, 'subscription_id'),
    mandate_id: hexOf(o.mandate_id, 'mandate_id', 16),
    label: typeof o.label === 'string' ? o.label : '',
    amount_zat: uint(o.amount_zat, 'amount_zat'),
    count: uint(o.count, 'count', U32),
    period_secs: uint(o.period_secs, 'period_secs'),
    first_release_at: uint(o.first_release_at, 'first_release_at'),
    first_in_secs: o.first_in_secs === undefined ? 0 : uint(o.first_in_secs, 'first_in_secs'),
    merchant_ua: str(o.merchant_ua, 'merchant_ua'),
    funding_tx_hex: o.funding_tx_hex == null ? null : hexOf(o.funding_tx_hex, 'funding_tx_hex'),
    funding_height: o.funding_height == null ? null : uint(o.funding_height, 'funding_height', U32),
    birthday_height: uint(o.birthday_height, 'birthday_height', U32),
    pocket_ua: str(o.pocket_ua, 'pocket_ua'),
    notes,
  };
  if (fields.count < 1) bad('count is zero');
  return { fields, seedHex };
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const sameRunner = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export type KitTargetProblem = { reason: 'runner'; message: string } | { reason: 'network'; message: string };

/** Whether this page (its runner and that runner's network) is where the kit's subscription lives. */
export function kitTargetProblem(fields: Pick<KitFields, 'runner' | 'network'>, here: { runner: string; network?: NetworkId }): KitTargetProblem | null {
  if (!sameRunner(fields.runner, here.runner)) {
    return { reason: 'runner', message: `This cancel key belongs to the runner at ${fields.runner}, but this page talks only to ${here.runner}. Open ${fields.runner.replace(/\/+$/, '')}/manage instead, or use the CLI.` };
  }
  if (here.network && here.network !== fields.network) {
    return { reason: 'network', message: `This cancel key is for ${fields.network === 'main' ? 'mainnet' : 'testnet'}, but this runner is on ${here.network === 'main' ? 'mainnet' : 'testnet'}.` };
  }
  return null;
}

/** The largest file worth opening: a kit's plaintext is at most 1 MiB (cadence-seal), plus age's header and tags. */
export const MAX_KIT_BYTES = (1 << 20) + 64 * 1024;

/** `cadence_seal::SealError::WrongPassphrase`. The mock signer uses the same words. */
export const WRONG_PASSPHRASE = 'wrong passphrase for this recovery kit';

const AGE_SCRYPT = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt ');

/** Whether `bytes` start as the WASM signer's kits do: an age file encrypted to a passphrase (one scrypt stanza). */
export function isAgeKit(bytes: Uint8Array): boolean {
  return bytes.length > AGE_SCRYPT.length && AGE_SCRYPT.every((b, i) => bytes[i] === b);
}

/** What a re-picked cancel key must be to count as this tab's: the pocket the signer holds, and the file it saved. */
export interface KitExpectation {
  network: NetworkId;
  pocket_id: string;
  pocket_ua: string;
  fileName: string;
}

/**
 * Why a re-picked cancel key fails: `file`, not a cancel key at all; `passphrase`, it
 * does not open with the one typed; `pocket`, it opens but is another pocket's key;
 * `damaged`, it does not open cleanly, or its seed does not make its address.
 */
export type KitCheckReason = 'file' | 'passphrase' | 'pocket' | 'damaged';

export type KitCheck = { ok: true } | { ok: false; reason: KitCheckReason; message: string };

/** How a signer opens a kit: its file format, its decryption (in a worker, for WASM), and its address derivation. */
export interface KitOpener {
  looksLikeKit(bytes: Uint8Array): boolean;
  open(bytes: Uint8Array, passphrase: string): Promise<OpenedKit>;
  addressOf(network: NetworkId, seed: Uint8Array): Promise<string>;
}

/**
 * Proves that a cancel key the payer saved, then picked again, works: it opens with
 * `passphrase` the way /manage opens it, it names this tab's pocket (network, pocket id
 * and address), and its seed makes that address. The opened seed is zeroised before
 * this returns, whatever the outcome; nothing is kept or sent anywhere.
 */
export async function checkKit(bytes: Uint8Array, passphrase: string, expected: KitExpectation, opener: KitOpener): Promise<KitCheck> {
  const pick = `Pick ${expected.fileName}, the file you just downloaded.`;
  if (bytes.length === 0 || bytes.length > MAX_KIT_BYTES || !opener.looksLikeKit(bytes)) {
    return { ok: false, reason: 'file', message: `Wrong file: this is not a Cadence cancel key. ${pick}` };
  }
  let opened: OpenedKit;
  try {
    opened = await opener.open(bytes, passphrase);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (why.includes(WRONG_PASSPHRASE)) {
      return { ok: false, reason: 'passphrase', message: 'Wrong passphrase: the file does not open with it. Type the passphrase you chose for this key; it is case-sensitive.' };
    }
    return { ok: false, reason: 'damaged', message: `The file did not open: ${why}. Download the key again and pick the new file.` };
  }
  const { fields, seed } = opened;
  try {
    if (fields.network !== expected.network || fields.pocket_id !== expected.pocket_id) {
      return { ok: false, reason: 'pocket', message: `Wrong file: this is the cancel key of another pocket (${fields.pocket_id}), not of this one (${expected.pocket_id}). ${pick}` };
    }
    if (fields.pocket_ua !== expected.pocket_ua) {
      return { ok: false, reason: 'pocket', message: `Wrong file: this cancel key names this pocket's id but another address, so it would not open this pocket. ${pick}` };
    }
    if ((await opener.addressOf(fields.network, seed)) !== expected.pocket_ua) {
      return { ok: false, reason: 'damaged', message: "This cancel key is damaged: its seed does not make this pocket's address, so it could not cancel. Download the key again." };
    }
    return { ok: true };
  } finally {
    seed.fill(0);
  }
}

/**
 * A path as one POSIX shell word: as it is when every character is safe, else in single
 * quotes, each `'` written `'\''`. A browser saves a second download as "name (1).age".
 */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** `cadence cancel` with the kit: needs the runner (for the live note and its witness), over Tor. */
export function cliCancelCommand(fileName: string, refundUa?: string): string {
  return `cadence cancel --subscription ${shellPath(fileName)} --to ${refundUa?.trim() || '<your UA>'}`;
}

/** `cadence sweep` with the kit: needs only the seed and a lightwalletd server, over Tor; no runner. */
export function cliSweepCommand(fileName: string, refundUa?: string): string {
  return `cadence sweep --pocket ${shellPath(fileName)} --to ${refundUa?.trim() || '<your UA>'}`;
}
