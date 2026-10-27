import { describe, expect, it } from 'vitest';
import { certify, installmentRange, voidInstallments } from './certificate';

const receipt = { txid: 'cc'.repeat(32), refunded_zat: 190_000, fee_zat: 10_000, target_height: 1001, spent: 'the change from installment 1', spent_k: 1, spent_nullifier: 'ab'.repeat(32) };
const plan = { network: 'test' as const, subscription_id: 'sub_t', count: 3, runner: 'sandbox-production-1e16.up.railway.app' };

describe('cancellation certificate', () => {
  it('voids every installment after the spent note', () => {
    expect(voidInstallments(1, 3)).toEqual([2, 3]);
    expect(voidInstallments(0, 2)).toEqual([1, 2]);
    expect(voidInstallments(3, 3)).toEqual([]);
    expect(installmentRange([2, 3])).toBe('2 and 3');
    expect(installmentRange([2, 3, 4, 5])).toBe('2 to 5');
  });

  it('waits until the cancel is mined and reveals the spent nullifier', () => {
    expect(certify(receipt, { mined_height: null, ironwood_nullifiers: ['ab'.repeat(32)] }, plan, 9)).toBeNull();
    expect(certify(receipt, { mined_height: 1002, ironwood_nullifiers: ['ee'.repeat(32)] }, plan, 9)).toBeNull();
    const c = certify(receipt, { mined_height: 1002, ironwood_nullifiers: ['ee'.repeat(32), 'ab'.repeat(32)] }, plan, 9);
    expect(c).toMatchObject({ cancel_txid: 'cc'.repeat(32), mined_height: 1002, spent_k: 1, void_installments: [2, 3], returned_zat: 190_000 });
    // It says whose report it rests on.
    expect(c?.reported_by).toBe('sandbox-production-1e16.up.railway.app');
  });

  it('needs the spent note from the receipt', () => {
    expect(certify({ ...receipt, spent_nullifier: undefined }, { mined_height: 1002, ironwood_nullifiers: [] }, plan, 9)).toBeNull();
  });
});
