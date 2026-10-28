import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { planEnded, subscribeAgainPath } from './again';
import { QUICKNET } from './drand';
import { buildShareUrl, parseOfferFragment } from './offer';
import { seededBech32 } from './prng';

const offer: Offer = {
  offer_id: 'off_again1',
  name: 'Shielded Press · monthly',
  amount_zat: 500_000,
  period_secs: 604_800,
  count: 4,
  merchant_ua: `utest1${seededBech32('m', 104)}`,
  runner_age_recipient: `age1${seededBech32('a', 58)}`,
  runner_endpoint: 'https://sandbox.example',
  network: 'test',
  drand_chain: QUICKNET.hash,
};

describe('subscribe again', () => {
  it('offers the same plan once nothing further pays', () => {
    for (const status of ['completed', 'cancelled', 'stopped', 'stalled'] as const) expect(planEnded({ status })).toBe(true);
    expect(planEnded({ status: 'active' })).toBe(false);
  });

  it("links to the offer's share link on this app, naming the offer's own runner", () => {
    const path = subscribeAgainPath(offer);
    const url = new URL(buildShareUrl('https://app.example', offer));
    expect(path).toBe(url.pathname + url.hash);
    const back = parseOfferFragment(new URL(path, 'https://app.example').hash);
    expect(back).toEqual({ ok: true, offer });
    expect(back.ok && back.offer.runner_endpoint).toBe('https://sandbox.example');
  });
});
