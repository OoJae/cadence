/** Amounts are integer zatoshis everywhere; ZEC strings only at the edges. */

export const ZAT_PER_ZEC = 100_000_000;
/** 21 million ZEC: the most any single amount may be (ZIP 321 and consensus MAX_MONEY). */
export const MAX_MONEY_ZAT = 21_000_000 * ZAT_PER_ZEC;
/** ZIP 317 fee for a 2-action Ironwood transaction (every installment). */
export const INSTALLMENT_FEE_ZAT = 10_000;

const THIN_SPACE = String.fromCharCode(0x2009);

export type NetworkId = 'main' | 'test';

export function isZat(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MONEY_ZAT;
}

/** Exact decimal ZEC with trailing zeros trimmed: 500000 → "0.005", 1e8 → "1". */
export function zatToZecString(zat: number): string {
  if (!isZat(zat)) throw new RangeError(`not a valid zatoshi amount: ${zat}`);
  const whole = Math.floor(zat / ZAT_PER_ZEC);
  const frac = (zat % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Parses "0.005" (up to 8 decimals) into zatoshis, or null if malformed or out of range. */
export function parseZecToZat(input: string): number | null {
  const s = input.trim();
  const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(s) ?? /^()\.(\d{1,8})$/.exec(s);
  if (!m) return null;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = Number((m[2] ?? '').padEnd(8, '0') || '0');
  const zat = whole * ZAT_PER_ZEC + frac;
  return isZat(zat) ? zat : null;
}

export function unitFor(network: NetworkId): 'ZEC' | 'TAZ' {
  return network === 'main' ? 'ZEC' : 'TAZ';
}

/** "0.005 TAZ". Groups the whole part with thin spaces for readability. */
export function formatZec(zat: number, network: NetworkId = 'test'): string {
  const [w, f] = zatToZecString(zat).split('.');
  const grouped = w!.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return `${f ? `${grouped}.${f}` : grouped} ${unitFor(network)}`;
}

export function formatZat(zat: number): string {
  return `${zat.toLocaleString('en-US')} zats`;
}

/** What the payer funds the pocket with: every installment plus its fee. */
export function totalPrepaidZat(amountZat: number, count: number): number {
  return count * (amountZat + INSTALLMENT_FEE_ZAT);
}
