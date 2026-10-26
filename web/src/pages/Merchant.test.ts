import { describe, expect, it } from 'vitest';
import { seededBech32 } from '../lib/prng';
import { merchantUaProblem } from './Merchant';

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
