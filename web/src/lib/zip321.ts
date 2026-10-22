/**
 * ZIP 321 payment request URIs (single payment form):
 *
 *   zcash:<address>?amount=<decimal ZEC>&memo=<base64url, no padding>&label=…&message=…
 *
 * Any ZIP 321 wallet (Zodl included) can pay it by scanning one QR code.
 */
import { base64urlToBytes, bytesToBase64url, utf8Decode, utf8Encode } from './base64url';
import { MAX_MONEY_ZAT, parseZecToZat, zatToZecString } from './zat';

export const MAX_MEMO_BYTES = 512;

export interface Zip321Payment {
  address: string;
  amountZat?: number;
  /** Raw memo bytes, or text (encoded as UTF-8). Shielded recipients only. */
  memo?: Uint8Array | string;
  label?: string;
  message?: string;
}

function isShielded(address: string): boolean {
  // Unified (u1/utest1) or Sapling (zs/ztestsapling). Transparent (t…) and TEX cannot take memos.
  return /^(u1|utest1|zs1|ztestsapling1)/.test(address);
}

/** Percent-encodes a qchar value. encodeURIComponent only leaves ZIP 321-legal characters raw. */
const q = (s: string) => encodeURIComponent(s);

export function buildZip321Uri(p: Zip321Payment): string {
  if (!/^[a-z0-9]+$/i.test(p.address)) throw new Error('the address contains characters no Zcash address has');
  const params: string[] = [];

  if (p.amountZat !== undefined) {
    if (!Number.isSafeInteger(p.amountZat) || p.amountZat < 0 || p.amountZat > MAX_MONEY_ZAT) {
      throw new RangeError('amount out of range');
    }
    params.push(`amount=${zatToZecString(p.amountZat)}`);
  }

  if (p.memo !== undefined) {
    if (!isShielded(p.address)) throw new Error('ZIP 321 memos are only allowed for shielded recipients');
    const bytes = typeof p.memo === 'string' ? utf8Encode(p.memo) : p.memo;
    if (bytes.length > MAX_MEMO_BYTES) throw new RangeError(`memo is ${bytes.length} bytes, the limit is ${MAX_MEMO_BYTES}`);
    params.push(`memo=${bytesToBase64url(bytes)}`);
  }

  if (p.label) params.push(`label=${q(p.label)}`);
  if (p.message) params.push(`message=${q(p.message)}`);

  return `zcash:${p.address}${params.length ? `?${params.join('&')}` : ''}`;
}

export interface ParsedZip321 {
  address: string;
  amountZat?: number;
  memo?: Uint8Array;
  memoText?: string;
  label?: string;
  message?: string;
}

/** Parses the single-payment form. Used by tests and to double-check what we render. */
export function parseZip321Uri(uri: string): ParsedZip321 {
  const m = /^zcash:([a-z0-9]+)(?:\?(.*))?$/i.exec(uri);
  if (!m) throw new Error('not a single-payment zcash: URI');
  const out: ParsedZip321 = { address: m[1]! };
  const seen = new Set<string>();
  for (const pair of (m[2] ?? '').split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`malformed parameter "${pair}"`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (seen.has(key)) throw new Error(`duplicate parameter "${key}"`);
    seen.add(key);
    switch (key) {
      case 'amount': {
        const zat = parseZecToZat(value);
        if (zat === null) throw new Error(`bad amount "${value}"`);
        out.amountZat = zat;
        break;
      }
      case 'memo': {
        out.memo = base64urlToBytes(value);
        try {
          out.memoText = utf8Decode(out.memo);
        } catch {
          /* binary memo */
        }
        break;
      }
      case 'label':
        out.label = decodeURIComponent(value);
        break;
      case 'message':
        out.message = decodeURIComponent(value);
        break;
      default:
        if (key.startsWith('req-')) throw new Error(`unsupported required parameter "${key}"`);
    }
  }
  return out;
}
