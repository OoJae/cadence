import { describe, expect, it } from 'vitest';
import { seededBech32 } from '../lib/prng';
import { merchantUaProblem, offerTerms, STOP_NEEDS_TOKEN, stopBlocked } from './Merchant';

const testUa = `utest1${seededBech32('m', 104)}`;
const mainUa = `u1${seededBech32('m', 104)}`;

describe("the merchant address follows the runner's network", () => {
  it('accepts a testnet address on a testnet runner and a mainnet one on a mainnet runner', () => {
    expect(merchantUaProblem(testUa, 'test')).toBeUndefined();
    expect(merchantUaProblem(mainUa, 'main')).toBeUndefined();
  });

  it('names the prefix the runner needs', () => {
    expect(merchantUaProblem('', 'main')).toBe('A mainnet unified address (u1…) with an Orchard receiver.');
    expect(merchantUaProblem('', 'test')).toBe('A testnet unified address (utest1…) with an Orchard receiver.');
    expect(merchantUaProblem(testUa, 'main')).toBe('A mainnet unified address (u1…) with an Orchard receiver. This is a testnet address, and this runner is on mainnet.');
    expect(merchantUaProblem(mainUa, 'test')).toBe('A testnet unified address (utest1…) with an Orchard receiver. This is a mainnet address, and this runner is on testnet.');
  });

  it('accepts nothing until the runner reports its network', () => {
    expect(merchantUaProblem(testUa, undefined)).toMatch(/Waiting for the runner/);
    expect(merchantUaProblem(mainUa, undefined)).toMatch(/Waiting for the runner/);
  });
});

describe('the Stop control', () => {
  it('needs a merchant token on a sandbox runner, which the demo does not hand out', () => {
    expect(stopBlocked({ sandbox: true }, '')).toBe('merchant token required (not available in the demo)');
    expect(stopBlocked({ sandbox: true }, '   ')).toBe(STOP_NEEDS_TOKEN);
    expect(stopBlocked({ sandbox: true }, 'secret')).toBeUndefined();
    // Elsewhere it is offered as before, and the runner answers.
    expect(stopBlocked({}, '')).toBeUndefined();
    expect(stopBlocked(undefined, '')).toBeUndefined();
  });
});

describe('the terms a new offer carries', () => {
  const quote = { currency: 'USD', amount_minor: 500, zec_rate_minor: 4210 };

  it('add nothing without a trial or a price label, so an older runner gets the request it always did', () => {
    expect(offerTerms(0, null, 1_793_170_000)).toEqual({});
  });

  it('send a trial and the quote, stamped when the merchant made it', () => {
    expect(offerTerms(7 * 86400, quote, 1_793_170_000.9)).toEqual({ trial_secs: 604_800, quote: { ...quote, set_at: 1_793_170_000 } });
    expect(offerTerms(3600, null, 0)).toEqual({ trial_secs: 3600 });
  });
});
