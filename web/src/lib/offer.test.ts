import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { bytesToBase64url, utf8Encode } from './base64url';
import { QUICKNET } from './drand';
import { buildShareUrl, encodeOfferPayload, horizonProblem, lastReleaseAfter, maxCountWithinHorizon, MAX_HORIZON_DAYS, parseOfferFragment } from './offer';
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

describe('offer horizon', () => {
  const DAY = 86400;
  const plan = (period_secs: number, count: number) => ({ period_secs, count });

  it('measures from signing to the last release: the first lead, then count - 1 periods', () => {
    expect(lastReleaseAfter(plan(30 * DAY, 1))).toBe(60);
    expect(lastReleaseAfter(plan(30 * DAY, 2))).toBe(30 * DAY + 60);
    // A period under a minute is also the first release's lead.
    expect(lastReleaseAfter(plan(20, 8))).toBe(8 * 20);
  });

  it(`refuses a plan whose last installment falls more than ${MAX_HORIZON_DAYS} days after signing`, () => {
    expect(horizonProblem(plan(30 * DAY, 2))).toBeNull();
    expect(horizonProblem(plan(30 * DAY, 3))).toMatch(/cannot yet seal a payment due more than 45 days after signing.*about 60 days/);
    expect(horizonProblem(plan(7 * DAY, 7))).toBeNull();
    expect(horizonProblem(plan(7 * DAY, 8))).toMatch(/Ask the merchant for a shorter plan/);
    // The edge: 44 days and a minute passes, 45 days and a minute does not.
    expect(horizonProblem(plan(DAY, 45))).toBeNull();
    expect(horizonProblem(plan(DAY, 46))).toMatch(/falls due just over 45 days after/);
    // One installment releases a minute after signing, whatever its period.
    expect(horizonProblem(plan(366 * DAY, 1))).toBeNull();
    // The sandbox's plans are minutes long.
    expect(horizonProblem(plan(180, 4))).toBeNull();
  });

  it('says how many installments a period allows', () => {
    expect(maxCountWithinHorizon(30 * DAY)).toBe(2);
    expect(maxCountWithinHorizon(7 * DAY)).toBe(7);
    expect(maxCountWithinHorizon(DAY)).toBe(45);
    expect(maxCountWithinHorizon(366 * DAY)).toBe(1);
    for (const period of [10, 90, 3600, DAY, 7 * DAY, 30 * DAY, 60 * DAY]) {
      const n = maxCountWithinHorizon(period);
      expect(horizonProblem(plan(period, n))).toBeNull();
      expect(horizonProblem(plan(period, n + 1))).not.toBeNull();
    }
  });

  it('parses an offer past the horizon (the plan step refuses it, saying why)', () => {
    expect(parseOfferFragment(frag({ ...offer, count: 3 })).ok).toBe(true);
  });
});
