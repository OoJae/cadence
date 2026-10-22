import { describe, expect, it } from 'vitest';
import type { Installment, Subscription } from '../api/types';
import { transitionLines } from './runnerLog';
import { INSTALLMENT_STATE_INFO, INSTALLMENT_STATES, installmentStateInfo, isTerminal, SUBSCRIPTION_STATUS_INFO, subscriptionStatusInfo } from './states';

describe('installment state labels', () => {
  it('covers exactly the six states of docs/api.md', () => {
    expect([...INSTALLMENT_STATES].sort()).toEqual(['broadcast', 'cancelled', 'due', 'mined', 'missed', 'sealed']);
    expect(Object.keys(INSTALLMENT_STATE_INFO).sort()).toEqual([...INSTALLMENT_STATES].sort());
  });

  it('gives every state a distinct label, a tone and a description', () => {
    const labels = INSTALLMENT_STATES.map((s) => installmentStateInfo(s).label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(['Sealed', 'Due', 'Broadcast', 'Mined', 'Cancelled', 'Missed']);
    for (const s of INSTALLMENT_STATES) {
      expect(installmentStateInfo(s).description.length).toBeGreaterThan(10);
      expect(installmentStateInfo(s).tone).toBeTruthy();
    }
  });

  it('keeps the meanings from the API contract', () => {
    expect(installmentStateInfo('sealed').description).toMatch(/Not even the runner can read it/);
    expect(installmentStateInfo('due').description).toMatch(/anchor depth/);
    expect(installmentStateInfo('missed').description).toMatch(/re-sign/);
  });

  it('uses danger colour only for missed, success only for mined', () => {
    expect(installmentStateInfo('missed').tone).toBe('red');
    expect(installmentStateInfo('mined').tone).toBe('green');
    expect(INSTALLMENT_STATES.filter((s) => installmentStateInfo(s).tone === 'green')).toEqual(['mined']);
  });

  it('labels unknown states honestly instead of guessing', () => {
    expect(installmentStateInfo('exploded').label).toBe('Unknown (exploded)');
    expect(subscriptionStatusInfo('paused').label).toBe('Unknown (paused)');
  });

  it('labels the four subscription statuses', () => {
    expect(Object.keys(SUBSCRIPTION_STATUS_INFO).sort()).toEqual(['active', 'cancelled', 'completed', 'stalled']);
  });

  it('knows which states are terminal', () => {
    expect(INSTALLMENT_STATES.filter(isTerminal)).toEqual(['mined', 'cancelled', 'missed']);
  });
});

describe('runner log lines', () => {
  const sub = (installments: Installment[]): Subscription => ({
    subscription_id: 'sub_x',
    offer_id: 'off_x',
    status: 'active',
    created_at: 0,
    funding: { txid: 'f'.repeat(64), mined_height: 4529209, amount_zat: 330_000 },
    installments,
  });
  const base = { k: 1, amount_zat: 100_000, release_round: 100, release_at: 0 };

  it('prints the exact formats of crates/cadence-runner', () => {
    const due: Installment = { ...base, state: 'due' };
    expect(transitionLines('sealed', due, sub([due]))[0]!.text).toBe('installment 1: input mined at 4529209, waiting for anchor depth');

    const mined: Installment = { ...base, state: 'mined', txid: '7ae2'.padEnd(64, '0'), target_height: 4529247, mined_height: 4529248 };
    const lines = transitionLines('due', mined, sub([mined])).map((l) => l.text);
    expect(lines[0]).toBe(`installment 1: broadcast ${mined.txid} for target 4529247 (input mined at 4529209, anchor 4529244)`);
    expect(lines[1]).toBe(
      'installment 1: mined at 4529248: V6 branch 77190ad9, expiry 4529367 (expiry - mined = 119), transparent in/out 0/0, sapling false, orchard false, ironwood actions 2, fee 10000 zats',
    );

    const cancelled: Installment = { ...base, state: 'cancelled' };
    expect(transitionLines('sealed', cancelled, sub([cancelled]))[0]!.text).toBe('installment 1: its input was spent elsewhere; mandate cancelled');
  });

  it('prints nothing when the state did not change', () => {
    const s: Installment = { ...base, state: 'sealed' };
    expect(transitionLines('sealed', s, sub([s]))).toEqual([]);
  });
});
