import { describe, expect, it } from 'vitest';
import {
  aTrial,
  currencyDigits,
  formatMoney,
  formatTrial,
  parseMinor,
  parseQuote,
  parseTrial,
  quoteMismatch,
  quoteNote,
  quoteText,
  quoteToZat,
  TRIAL_MAX_SECS,
  trialText,
} from './terms';

const DAY = 86_400;
/** 28 Oct 2026, 12:00 UTC: the same calendar day in every time zone within 11 hours of UTC. */
const OCT28 = Date.UTC(2026, 9, 28, 12) / 1000;
const QUOTE = { currency: 'USD', amount_minor: 500, zec_rate_minor: 4210, set_at: OCT28 };

describe('a trial', () => {
  it('reads in the largest unit that divides it, with the right article', () => {
    expect(formatTrial(7 * DAY)).toBe('7-day');
    expect(formatTrial(12 * 3600)).toBe('12-hour');
    expect(formatTrial(90 * 60)).toBe('90-minute');
    expect(formatTrial(45)).toBe('45-second');
    expect(trialText(7 * DAY)).toBe('First payment after a 7-day free trial');
    expect(trialText(8 * DAY)).toBe('First payment after an 8-day free trial');
    expect(aTrial(11 * DAY)).toBe('an 11-day');
    expect(aTrial(18 * 3600)).toBe('an 18-hour');
    expect(aTrial(1 * DAY)).toBe('a 1-day');
    expect(aTrial(30 * DAY)).toBe('a 30-day');
  });

  it('is typed as whole days or hours, from 0 to 30 days', () => {
    expect(parseTrial('7', DAY)).toEqual({ secs: 7 * DAY });
    expect(parseTrial('', DAY)).toEqual({ secs: 0 });
    expect(parseTrial('0', 3600)).toEqual({ secs: 0 });
    expect(parseTrial('30', DAY)).toEqual({ secs: TRIAL_MAX_SECS });
    expect(parseTrial('720', 3600)).toEqual({ secs: TRIAL_MAX_SECS });
    for (const bad of ['31', '1.5', '-1', 'seven', '1e2']) expect(parseTrial(bad, DAY)).toHaveProperty('problem');
    expect(parseTrial('721', 3600)).toEqual({ problem: 'A whole number of hours, from 0 to 720 (30 days).' });
  });
});

describe('a quote', () => {
  it('computes amount_zat as round(amount_minor / zec_rate_minor × 10^8), exactly and half up', () => {
    expect(quoteToZat(500, 4210)).toBe(11_876_485); // 11 876 484.56…
    expect(quoteToZat(1, 200_000_000)).toBe(1); // 0.5 rounds up
    expect(quoteToZat(1, 300_000_000)).toBe(0);
    expect(quoteToZat(1e9, 1)).toBe(1e17); // past 2^53 in floating point, exact here
    expect(quoteToZat(999_999_999, 7)).toBe(Math.round(999_999_999e8 / 7));
  });

  it('formats money with Intl and the currency code, in its own minor units', () => {
    expect(formatMoney(500, 'USD')).toBe('US$5.00');
    expect(formatMoney(4210, 'USD')).toBe('US$42.10');
    expect(formatMoney(450, 'EUR')).toBe('€4.50');
    expect(formatMoney(500, 'JPY')).toBe('JP¥500');
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('BHD')).toBe(3);
    expect(currencyDigits('XQQ')).toBe(2);
  });

  it('parses a price with no more decimals than the currency has, and refuses a comma', () => {
    expect(parseMinor('5.00', 2)).toBe(500);
    expect(parseMinor('5', 2)).toBe(500);
    expect(parseMinor(' 42.1 ', 2)).toBe(4210);
    expect(parseMinor('500', 0)).toBe(500);
    expect(parseMinor('5.001', 2)).toBeNull();
    expect(parseMinor('500.5', 0)).toBeNull();
    expect(parseMinor('5,00', 2)).toBeNull();
    expect(parseMinor('', 2)).toBeNull();
    expect(parseMinor('-5', 2)).toBeNull();
  });

  it("checks the merchant's form against the runner's bounds", () => {
    expect(parseQuote({ currency: 'usd', price: '5.00', rate: '42.10' }, 'main')).toEqual({
      ok: true,
      quote: { currency: 'USD', amount_minor: 500, zec_rate_minor: 4210 },
      amountZat: 11_876_485,
    });
    expect(parseQuote({ currency: 'JPY', price: '500', rate: '6000' }, 'main')).toMatchObject({ ok: true, amountZat: 8_333_333 });
    const problems = (form: { currency: string; price: string; rate: string }) => {
      const r = parseQuote(form, 'test');
      return r.ok ? {} : r.problems;
    };
    expect(problems({ currency: 'US', price: '5', rate: '42' })).toHaveProperty('currency', 'Three letters, such as USD or EUR.');
    expect(problems({ currency: 'USD', price: '5.001', rate: '42' }).price).toBe('A price above 0, at most 2 decimals.');
    expect(problems({ currency: 'JPY', price: '5.5', rate: '42' }).price).toBe('A price above 0, a whole number.');
    expect(problems({ currency: 'USD', price: '0', rate: '42' })).toHaveProperty('price');
    expect(problems({ currency: 'USD', price: '10000000.01', rate: '42' }).price).toBe('At most US$10,000,000.00.');
    expect(problems({ currency: 'USD', price: '5', rate: '' }).rate).toBe('What 1 TAZ is worth to you, above 0, at most 2 decimals. Cadence asks no price feed.');
    expect(problems({ currency: 'USD', price: '0.01', rate: '9999999999.99' }).amount).toBe('At this rate the price comes to less than 1 zatoshi.');
    expect(problems({ currency: 'USD', price: '10000000', rate: '0.01' }).amount).toBe('At this rate the price comes to more than 21 million TAZ.');
  });

  it('shows the payer the fiat label next to the ZEC amount they sign', () => {
    const now = OCT28 + 3600;
    expect(quoteText(QUOTE, 11_876_485, 'main', now)).toBe("US$5.00 per payment, billed as 0.11876485 ZEC (the merchant's rate on 28 Oct: US$42.10 per ZEC)");
    expect(quoteText(QUOTE, 11_876_485, 'test', now)).toBe("US$5.00 per payment, billed as 0.11876485 TAZ (the merchant's rate on 28 Oct: US$42.10 per TAZ)");
    expect(quoteText({ ...QUOTE, set_at: OCT28 - 365 * DAY }, 11_876_485, 'main', now)).toContain('rate on 28 Oct 2025:');
    expect(quoteNote(QUOTE, 11_876_485, 'main')).toBe(
      "You sign 0.11876485 ZEC per payment. The USD price is the merchant's own label, at the rate they chose: no price feed sets it or checks it.",
    );
  });

  it('flags an amount more than 1% from what the price comes to at the merchant’s own rate', () => {
    expect(quoteMismatch(QUOTE, 11_876_485)).toBeNull();
    expect(quoteMismatch(QUOTE, 11_900_000)).toBeNull();
    expect(quoteMismatch(QUOTE, 100_000_000)).toBe(11_876_485);
    expect(quoteMismatch(QUOTE, 11_000_000)).toBe(11_876_485);
  });
});
