/**
 * Deterministic, NON-cryptographic pseudo-randomness for mock data only (stable mock
 * txids across reloads). Anything secret uses crypto.getRandomValues instead.
 */
import { BECH32_CHARS } from './addresses';

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededHex(seed: string, chars = 64): string {
  const rnd = mulberry32(fnv1a(seed));
  let out = '';
  for (let i = 0; i < chars; i++) out += Math.floor(rnd() * 16).toString(16);
  return out;
}

export function seededBech32(seed: string, chars: number): string {
  const rnd = mulberry32(fnv1a(seed));
  let out = '';
  for (let i = 0; i < chars; i++) out += BECH32_CHARS[Math.floor(rnd() * 32)];
  return out;
}

export function seededInt(seed: string, maxExclusive: number): number {
  return Math.floor(mulberry32(fnv1a(seed))() * maxExclusive);
}

export function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
