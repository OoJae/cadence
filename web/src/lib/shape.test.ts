import { describe, expect, it } from 'vitest';
import type { Shape } from '../api/types';
import { S2_SHAPES } from '../data/s2';
import { STOCK_SEND_REFERENCE } from '../data/stockReference';
import {
  anchorMatchesStockRule,
  BRANCHES,
  branchAt,
  cadenceChecks,
  defaultExpiry,
  expiryDeltaFor,
  impliedTarget,
  installmentFeeAt,
  MAINNET_FEE_SWITCH,
  NU6_3_BRANCH_ID,
  NU7_ACTIVATION,
  NU7_BRANCH_ID,
  stockShapeAt,
  summarizeShape,
} from './shape';
import { INSTALLMENT_FEE_ZAT } from './zat';

/** A 2-action Ironwood installment as cadence-decode prints it: mined one block after its target, anchored at target − 3. */
function installment(branch: string, delta: number, target: number, fee: number): Shape {
  const expiry = target + delta;
  const mined = target + 1;
  return {
    txid: 'ab'.repeat(32),
    version: 'V6',
    branch_id: branch,
    lock_time: 0,
    expiry_height: expiry,
    mined_height: mined,
    expiry_minus_mined: expiry - mined,
    transparent_inputs: 0,
    transparent_outputs: 0,
    sapling_spends: 0,
    sapling_outputs: 0,
    orchard_actions: 0,
    ironwood_actions: 2,
    ironwood_flags: 7,
    ironwood_value_balance: fee,
    ironwood_anchor: 'cd'.repeat(32),
    anchor_heights: [target - 4, target - 2],
    anchor_depths: [3, 5],
    ironwood_proof_bytes: 7264,
    zero_ovk_recoverable: 0,
    supplied_ovk_recoverable: 0,
  };
}

const failing = (s: Shape, network: 'main' | 'test') =>
  cadenceChecks(s, network)
    .filter((c) => !c.pass)
    .map((c) => c.id);

describe('consensus rules by network and height', () => {
  it('names NU6.3 and NU7 and every branch from Overwinter on', () => {
    expect(BRANCHES[NU6_3_BRANCH_ID]).toBe('NU6.3');
    expect(BRANCHES[NU7_BRANCH_ID]).toBe('NU7');
    expect(BRANCHES.c8e71055).toBe('NU6');
    expect(Object.keys(BRANCHES)).toHaveLength(11);
  });

  it('uses zcash_primitives default expiry deltas', () => {
    expect(expiryDeltaFor(NU7_BRANCH_ID)).toBe(120);
    expect(expiryDeltaFor(NU6_3_BRANCH_ID)).toBe(40);
    expect(expiryDeltaFor('c8e71055')).toBe(40);
    expect(expiryDeltaFor('76b809bb')).toBe(20);
    expect(expiryDeltaFor('deadbeef')).toBeNull();
  });

  it('switches branch at NU7: mainnet 3,543,405, testnet already past it', () => {
    expect(NU7_ACTIVATION.main).toBe(3_543_405);
    expect(branchAt('main', 3_543_404)).toBe(NU6_3_BRANCH_ID);
    expect(branchAt('main', 3_543_405)).toBe(NU7_BRANCH_ID);
    expect(branchAt('main', 3_428_142)).toBe('5437f330');
    expect(branchAt('test', 4_529_250)).toBe(NU7_BRANCH_ID);
    expect(branchAt('test', 4_465_025)).toBe(NU6_3_BRANCH_ID);
    expect(branchAt('main', 1_000_000)).toBeNull();
  });

  it('lowers the installment fee only on mainnet, from 3,590,000 (ZIP 2009)', () => {
    expect(MAINNET_FEE_SWITCH).toBe(3_590_000);
    expect(installmentFeeAt('main', 3_589_999)).toBe(INSTALLMENT_FEE_ZAT);
    expect(installmentFeeAt('main', 3_590_000)).toBe(2_000);
    expect(installmentFeeAt('test', 4_600_000)).toBe(INSTALLMENT_FEE_ZAT);
  });
});

describe('Cadence checks', () => {
  it('mainnet before NU7: NU6.3, target + 40, 10,000 zats', () => {
    const s = installment(NU6_3_BRANCH_ID, 40, 3_540_000, 10_000);
    expect(impliedTarget(s)).toBe(3_540_000);
    expect(failing(s, 'main')).toEqual([]);
    expect(cadenceChecks(s, 'main').find((c) => c.id === 'expiry')!.label).toBe('Default expiry delta (target + 40)');
    // Read with the NU7 delta, the same transaction would imply a target 80 blocks too early.
    expect(anchorMatchesStockRule({ ...s, branch_id: NU7_BRANCH_ID })).toBe(false);
  });

  it('mainnet before NU7: a 120-block expiry is not the NU6.3 default', () => {
    const s = installment(NU6_3_BRANCH_ID, 120, 3_540_000, 10_000);
    expect(defaultExpiry(s)).toBe(false);
    expect(failing(s, 'main')).toEqual(expect.arrayContaining(['expiry']));
  });

  it('mainnet after NU7, before the fee switch: NU7, target + 120, 10,000 zats', () => {
    const s = installment(NU7_BRANCH_ID, 120, 3_560_000, 10_000);
    expect(impliedTarget(s)).toBe(3_560_000);
    expect(failing(s, 'main')).toEqual([]);
    expect(cadenceChecks(s, 'main').find((c) => c.id === 'fee')!.label).toBe('ZIP 317 fee for 2 actions');
    expect(failing({ ...s, ironwood_value_balance: 2_000 }, 'main')).toEqual(['fee']);
  });

  it('mainnet after the fee switch: 2,000 zats, and 10,000 is wrong', () => {
    const s = installment(NU7_BRANCH_ID, 120, MAINNET_FEE_SWITCH, 2_000);
    expect(failing(s, 'main')).toEqual([]);
    const fee = cadenceChecks(s, 'main').find((c) => c.id === 'fee')!;
    expect(fee.label).toBe('ZIP 2009 fee for 2 actions');
    const wrong = cadenceChecks({ ...s, ironwood_value_balance: 10_000 }, 'main').find((c) => c.id === 'fee')!;
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toBe('10000 zats, expected 2000');
    // One block before the switch still pays the ZIP 317 fee.
    expect(failing(installment(NU7_BRANCH_ID, 120, MAINNET_FEE_SWITCH - 1, 10_000), 'main')).toEqual([]);
  });

  it('testnet: NU7, 10,000 zats at any height', () => {
    const s = installment(NU7_BRANCH_ID, 120, 4_600_000, 10_000);
    expect(failing(s, 'test')).toEqual([]);
    expect(failing({ ...s, ironwood_value_balance: 2_000 }, 'test')).toEqual(['fee']);
    // The default network is testnet, which the S2 evidence and the mock use.
    for (const e of S2_SHAPES) expect(failing(e, 'test')).toEqual([]);
    expect(cadenceChecks(S2_SHAPES[0]!)).toEqual(cadenceChecks(S2_SHAPES[0]!, 'test'));
  });

  it('reads a real runner’s unmined shape (nulls) without throwing', () => {
    const s = {
      ...installment(NU7_BRANCH_ID, 120, 3_560_000, 10_000),
      mined_height: null,
      expiry_minus_mined: null,
      anchor_heights: null,
      anchor_depths: null,
    } as unknown as Shape;
    const checks = cadenceChecks(s, 'main');
    expect(checks.find((c) => c.id === 'expiry')).toMatchObject({ pass: true, detail: 'not mined yet' });
    expect(checks.find((c) => c.id === 'anchor')).toMatchObject({ pass: true, detail: 'not mined yet' });
    expect(anchorMatchesStockRule(s)).toBe(false);
    // Mined, but the runner found no height with its anchor: a stale anchor fails.
    const stale = { ...installment(NU7_BRANCH_ID, 120, 3_560_000, 10_000), anchor_heights: null, anchor_depths: null } as unknown as Shape;
    expect(failing(stale, 'main')).toEqual(['anchor']);
  });

  it('fails an unknown branch instead of guessing its delta', () => {
    const s = installment('deadbeef', 120, 3_560_000, 10_000);
    expect(impliedTarget(s)).toBeNull();
    expect(failing(s, 'main')).toEqual(['fee', 'expiry', 'anchor']);
  });
});

describe('the stock send reference, moved to a target height', () => {
  it('stays the S2 profile on testnet', () => {
    const ref = STOCK_SEND_REFERENCE.shape;
    const t = impliedTarget(ref)!;
    expect(stockShapeAt(ref, 'test', t)).toEqual(ref);
  });

  it('follows the mainnet branch, expiry delta and fee', () => {
    const ref = STOCK_SEND_REFERENCE.shape;
    const pre = stockShapeAt(ref, 'main', 3_540_000);
    expect(pre).toMatchObject({ branch_id: NU6_3_BRANCH_ID, expiry_height: 3_540_040, ironwood_value_balance: 10_000 });
    expect(failing(pre, 'main')).toEqual([]);

    const post = stockShapeAt(ref, 'main', 3_600_000);
    expect(post).toMatchObject({ branch_id: NU7_BRANCH_ID, expiry_height: 3_600_120, ironwood_value_balance: 2_000 });
    expect(failing(post, 'main')).toEqual([]);

    // A mainnet installment and the reference at its target agree on every compared field.
    const inst = installment(NU6_3_BRANCH_ID, 40, 3_540_000, 10_000);
    expect([pre.branch_id, pre.ironwood_value_balance, defaultExpiry(pre), anchorMatchesStockRule(pre)]).toEqual([
      inst.branch_id,
      inst.ironwood_value_balance,
      defaultExpiry(inst),
      anchorMatchesStockRule(inst),
    ]);
  });
});

describe('shape summary', () => {
  it('names the branch, its delta and the fee', () => {
    expect(summarizeShape(installment(NU6_3_BRANCH_ID, 40, 3_540_000, 10_000), 'main')).toEqual({
      branch: 'NU6.3',
      delta: 40,
      fee: 10_000,
      actions: 2,
      passing: 11,
      total: 11,
    });
    const after = summarizeShape(installment(NU7_BRANCH_ID, 120, 3_600_000, 10_000), 'main');
    expect(after).toMatchObject({ branch: 'NU7', delta: 120, passing: 10 });
  });
});
