/**
 * The payer auth key: an Ed25519 key derived from the pocket seed, so whoever holds the
 * pocket (the subscribe tab, or an opened cancel key) can show the runner that a
 * subscription is theirs, as when asking for an access pass. The runner stores the
 * public key with the subscription; it never sees the seed.
 *
 *   ed25519_seed = HKDF-SHA256(ikm = pocket seed, salt = "cadence payer auth v1", info = "", L = 32)
 *
 * A signed request carries two headers, a unix timestamp and an Ed25519 signature over
 *
 *   cadence-payer-v1\n{METHOD}\n{PATH}\n{TIMESTAMP}\n{lowercase hex sha256 of the body}
 *
 * All WebCrypto: HKDF derives the Ed25519 seed, which is imported as PKCS#8 into a
 * non-extractable key and then zeroised. The signer (src/signer) is the only caller
 * that holds a pocket seed.
 */
import type { Method } from '../api/client';
import { base64urlToBytes } from './base64url';
import { nowSecs } from './time';

export const PAYER_AUTH_SALT = 'cadence payer auth v1';
export const PAYER_MESSAGE_TAG = 'cadence-payer-v1';
export const PAYER_TIMESTAMP_HEADER = 'X-Cadence-Payer-Timestamp';
export const PAYER_SIGNATURE_HEADER = 'X-Cadence-Payer-Signature';

/** The PKCS#8 DER of an Ed25519 private key, up to its 32-byte seed. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const utf8 = (text: string) => new TextEncoder().encode(text);

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

export type PayerHeaders = Record<typeof PAYER_TIMESTAMP_HEADER | typeof PAYER_SIGNATURE_HEADER, string>;

/** What a signer hands out for its pocket: the public key, and request signing. Never the seed. */
export interface PayerAuth {
  /** The Ed25519 public key, 64 hex characters: `payer_auth_key` in the upload. */
  readonly publicKeyHex: string;
  /** The two headers for a request. `body` is the exact text sent; `path` has no origin and no query. */
  sign(method: Method, path: string, body: string): Promise<PayerHeaders>;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

/** The 32-byte Ed25519 seed for a pocket seed. The caller zeroises it. */
export async function derivePayerSeed(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new Error('a pocket seed is 32 bytes');
  const ikm = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: utf8(PAYER_AUTH_SALT), info: new Uint8Array(0) }, ikm, 256));
}

/**
 * Imports a 32-byte Ed25519 seed as a non-extractable signing key, and its public key.
 * WebCrypto gives the public half only through a JWK export, so the seed is imported
 * once more, extractable, just to read it.
 */
export async function ed25519FromSeed(edSeed: Uint8Array): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  if (edSeed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX);
  der.set(edSeed, PKCS8_ED25519_PREFIX.length);
  try {
    const [privateKey, readable] = await Promise.all([
      crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']),
      crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']),
    ]);
    const { x } = await crypto.subtle.exportKey('jwk', readable);
    if (!x) throw new Error('this browser did not export the Ed25519 public key');
    return { privateKey, publicKey: base64urlToBytes(x) };
  } finally {
    der.fill(0);
  }
}

/** The text a payer signs for one request. */
export function payerMessage(method: Method, path: string, timestamp: number, bodySha256Hex: string): string {
  return `${PAYER_MESSAGE_TAG}\n${method}\n${path}\n${timestamp}\n${bodySha256Hex}`;
}

function checkPath(path: string): void {
  if (!path.startsWith('/') || /[?#]/.test(path)) throw new Error('a signed path has no origin and no query');
}

/**
 * The payer auth key of a pocket seed. The seed is read once, here; the result holds only
 * a non-extractable CryptoKey. `now` is the clock the timestamps come from.
 */
export async function payerAuthFromSeed(seed: Uint8Array, opts: { now?: () => number } = {}): Promise<PayerAuth> {
  const now = opts.now ?? nowSecs;
  const edSeed = await derivePayerSeed(seed);
  let key: { privateKey: CryptoKey; publicKey: Uint8Array };
  try {
    key = await ed25519FromSeed(edSeed);
  } finally {
    edSeed.fill(0);
  }
  const { privateKey } = key;
  let last = 0;
  return {
    publicKeyHex: toHex(key.publicKey),
    async sign(method, path, body) {
      checkPath(path);
      // Ed25519 is deterministic and the runner refuses a signature it has already seen,
      // so a second request in the same second takes the next second.
      const ts = Math.max(Math.floor(now()), last + 1);
      last = ts;
      const message = payerMessage(method, path, ts, await sha256Hex(utf8(body)));
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, utf8(message)));
      return { [PAYER_TIMESTAMP_HEADER]: String(ts), [PAYER_SIGNATURE_HEADER]: toHex(signature) };
    },
  };
}

/** Checks a payer signature as the runner does, without the clock and replay checks. For the mock runner and tests. */
export async function verifyPayerSignature(publicKeyHex: string, method: Method, path: string, timestamp: number, body: string, signatureHex: string): Promise<boolean> {
  if (!HEX32.test(publicKeyHex) || !HEX64.test(signatureHex)) return false;
  const key = await crypto.subtle.importKey('raw', fromHex(publicKeyHex) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  const message = payerMessage(method, path, timestamp, await sha256Hex(utf8(body)));
  return crypto.subtle.verify('Ed25519', key, fromHex(signatureHex) as BufferSource, utf8(message));
}
