import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Installment, Subscription } from '../api/types';
import { totalPrepaidZat } from '../lib/zat';
import { FAUCET_RUNS, faucetLow, opensIn, pick } from './Sandbox';

const inst = (k: number, state: Installment['state']): Installment => ({ k, amount_zat: 100_000, release_round: 1000 + k, release_at: 1_800_000_000 + k * 300, state });
const sub = (status: Subscription['status'], states: Installment['state'][]): Subscription => ({
  subscription_id: 'sub_t',
  offer_id: 'off_t',
  status,
  created_at: 1_800_000_000,
  funding: { txid: 'aa'.repeat(32), mined_height: 100, amount_zat: 440_000 },
  installments: states.map((s, i) => inst(i + 1, s)),
});

describe('the sandbox faucet', () => {
  const prepay = totalPrepaidZat(100_000, 4);

  it(`is low below ${FAUCET_RUNS} prepayments of the chosen plan`, () => {
    expect(faucetLow({ faucet: { balance_zat: prepay * 3 - 1, notes: 4 } }, prepay)).toBe(true);
    expect(faucetLow({ faucet: { balance_zat: prepay * 3, notes: 4 } }, prepay)).toBe(false);
    // The public sandbox this morning: 0.0725 TAZ in 70 notes.
    expect(faucetLow({ faucet: { balance_zat: 7_250_000, notes: 70 } }, prepay)).toBe(false);
  });

  it('is never called low by a runner that reports no faucet (an older one, or the mock)', () => {
    expect(faucetLow({}, prepay)).toBe(false);
    expect(faucetLow(undefined, prepay)).toBe(false);
  });
});

describe('charge me after I cancel', () => {
  it("targets the first installment the cancel voided, once the runner reports the cancel", () => {
    expect(pick(sub('active', ['mined', 'mined', 'due', 'sealed']), 'charge_after_cancel')).toBeUndefined();
    expect(pick(sub('cancelled', ['mined', 'mined', 'cancelled', 'cancelled']), 'charge_after_cancel')?.k).toBe(3);
    expect(pick(sub('completed', ['mined', 'mined']), 'charge_after_cancel')).toBeUndefined();
    expect(pick(undefined, 'charge_after_cancel')).toBeUndefined();
  });

  it("reads the runner's countdown from its 409, and nothing else", () => {
    expect(opensIn(new ApiError(409, 'installment 3 opens in 41 s'))).toBe(41);
    expect(opensIn(new ApiError(409, 'installment 3 opens in 0 s'))).toBe(0);
    expect(opensIn(new ApiError(409, 'installment 3 was not voided by a cancel'))).toBeNull();
    expect(opensIn(new ApiError(400, 'installment 3 opens in 41 s'))).toBeNull();
    expect(opensIn(new Error('installment 3 opens in 41 s'))).toBeNull();
  });
});
