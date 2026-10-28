/**
 * An offer's optional terms (runner features `trial` and `quote`): a free trial before the
 * first payment, and the merchant's own fiat label for the price.
 *
 * The label is display only. The merchant states a price and the rate they used; the page
 * computes `amount_zat` from them once, when the offer is made, and the payer signs that ZEC
 * amount. No price feed is asked for anything, so there are no third-party requests.
 */
import type { Offer } from '../api/types';
import { MAX_MONEY_ZAT, formatZec, unitFor, ZAT_PER_ZEC, type NetworkId } from './zat';

export type Quote = NonNullable<Offer['quote']>;

/** The longest trial the runner accepts: 30 days. */
export const TRIAL_MAX_SECS = 30 * 86_400;

/** The runner's bounds on a quote (contract v2, §2). */
export const QUOTE_LIMITS = { amountMinorMax: 1e9, rateMinorMax: 1e12 } as const;

const CURRENCY = /^[A-Z]{3}$/;

export function isCurrency(code: string): boolean {
  return CURRENCY.test(code);
}

/** Minor-unit digits of a currency as Intl knows it (USD 2, JPY 0, BHD 3); 2 for a code it does not know. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "US$5.00", "€4.50", "JP¥500", from minor units. */
export function formatMoney(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
}

/** Parses "5", "5.0" or "5.00" into minor units with at most `digits` decimals, or null. A comma is refused, not guessed at. */
export function parseMinor(input: string, digits: number): number | null {
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(input.trim());
  if (!m || (m[2] !== undefined && m[2].length > digits)) return null;
  const minor = Number(m[1]) * 10 ** digits + Number((m[2] ?? '').padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/** `round(amount_minor / zec_rate_minor × 100_000_000)`, exactly (half up), in zatoshis. */
export function quoteToZat(amountMinor: number, rateMinor: number): number {
  const a = BigInt(amountMinor) * BigInt(ZAT_PER_ZEC);
  const r = BigInt(rateMinor);
  return Number((2n * a + r) / (2n * r));
}

function an(n: number): boolean {
  const s = String(n);
  return s.startsWith('8') || /^1[18](\d{3})*$/.test(s);
}

/** "7-day", "12-hour", "90-minute": in the largest unit that divides the trial evenly. */
export function formatTrial(secs: number): string {
  if (secs % 86_400 === 0) return `${secs / 86_400}-day`;
  if (secs % 3_600 === 0) return `${secs / 3_600}-hour`;
  if (secs % 60 === 0) return `${secs / 60}-minute`;
  return `${secs}-second`;
}

/** "a 7-day", "an 8-day", "an 11-hour". */
export function aTrial(secs: number): string {
  const label = formatTrial(secs);
  return `${an(Number(label.split('-')[0])) ? 'an' : 'a'} ${label}`;
}

/** "First payment after a 7-day free trial". */
export function trialText(secs: number): string {
  return `First payment after ${aTrial(secs)} free trial`;
}

/** "28 Oct", with the year when it is not this year's. */
function quoteDate(setAt: number, now: number): string {
  const d = new Date(setAt * 1000);
  const sameYear = d.getFullYear() === new Date(now * 1000).getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "US$5.00 per payment, billed as 0.11876485 ZEC (the merchant's rate on 28 Oct: US$42.10 per ZEC)". */
export function quoteText(quote: Quote, amountZat: number, network: NetworkId, now: number): string {
  const unit = unitFor(network);
  return `${formatMoney(quote.amount_minor, quote.currency)} per payment, billed as ${formatZec(amountZat, network)} (the merchant's rate on ${quoteDate(quote.set_at, now)}: ${formatMoney(quote.zec_rate_minor, quote.currency)} per ${unit})`;
}

/** What the payer signs, and what the fiat price is. */
export function quoteNote(quote: Quote, amountZat: number, network: NetworkId): string {
  return `You sign ${formatZec(amountZat, network)} per payment. The ${quote.currency} price is the merchant's own label, at the rate they chose: no price feed sets it or checks it.`;
}

/**
 * The amount the merchant's own price and rate come to, when the offer's `amount_zat` is more
 * than 1% away from it, or null. The runner does not check the label; this page does, for the payer.
 */
export function quoteMismatch(quote: Quote, amountZat: number): number | null {
  const at = quoteToZat(quote.amount_minor, quote.zec_rate_minor);
  return Math.abs(amountZat - at) > at / 100 ? at : null;
}

/** A trial typed into the merchant form, as a count of `unitSecs` (a day or an hour). */
export function parseTrial(input: string, unitSecs: number): { secs: number } | { problem: string } {
  const v = input.trim();
  const n = v === '' ? 0 : /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n * unitSecs > TRIAL_MAX_SECS) {
    return { problem: unitSecs === 3_600 ? 'A whole number of hours, from 0 to 720 (30 days).' : 'A whole number of days, from 0 to 30.' };
  }
  return { secs: n * unitSecs };
}

export interface QuoteForm {
  currency: string;
  price: string;
  rate: string;
}

export type QuoteParse =
  | { ok: true; quote: Omit<Quote, 'set_at'>; amountZat: number }
  | { ok: false; problems: Partial<Record<'currency' | 'price' | 'rate' | 'amount', string>> };

/** The merchant's fiat price and own rate, checked against the runner's bounds, with the amount in zatoshis they come to. */
export function parseQuote(form: QuoteForm, network: NetworkId): QuoteParse {
  const unit = unitFor(network);
  const currency = form.currency.trim().toUpperCase();
  const problems: Partial<Record<'currency' | 'price' | 'rate' | 'amount', string>> = {};
  if (!isCurrency(currency)) problems.currency = 'Three letters, such as USD or EUR.';
  const digits = problems.currency ? 2 : currencyDigits(currency);
  const decimals = digits === 0 ? 'a whole number' : `at most ${digits} decimal${digits === 1 ? '' : 's'}`;
  const price = parseMinor(form.price, digits);
  const rate = parseMinor(form.rate, digits);
  const max = (minor: number) => (problems.currency ? `${minor / 10 ** digits}` : formatMoney(minor, currency));
  if (price === null || price < 1) problems.price = `A price above 0, ${decimals}.`;
  else if (price > QUOTE_LIMITS.amountMinorMax) problems.price = `At most ${max(QUOTE_LIMITS.amountMinorMax)}.`;
  if (rate === null || rate < 1) problems.rate = `What 1 ${unit} is worth to you, above 0, ${decimals}. Cadence asks no price feed.`;
  else if (rate > QUOTE_LIMITS.rateMinorMax) problems.rate = `At most ${max(QUOTE_LIMITS.rateMinorMax)}.`;
  if (Object.keys(problems).length) return { ok: false, problems };
  const amountZat = quoteToZat(price!, rate!);
  if (amountZat < 1) return { ok: false, problems: { amount: 'At this rate the price comes to less than 1 zatoshi.' } };
  if (amountZat > MAX_MONEY_ZAT) return { ok: false, problems: { amount: `At this rate the price comes to more than 21 million ${unit}.` } };
  return { ok: true, quote: { currency, amount_minor: price!, zec_rate_minor: rate! }, amountZat };
}
