/**
 * The offer travels in the URL fragment (`/subscribe#offer=<base64url(json)>`).
 * Browsers never send the fragment to any server, so the web host never sees the
 * offer itself. Opening a link is not private, though: /subscribe asks the runner the
 * offer names for its copy by id (GET /api/offers/:id) as soon as the page opens, so
 * that runner and its hosting edge see the visitor's IP address and the offer id.
 *
 * A share link is attacker-controllable input, so parsing is strict: every field is
 * type- and range-checked, unknown fields are dropped, and text that could spoof the
 * display (control or bidirectional-override characters) is refused.
 */
import type { Offer } from '../api/types';
import { base64urlToBytes, bytesToBase64url, utf8Decode, utf8Encode } from './base64url';
import { isAgeRecipient, isUnifiedAddress } from './addresses';
import { QUICKNET } from './drand';
import { firstReleaseLead, jitterMax } from './schedule';
import { isCurrency, QUOTE_LIMITS, TRIAL_MAX_SECS, type Quote } from './terms';
import { MAX_MONEY_ZAT, totalPrepaidZat } from './zat';

export const OFFER_PARAM = 'offer';
/** Generous for a JSON offer, small enough that a hostile link can't bloat memory. */
export const MAX_FRAGMENT_CHARS = 8192;

export const LIMITS = {
  nameMax: 80,
  countMin: 1,
  countMax: 60,
  periodMin: 10,
  periodMax: 366 * 86400,
} as const;

// C0/C1 controls, zero-width and bidi override/isolate characters.
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const UNSAFE_RANGES: Array<[number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];
const UNSAFE_TEXT = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`);
const OFFER_ID = /^off_[A-Za-z0-9_-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface OfferProblem {
  field: keyof Offer | 'fragment';
  message: string;
}

export type OfferParse = { ok: true; offer: Offer } | { ok: false; problems: OfferProblem[] };

function isInt(n: unknown, min: number, max: number): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
}

function endpointProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a URL';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a URL';
  }
  const onion = url.hostname.endsWith('.onion');
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && (onion || url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return null;
  return 'must be https, or http to a .onion service';
}

/** Validates an untrusted object as an Offer, returning a clean copy with known fields only. */
export function validateOffer(x: unknown): OfferParse {
  const problems: OfferProblem[] = [];
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    return { ok: false, problems: [{ field: 'fragment', message: 'the offer is not a JSON object' }] };
  }
  const o = x as Record<string, unknown>;

  if (typeof o.offer_id !== 'string' || !OFFER_ID.test(o.offer_id)) problems.push({ field: 'offer_id', message: 'is not an offer id (off_…)' });

  if (typeof o.name !== 'string' || o.name.trim().length === 0) problems.push({ field: 'name', message: 'is missing' });
  else if (o.name.length > LIMITS.nameMax) problems.push({ field: 'name', message: `is longer than ${LIMITS.nameMax} characters` });
  else if (UNSAFE_TEXT.test(o.name)) problems.push({ field: 'name', message: 'contains control or text-direction characters' });

  if (!isInt(o.amount_zat, 1, MAX_MONEY_ZAT)) problems.push({ field: 'amount_zat', message: 'must be a whole number of zatoshis above 0' });
  if (!isInt(o.period_secs, LIMITS.periodMin, LIMITS.periodMax)) problems.push({ field: 'period_secs', message: `must be between ${LIMITS.periodMin} s and 366 days` });
  if (!isInt(o.count, LIMITS.countMin, LIMITS.countMax)) problems.push({ field: 'count', message: `must be between ${LIMITS.countMin} and ${LIMITS.countMax}` });

  const network = o.network;
  if (network !== 'main' && network !== 'test') problems.push({ field: 'network', message: 'must be "main" or "test"' });

  if (typeof o.merchant_ua !== 'string') problems.push({ field: 'merchant_ua', message: 'is missing' });
  else if (network === 'main' || network === 'test') {
    if (!isUnifiedAddress(o.merchant_ua, network)) problems.push({ field: 'merchant_ua', message: `is not a ${network === 'main' ? 'mainnet' : 'testnet'} unified address` });
  }

  if (typeof o.runner_age_recipient !== 'string' || !isAgeRecipient(o.runner_age_recipient)) {
    problems.push({ field: 'runner_age_recipient', message: 'is not an age recipient (age1…)' });
  }
  const ep = endpointProblem(o.runner_endpoint);
  if (ep) problems.push({ field: 'runner_endpoint', message: ep });

  if (typeof o.drand_chain !== 'string' || !HEX64.test(o.drand_chain)) problems.push({ field: 'drand_chain', message: 'is not a drand chain hash' });
  else if (o.drand_chain !== QUICKNET.hash) problems.push({ field: 'drand_chain', message: 'is not drand quicknet, the only chain this app can time-lock to' });

  // Optional (contract v2): an older runner's links carry neither.
  // A runner sends a number or nothing; anything else, null included, is a bad link.
  const trial = o.trial_secs === undefined ? 0 : o.trial_secs;
  if (!isInt(trial, 0, TRIAL_MAX_SECS)) problems.push({ field: 'trial_secs', message: 'must be a whole number of seconds from 0 to 30 days' });
  const quote = o.quote ?? null;
  if (quote !== null && !isQuote(quote)) {
    problems.push({ field: 'quote', message: 'must be a currency code, a price and a rate in minor units, and a time' });
  }

  if (problems.length === 0 && totalPrepaidZat(o.amount_zat as number, o.count as number) > MAX_MONEY_ZAT) {
    problems.push({ field: 'amount_zat', message: 'times the count exceeds the 21M ZEC supply' });
  }
  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    offer: {
      offer_id: o.offer_id as string,
      name: (o.name as string).trim(),
      amount_zat: o.amount_zat as number,
      period_secs: o.period_secs as number,
      count: o.count as number,
      merchant_ua: o.merchant_ua as string,
      runner_age_recipient: o.runner_age_recipient as string,
      runner_endpoint: o.runner_endpoint as string,
      network: network as Offer['network'],
      drand_chain: o.drand_chain as string,
      ...(trial ? { trial_secs: trial as number } : {}),
      ...(quote ? { quote: orderedQuote(quote as Quote) } : {}),
    },
  };
}

function isQuote(q: unknown): q is Quote {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
  const v = q as Record<string, unknown>;
  return (
    typeof v.currency === 'string' &&
    isCurrency(v.currency) &&
    isInt(v.amount_minor, 1, QUOTE_LIMITS.amountMinorMax) &&
    isInt(v.zec_rate_minor, 1, QUOTE_LIMITS.rateMinorMax) &&
    isInt(v.set_at, 0, Number.MAX_SAFE_INTEGER)
  );
}

/** Known fields only, in a fixed order. */
function orderedQuote(q: Quote): Quote {
  return { currency: q.currency, amount_minor: q.amount_minor, zec_rate_minor: q.zec_rate_minor, set_at: q.set_at };
}

/**
 * How far after signing the last installment may fall due. Each installment is sealed
 * as a ladder with one rung per candidate height, and the ladder grows with how far out
 * the payment is: past about 53 days it no longer fits the sealed package's 64 MiB
 * plaintext cap (crates/cadence-seal/src/seal.rs), and signing fails after the payer
 * has paid. So the app refuses, before any pocket or QR, a plan that reaches past this.
 */
export const MAX_HORIZON_DAYS = 45;
const MAX_HORIZON_SECS = MAX_HORIZON_DAYS * 86400;

/**
 * Seconds from signing to the latest the last installment can fall due: any trial, the
 * first release's lead, count - 1 periods, and the most jitter the signer can draw.
 */
export function lastReleaseAfter(offer: Pick<Offer, 'period_secs' | 'count' | 'trial_secs'>): number {
  return (offer.trial_secs ?? 0) + firstReleaseLead(offer.period_secs) + (offer.count - 1) * offer.period_secs + jitterMax(offer.period_secs);
}

/** The most installments a plan with this period, after this trial, can have and still end within the horizon (at least 1). */
export function maxCountWithinHorizon(periodSecs: number, trialSecs = 0): number {
  const room = MAX_HORIZON_SECS - trialSecs - firstReleaseLead(periodSecs) - jitterMax(periodSecs);
  return Math.max(1, Math.floor(room / periodSecs) + 1);
}

/** Why Cadence cannot sign this plan yet (its last installment is too far out), or null. */
export function horizonProblem(offer: Pick<Offer, 'period_secs' | 'count' | 'trial_secs'>): string | null {
  const after = lastReleaseAfter(offer);
  if (after <= MAX_HORIZON_SECS) return null;
  const days = after / 86400;
  const when = days < MAX_HORIZON_DAYS + 1 ? `just over ${MAX_HORIZON_DAYS}` : `about ${Math.round(days)}`;
  return `Cadence cannot yet seal a payment due more than ${MAX_HORIZON_DAYS} days after signing, and this plan's last installment falls due ${when} days after you would sign. Ask the merchant for a shorter plan: fewer installments, or a shorter period.`;
}

/**
 * The base64url payload for `#offer=`. Field order is fixed so links are stable. A trial of 0
 * and an absent quote are left out, so an offer without them encodes as an older runner's does:
 * the payer's check compares this encoding of the link's offer with the runner's copy.
 */
export function encodeOfferPayload(offer: Offer): string {
  const ordered: Offer = {
    offer_id: offer.offer_id,
    name: offer.name,
    amount_zat: offer.amount_zat,
    period_secs: offer.period_secs,
    count: offer.count,
    merchant_ua: offer.merchant_ua,
    runner_age_recipient: offer.runner_age_recipient,
    runner_endpoint: offer.runner_endpoint,
    network: offer.network,
    drand_chain: offer.drand_chain,
    // Only a real trial: a link without one, and a runner's copy with a trial of 0, match.
    ...(offer.trial_secs ? { trial_secs: offer.trial_secs } : {}),
    ...(offer.quote ? { quote: orderedQuote(offer.quote) } : {}),
  };
  return bytesToBase64url(utf8Encode(JSON.stringify(ordered)));
}

export function buildShareUrl(appOrigin: string, offer: Offer): string {
  return `${appOrigin.replace(/\/+$/, '')}/subscribe#${OFFER_PARAM}=${encodeOfferPayload(offer)}`;
}

/** Parses `location.hash` (with or without the leading `#`). */
export function parseOfferFragment(hash: string): OfferParse {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return { ok: false, problems: [{ field: 'fragment', message: 'this link carries no offer' }] };
  if (raw.length > MAX_FRAGMENT_CHARS) return { ok: false, problems: [{ field: 'fragment', message: 'the link is too long to be an offer' }] };

  const params = new URLSearchParams(raw);
  const values = params.getAll(OFFER_PARAM);
  if (values.length === 0) return { ok: false, problems: [{ field: 'fragment', message: 'this link carries no offer' }] };
  if (values.length > 1) return { ok: false, problems: [{ field: 'fragment', message: 'the link carries more than one offer' }] };

  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(base64urlToBytes(values[0]!)));
  } catch {
    return { ok: false, problems: [{ field: 'fragment', message: 'the offer in this link is damaged (not base64url JSON)' }] };
  }
  return validateOffer(json);
}
