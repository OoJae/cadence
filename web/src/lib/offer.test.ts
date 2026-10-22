import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { bytesToBase64url, utf8Encode } from './base64url';
import { QUICKNET } from './drand';
import { buildShareUrl, encodeOfferPayload, parseOfferFragment } from './offer';
import { seededBech32 } from './prng';

const offer: Offer = {
  offer_id: 'off_test123',
  name: 'Shielded Press · monthly',
  amount_zat: 500_000,
  period_secs: 2_592_000,
  count: 3,
  merchant_ua: `utest1${seededBech32('m', 104)}`,
  runner_age_recipient: `age1${seededBech32('a', 58)}`,
  runner_endpoint: 'https://runner.example',
  network: 'test',
  drand_chain: QUICKNET.hash,
};

const frag = (o: unknown) => `#offer=${bytesToBase64url(utf8Encode(JSON.stringify(o)))}`;
const problemsOf = (hash: string) => {
  const r = parseOfferFragment(hash);
  return r.ok ? [] : r.problems.map((p) => p.field);
};

describe('offer fragment', () => {
  it('round-trips through a share URL, and the offer lives only in the fragment', () => {
    const url = new URL(buildShareUrl('https://pay.example/', offer));
    expect(url.pathname).toBe('/subscribe');
    expect(url.search).toBe('');
    expect(url.hash.startsWith('#offer=')).toBe(true);
    const r = parseOfferFragment(url.hash);
    expect(r).toEqual({ ok: true, offer });
  });

  it('accepts the hash with or without "#", and ignores other parameters', () => {
    const payload = encodeOfferPayload(offer);
    expect(parseOfferFragment(`offer=${payload}`).ok).toBe(true);
    expect(parseOfferFragment(`#ref=abc&offer=${payload}`).ok).toBe(true);
  });

  it('uses base64url without padding (no +, / or =)', () => {
    expect(encodeOfferPayload({ ...offer, name: '???>>>~~~' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('drops unknown fields', () => {
    const r = parseOfferFragment(frag({ ...offer, evil: '<script>' }));
    expect(r.ok && Object.keys(r.offer)).not.toContain('evil');
  });

  it('rejects links without an offer, damaged payloads and duplicate offers', () => {
    expect(problemsOf('')).toEqual(['fragment']);
    expect(problemsOf('#nothing=here')).toEqual(['fragment']);
    expect(problemsOf('#offer=%%%')).toEqual(['fragment']);
    expect(problemsOf('#offer=bm90IGpzb24')).toEqual(['fragment']); // "not json"
    const p = encodeOfferPayload(offer);
    expect(problemsOf(`#offer=${p}&offer=${p}`)).toEqual(['fragment']);
    expect(problemsOf(`#offer=${'A'.repeat(9000)}`)).toEqual(['fragment']);
  });

  it('type- and range-checks every field', () => {
    expect(problemsOf(frag({ ...offer, amount_zat: 0 }))).toContain('amount_zat');
    expect(problemsOf(frag({ ...offer, amount_zat: 1.5 }))).toContain('amount_zat');
    expect(problemsOf(frag({ ...offer, amount_zat: '500000' }))).toContain('amount_zat');
    expect(problemsOf(frag({ ...offer, count: 0 }))).toContain('count');
    expect(problemsOf(frag({ ...offer, count: 61 }))).toContain('count');
    expect(problemsOf(frag({ ...offer, period_secs: 1 }))).toContain('period_secs');
    expect(problemsOf(frag({ ...offer, offer_id: '../../etc' }))).toContain('offer_id');
    expect(problemsOf(frag({ ...offer, network: 'regtest' }))).toContain('network');
    expect(problemsOf(frag({ ...offer, runner_age_recipient: 'age1short' }))).toContain('runner_age_recipient');
  });

  it('refuses a merchant address from the wrong network', () => {
    expect(problemsOf(frag({ ...offer, network: 'main' }))).toEqual(['merchant_ua']);
    expect(problemsOf(frag({ ...offer, merchant_ua: 't1abc' }))).toEqual(['merchant_ua']);
  });

  it('only accepts https runners, or http to a .onion service', () => {
    expect(problemsOf(frag({ ...offer, runner_endpoint: 'http://runner.example' }))).toEqual(['runner_endpoint']);
    expect(problemsOf(frag({ ...offer, runner_endpoint: 'javascript:alert(1)' }))).toEqual(['runner_endpoint']);
    expect(problemsOf(frag({ ...offer, runner_endpoint: 'http://abcdefghijklmnop.onion' }))).toEqual([]);
  });

  it('refuses names that could spoof the display', () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    expect(problemsOf(frag({ ...offer, name: `Monthly ${rlo}gnp.exe` }))).toEqual(['name']);
    expect(problemsOf(frag({ ...offer, name: `Pay${zwsp}ment` }))).toEqual(['name']);
    expect(problemsOf(frag({ ...offer, name: 'line\nbreak' }))).toEqual(['name']);
    expect(problemsOf(frag({ ...offer, name: 'x'.repeat(81) }))).toEqual(['name']);
  });

  it('only time-locks to drand quicknet', () => {
    expect(problemsOf(frag({ ...offer, drand_chain: '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce' }))).toEqual(['drand_chain']);
  });

  it('refuses schedules that exceed the money supply', () => {
    expect(problemsOf(frag({ ...offer, amount_zat: 1_000_000 * 1e8, count: 60 }))).toEqual(['amount_zat']);
  });
});
