import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { base64urlToBytes, bytesToBase64url, utf8Decode, utf8Encode } from './base64url';
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

  it('reads a trial of up to 30 days, and no trial and a trial of 0 alike', () => {
    const r = parseOfferFragment(frag({ ...offer, trial_secs: 7 * 86400 }));
    expect(r.ok && r.offer.trial_secs).toBe(7 * 86400);
    expect(parseOfferFragment(frag({ ...offer, trial_secs: 0 }))).toEqual({ ok: true, offer });
    for (const bad of [-1, 30 * 86400 + 1, 1.5, '604800', null]) expect(problemsOf(frag({ ...offer, trial_secs: bad }))).toEqual(['trial_secs']);
  });

  it('carries a trial in the link, so the runner-copy check covers it', () => {
    const trial = { ...offer, trial_secs: 7 * 86400 };
    expect(parseOfferFragment(new URL(buildShareUrl('https://pay.example', trial)).hash)).toEqual({ ok: true, offer: trial });
    expect(encodeOfferPayload(trial)).not.toBe(encodeOfferPayload(offer));
    // A runner's copy always says trial_secs, 0 when there is none; an older runner's never does.
    expect(encodeOfferPayload({ ...offer, trial_secs: 0 })).toBe(encodeOfferPayload(offer));
  });
});

describe('offer horizon', () => {
  const DAY = 86400;
  const J = 6 * 3600;
  const plan = (period_secs: number, count: number, trial_secs?: number) => ({ period_secs, count, trial_secs });

  it('measures from signing to the latest last release: any trial, the first lead, count - 1 periods, then the most jitter', () => {
    expect(lastReleaseAfter(plan(30 * DAY, 1))).toBe(60 + J);
    expect(lastReleaseAfter(plan(30 * DAY, 2))).toBe(30 * DAY + 60 + J);
    // A period under a minute is also the first release's lead; its jitter is a quarter of it.
    expect(lastReleaseAfter(plan(20, 8))).toBe(8 * 20 + 5);
    expect(lastReleaseAfter(plan(30 * DAY, 1, 7 * DAY))).toBe(7 * DAY + 60 + J);
  });

  it(`refuses a plan whose last installment falls more than ${MAX_HORIZON_DAYS} days after signing`, () => {
    expect(horizonProblem(plan(30 * DAY, 2))).toBeNull();
    expect(horizonProblem(plan(30 * DAY, 3))).toMatch(/cannot yet seal a payment due more than 45 days after signing.*about 60 days/);
    expect(horizonProblem(plan(7 * DAY, 7))).toBeNull();
    expect(horizonProblem(plan(7 * DAY, 8))).toMatch(/Ask the merchant for a shorter plan/);
    // The edge: 44 days, 6 h and a minute passes, 45 days, 6 h and a minute does not.
    expect(horizonProblem(plan(DAY, 45))).toBeNull();
    expect(horizonProblem(plan(DAY, 46))).toMatch(/falls due just over 45 days after/);
    // One installment releases within a minute and its jitter of signing, whatever its period.
    expect(horizonProblem(plan(366 * DAY, 1))).toBeNull();
    // The sandbox's plans are minutes long.
    expect(horizonProblem(plan(180, 4))).toBeNull();
    // A trial counts: a week's trial pushes a 7-week plan past the horizon.
    expect(horizonProblem(plan(7 * DAY, 6, 7 * DAY))).toBeNull();
    expect(horizonProblem(plan(7 * DAY, 7, 7 * DAY))).toMatch(/about 49 days/);
    expect(horizonProblem(plan(DAY, 1, 30 * DAY))).toBeNull();
  });

  it('says how many installments a period allows, after any trial', () => {
    expect(maxCountWithinHorizon(30 * DAY)).toBe(2);
    expect(maxCountWithinHorizon(7 * DAY)).toBe(7);
    expect(maxCountWithinHorizon(DAY)).toBe(45);
    expect(maxCountWithinHorizon(366 * DAY)).toBe(1);
    expect(maxCountWithinHorizon(7 * DAY, 7 * DAY)).toBe(6);
    expect(maxCountWithinHorizon(30 * DAY, 30 * DAY)).toBe(1);
    for (const trial of [0, 3600, DAY, 7 * DAY, 30 * DAY]) {
      for (const period of [10, 90, 300, 3600, DAY, 7 * DAY, 30 * DAY, 60 * DAY]) {
        const n = maxCountWithinHorizon(period, trial);
        expect(horizonProblem(plan(period, n, trial))).toBeNull();
        expect(horizonProblem(plan(period, n + 1, trial))).not.toBeNull();
      }
    }
  });

  it('parses an offer past the horizon (the plan step refuses it, saying why)', () => {
    expect(parseOfferFragment(frag({ ...offer, count: 3 })).ok).toBe(true);
  });
});

describe('offer terms: trial and quote (contract v2)', () => {
  const DAY = 86400;
  const quote = { currency: 'USD', amount_minor: 500, zec_rate_minor: 4210, set_at: 1_793_170_000 };
  const termed: Offer = { ...offer, trial_secs: 7 * DAY, quote };
  const keysOf = (payload: string) => Object.keys(JSON.parse(utf8Decode(base64urlToBytes(payload))));

  it('round-trip through a share URL', () => {
    expect(parseOfferFragment(new URL(buildShareUrl('https://pay.example', termed)).hash)).toEqual({ ok: true, offer: termed });
  });

  it("leave an offer without them encoded as an older runner's, so the runner-copy check still matches", () => {
    expect(keysOf(encodeOfferPayload(offer))).toEqual(Object.keys(offer));
    // A v2 runner's copy says trial_secs: 0; an older runner's link says nothing.
    expect(encodeOfferPayload({ ...offer, trial_secs: 0 })).toBe(encodeOfferPayload(offer));
    const v2Link = parseOfferFragment(frag({ ...offer, trial_secs: 0 }));
    expect(v2Link.ok && encodeOfferPayload(v2Link.offer)).toBe(encodeOfferPayload(offer));
    expect(parseOfferFragment(frag({ ...offer, quote: null })).ok).toBe(true);
  });

  it('compare in a fixed order, and tell a different trial or price apart', () => {
    const shuffled = { set_at: quote.set_at, zec_rate_minor: quote.zec_rate_minor, amount_minor: quote.amount_minor, currency: quote.currency };
    expect(encodeOfferPayload({ ...termed, quote: shuffled })).toBe(encodeOfferPayload(termed));
    expect(encodeOfferPayload({ ...termed, trial_secs: 8 * DAY })).not.toBe(encodeOfferPayload(termed));
    expect(encodeOfferPayload({ ...termed, quote: { ...quote, amount_minor: 50 } })).not.toBe(encodeOfferPayload(termed));
    expect(encodeOfferPayload({ ...offer, quote })).not.toBe(encodeOfferPayload(offer));
  });

  it('are type- and range-checked, and a quote keeps only its own fields', () => {
    for (const trial_secs of [-1, 30 * DAY + 1, '7', 1.5]) expect(problemsOf(frag({ ...offer, trial_secs }))).toEqual(['trial_secs']);
    expect(problemsOf(frag({ ...offer, trial_secs: 30 * DAY }))).toEqual([]);
    for (const bad of [
      { ...quote, currency: 'usd' },
      { ...quote, currency: 'USDT' },
      { ...quote, amount_minor: 0 },
      { ...quote, amount_minor: 1e9 + 1 },
      { ...quote, zec_rate_minor: 1e12 + 1 },
      { ...quote, zec_rate_minor: 42.1 },
      { currency: 'USD', amount_minor: 500, zec_rate_minor: 4210 },
      [quote],
      'US$5',
    ]) {
      expect(problemsOf(frag({ ...offer, quote: bad }))).toEqual(['quote']);
    }
    const r = parseOfferFragment(frag({ ...offer, quote: { ...quote, note: '<script>' } }));
    expect(r.ok && r.offer.quote).toEqual(quote);
  });

  it('count the trial towards the horizon', () => {
    expect(maxCountWithinHorizon(30 * DAY, 0)).toBe(2);
    expect(maxCountWithinHorizon(30 * DAY, 7 * DAY)).toBe(2);
    expect(maxCountWithinHorizon(30 * DAY, 15 * DAY)).toBe(1);
    expect(maxCountWithinHorizon(7 * DAY, 7 * DAY)).toBe(6);
    expect(maxCountWithinHorizon(DAY, 30 * DAY)).toBe(15);
    for (const [period, trial] of [
      [DAY, 3 * DAY],
      [7 * DAY, 2 * DAY],
      [3600, 30 * DAY],
      [90, 12 * 3600],
    ] as const) {
      const n = maxCountWithinHorizon(period, trial);
      expect(trial + lastReleaseAfter({ period_secs: period, count: n })).toBeLessThanOrEqual(MAX_HORIZON_DAYS * DAY);
      expect(trial + lastReleaseAfter({ period_secs: period, count: n + 1 })).toBeGreaterThan(MAX_HORIZON_DAYS * DAY);
    }
  });
});
