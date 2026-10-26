import { describe, expect, it } from 'vitest';
import type { Installment, Subscription } from '../api/types';
import {
  fragmentNamesSubscription,
  installmentNote,
  MISSED_NOTE,
  nextDue,
  nu7Crossing,
  paidOf,
  PRE_NU7_BLOCK_SECS,
  subscriptionIdFromFragment,
} from './planStatus';
import { INSTALLMENT_STATES } from './states';

const NU7 = 3_543_405;

const inst = (k: number, state: Installment['state'], extra: Partial<Installment> = {}): Installment => ({
  k,
  amount_zat: 100_000,
  release_round: 1000 + k,
  release_at: 1_800_000_000 + k * 3600,
  state,
  ...extra,
});

const sub = (installments: Installment[], extra: Partial<Subscription> = {}): Subscription => ({
  subscription_id: 'sub_0123456789abcdef0123',
  offer_id: 'off_x',
  status: 'active',
  created_at: 0,
  funding: { txid: 'f'.repeat(64), mined_height: NU7 - 500, amount_zat: 330_000 },
  installments,
  ...extra,
});

describe('the #sub= fragment', () => {
  it('reads a runner subscription id', () => {
    expect(subscriptionIdFromFragment('#sub=sub_0123456789abcdef0123')).toBe('sub_0123456789abcdef0123');
    expect(subscriptionIdFromFragment('#sub=sub_s2testnet&x=1')).toBe('sub_s2testnet');
  });

  it('refuses anything that is not one', () => {
    expect(subscriptionIdFromFragment('')).toBeNull();
    expect(subscriptionIdFromFragment('#main')).toBeNull();
    expect(subscriptionIdFromFragment('#sub=')).toBeNull();
    expect(subscriptionIdFromFragment('#sub=off_123')).toBeNull();
    expect(subscriptionIdFromFragment('#sub=sub_../../api')).toBeNull();
    expect(subscriptionIdFromFragment(`#sub=sub_${'a'.repeat(77)}`)).toBeNull();
    expect(fragmentNamesSubscription('#sub=off_123')).toBe(true);
    expect(fragmentNamesSubscription('#main')).toBe(false);
  });
});

describe('progress and the next installment', () => {
  it('counts only mined installments as paid', () => {
    const s = sub([inst(1, 'mined', { mined_height: 10 }), inst(2, 'broadcast'), inst(3, 'sealed')]);
    expect(paidOf(s)).toEqual({ paid: 1, total: 3 });
  });

  it('is the first installment by k still to come, on an active subscription only', () => {
    const s = sub([inst(3, 'sealed'), inst(1, 'mined'), inst(2, 'due')]);
    expect(nextDue(s)?.k).toBe(2);
    expect(nextDue(sub([inst(1, 'mined'), inst(2, 'sealed')]))?.k).toBe(2);
    expect(nextDue(sub([inst(1, 'mined'), inst(2, 'mined')], { status: 'completed' }))).toBeNull();
    // A stalled subscription pays nothing further, even with sealed installments left.
    expect(nextDue(sub([inst(1, 'missed'), inst(2, 'sealed')], { status: 'stalled' }))).toBeNull();
    expect(nextDue(sub([inst(1, 'mined'), inst(2, 'cancelled')], { status: 'stopped' }))).toBeNull();
  });
});

describe('installment notes', () => {
  it('names the drand round and its trust assumption, never that nobody can open it', () => {
    expect(installmentNote(inst(1, 'sealed', { release_round: 12_345_678 }))).toBe("Opens at drand round 12,345,678 (the drand network's threshold assumption).");
    for (const state of INSTALLMENT_STATES) expect(installmentNote(inst(1, state))).not.toMatch(/nobody|no one|cannot be opened/i);
  });

  it('does not promise a release once the subscription has stopped paying', () => {
    expect(installmentNote(inst(4, 'sealed', { release_round: 33_440_966 }), 'stalled')).toBe(
      "Sealed to drand round 33,440,966 (the drand network's threshold assumption), but the subscription is stalled: the runner releases nothing further.",
    );
  });

  it('says a missed installment paid nothing and the funds can be swept', () => {
    expect(MISSED_NOTE).toBe("Nothing was paid; the funds stay in the payer's pocket, recoverable with cadence sweep.");
    expect(installmentNote(inst(2, 'missed'))).toContain(MISSED_NOTE);
    expect(installmentNote(inst(2, 'invalid'))).toContain(MISSED_NOTE);
  });

  it('reports heights only when the runner gave them', () => {
    expect(installmentNote(inst(1, 'mined', { mined_height: 3_543_406 }))).toBe('Paid: mined at height 3,543,406.');
    expect(installmentNote(inst(1, 'broadcast', { target_height: 3_543_405 }))).toBe('Broadcast for target height 3,543,405, not mined yet.');
    expect(installmentNote(inst(1, 'broadcast'))).toBe('Broadcast, not mined yet.');
    expect(installmentNote(inst(1, 'cancelled'))).toMatch(/pocket note it spends is gone/);
  });
});

describe('crossing NU7 (mainnet 3,543,405)', () => {
  it('marks the first installment mined at or after NU7', () => {
    const s = sub([
      inst(1, 'mined', { target_height: NU7 - 40, mined_height: NU7 - 39 }),
      inst(2, 'mined', { target_height: NU7, mined_height: NU7 }),
      inst(3, 'mined', { target_height: NU7 + 300, mined_height: NU7 + 301 }),
    ]);
    expect(nu7Crossing(s, 'main', NU7 + 400)).toEqual({ kind: 'crossed', nu7: NU7, k: 2, minedHeight: NU7 });
  });

  it('counts a funding mined before NU7 as the side before it', () => {
    const s = sub([inst(1, 'mined', { mined_height: NU7 + 5 }), inst(2, 'sealed')]);
    expect(nu7Crossing(s, 'main', NU7 + 10)).toMatchObject({ kind: 'crossed', k: 1 });
  });

  it('shows nothing for a mandate entirely after NU7, or one the runner has forgotten the funding of', () => {
    const after = sub([inst(1, 'mined', { mined_height: NU7 + 5 })], { funding: { txid: 'f'.repeat(64), mined_height: NU7 + 1, amount_zat: 110_000 } });
    expect(nu7Crossing(after, 'main', NU7 + 10)).toEqual({ kind: 'none' });
    const forgotten = sub([inst(1, 'mined', { mined_height: NU7 + 5 })], { status: 'completed', funding: null as unknown as Subscription['funding'] });
    expect(nu7Crossing(forgotten, 'main', NU7 + 10)).toEqual({ kind: 'none' });
  });

  it('says NU7 is ahead while the tip is before it and installments are to come', () => {
    const s = sub([inst(1, 'mined', { mined_height: NU7 - 200 }), inst(2, 'sealed')]);
    expect(nu7Crossing(s, 'main', NU7 - 100)).toEqual({ kind: 'ahead', nu7: NU7, tip: NU7 - 100, blocks: 100, etaSecs: 100 * PRE_NU7_BLOCK_SECS });
    // Nothing left to come, or nothing further pays: no note.
    expect(nu7Crossing(sub([inst(1, 'mined', { mined_height: NU7 - 200 })], { status: 'completed' }), 'main', NU7 - 100)).toEqual({ kind: 'none' });
    expect(nu7Crossing(sub([inst(1, 'missed'), inst(2, 'sealed')], { status: 'stalled' }), 'main', NU7 - 100)).toEqual({ kind: 'none' });
    expect(nu7Crossing(s, 'main', undefined)).toEqual({ kind: 'none' });
  });

  it('never applies on testnet, which is past NU7', () => {
    const s = sub([inst(1, 'mined', { mined_height: NU7 - 39 }), inst(2, 'mined', { mined_height: NU7 + 1 })]);
    expect(nu7Crossing(s, 'test', 4_600_000)).toEqual({ kind: 'none' });
    expect(nu7Crossing(s, undefined, undefined)).toEqual({ kind: 'none' });
  });
});
