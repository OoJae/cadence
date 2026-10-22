import { describe, expect, it } from 'vitest';
import { utf8Encode } from './base64url';
import { seededBech32 } from './prng';
import { parseZecToZat, totalPrepaidZat, zatToZecString } from './zat';
import { buildZip321Uri, parseZip321Uri } from './zip321';

const ua = `utest1${seededBech32('pocket', 104)}`;

describe('ZIP 321 URI building', () => {
  it('puts the pocket UA in the path and the amount in decimal ZEC', () => {
    const uri = buildZip321Uri({ address: ua, amountZat: totalPrepaidZat(500_000, 3) });
    expect(uri).toBe(`zcash:${ua}?amount=0.0153`);
  });

  it('formats amounts exactly, with no float drift or trailing zeros', () => {
    expect(zatToZecString(1)).toBe('0.00000001');
    expect(zatToZecString(100_000_000)).toBe('1');
    expect(zatToZecString(123_456_789)).toBe('1.23456789');
    expect(zatToZecString(10_000)).toBe('0.0001');
    expect(zatToZecString(2_100_000_000_000_000)).toBe('21000000');
    expect(() => zatToZecString(-1)).toThrow();
    expect(() => zatToZecString(0.5)).toThrow();
  });

  it('parses decimal ZEC back to zatoshis', () => {
    expect(parseZecToZat('0.0153')).toBe(1_530_000);
    expect(parseZecToZat('.5')).toBe(50_000_000);
    expect(parseZecToZat('1.123456789')).toBeNull();
    expect(parseZecToZat('1e3')).toBeNull();
    expect(parseZecToZat('21000001')).toBeNull();
  });

  it('encodes the memo as base64url without padding', () => {
    const uri = buildZip321Uri({ address: ua, amountZat: 1, memo: 'Cadence: Shielded Press (3 × 0.005 TAZ)' });
    const memo = new URL(uri.replace('zcash:', 'zcash://x/')).searchParams.get('memo')!;
    expect(memo).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseZip321Uri(uri).memoText).toBe('Cadence: Shielded Press (3 × 0.005 TAZ)');
  });

  it('percent-encodes label and message', () => {
    const uri = buildZip321Uri({ address: ua, label: 'Café & co', message: 'a=b?' });
    expect(uri).toContain('label=Caf%C3%A9%20%26%20co');
    expect(uri).toContain('message=a%3Db%3F');
    const parsed = parseZip321Uri(uri);
    expect(parsed.label).toBe('Café & co');
    expect(parsed.message).toBe('a=b?');
  });

  it('round-trips amount, memo and address', () => {
    const memo = utf8Encode('opaque tag');
    const p = parseZip321Uri(buildZip321Uri({ address: ua, amountZat: 330_000, memo }));
    expect(p.address).toBe(ua);
    expect(p.amountZat).toBe(330_000);
    expect(Array.from(p.memo!)).toEqual(Array.from(memo));
  });

  it('refuses memos to transparent addresses and memos over 512 bytes', () => {
    expect(() => buildZip321Uri({ address: 'tmabc123', memo: 'hi' })).toThrow(/shielded/);
    expect(() => buildZip321Uri({ address: ua, memo: 'x'.repeat(513) })).toThrow(/512/);
    expect(() => buildZip321Uri({ address: ua, memo: 'x'.repeat(512) })).not.toThrow();
  });

  it('refuses addresses that could break out of the URI', () => {
    expect(() => buildZip321Uri({ address: `${ua}?amount=999` })).toThrow();
  });

  it('rejects unknown required parameters when parsing', () => {
    expect(() => parseZip321Uri(`zcash:${ua}?req-future=1`)).toThrow(/required/);
  });
});
