import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { firstRoundAtOrAfter, QUICKNET, roundTime } from '../lib/drand';
import { seededBech32 } from '../lib/prng';
import { planSchedule } from '../lib/schedule';
import { cadenceChecks } from '../lib/shape';
import { MockChain, MOCK_BLOCK_SECS } from './chain';
import { deriveSubscription, MockRunner, scheduleProblem, type MockSubRecord } from './runner';

const T0 = 1_800_000_000;

function setup(count = 3, period = 30) {
  const chain = new MockChain(T0, 5_000_000);
  let now = T0;
  const runner = new MockRunner(chain, () => now, 'https://app.example');
  const offer: Offer = {
    offer_id: 'off_t',
    name: 't',
    amount_zat: 100_000,
    period_secs: period,
    count,
    merchant_ua: `utest1${seededBech32('m', 104)}`,
    runner_age_recipient: runner.ageRecipient,
    runner_endpoint: 'https://app.example',
    network: 'test',
    drand_chain: QUICKNET.hash,
  };
  const funding = chain.send({ kind: 'wallet', to: 'pocket', value_zat: 330_000 }, T0);
  const rec: MockSubRecord = {
    subscription_id: 'sub_t',
    offer,
    created_at: T0,
    funding: { txid: funding.txid, mined_height: funding.mined_height, amount_zat: 330_000 },
    pocket_ufvk: 'uviewtest1pocket',
    installments: Array.from({ length: count }, (_, i) => ({
      k: i + 1,
      amount_zat: 100_000,
      release_round: firstRoundAtOrAfter(T0 + 20 + i * period),
      window: null,
      late: 0,
    })),
  };
  runner.addRecord(rec);
  const at = (t: number) => {
    now = t;
    return deriveSubscription(rec, chain, t).subscription;
  };
  return { chain, runner, rec, at, setNow: (t: number) => (now = t) };
}

describe('mock runner state derivation', () => {
  it('walks sealed → due → broadcast → mined', () => {
    const { at, rec } = setup();
    const r1 = roundTime(rec.installments[0]!.release_round);
    expect(at(T0).installments[0]!.state).toBe('sealed');
    expect(at(r1 + 1).installments[0]!.state).toBe('due');
    const seen = new Set<string>();
    for (let t = r1; t < r1 + 60; t++) seen.add(at(t).installments[0]!.state);
    expect([...seen]).toEqual(['due', 'broadcast', 'mined']);
  });

  it('chains installments: each waits for its parent to be three blocks deep', () => {
    const { at } = setup();
    const done = at(T0 + 600);
    expect(done.status).toBe('completed');
    const [a, b, c] = done.installments;
    expect(b!.target_height! - 3).toBeGreaterThanOrEqual(a!.mined_height!);
    expect(c!.target_height! - 3).toBeGreaterThanOrEqual(b!.mined_height!);
  });

  it('anchors at target − 3 and keeps the stock shape', () => {
    const { at, runner } = setup();
    const inst = at(T0 + 600).installments[0]!;
    const shape = runner.decode(inst.txid!);
    expect(shape.expiry_height).toBe(inst.target_height! + 120);
    expect(cadenceChecks(shape).every((c) => c.pass)).toBe(true);
  });

  it('cancels every installment not yet broadcast once the payer spends the pocket', () => {
    const { at, chain, rec } = setup(4, 60);
    const r2 = roundTime(rec.installments[1]!.release_round);
    const tCancel = r2 + 30;
    chain.send({ kind: 'cancel', to: 'refund', value_zat: 1, spends_pocket: rec.pocket_ufvk }, tCancel);
    const later = at(tCancel + 10 * MOCK_BLOCK_SECS);
    expect(later.installments.map((i) => i.state)).toEqual(['mined', 'mined', 'cancelled', 'cancelled']);
    expect(later.status).toBe('cancelled');
  });

  it('marks an installment missed when no rung covers the height, and stalls', () => {
    const { at, rec } = setup();
    rec.installments[1]!.window = [1, 2];
    const s = at(T0 + 600);
    expect(s.installments.map((i) => i.state)).toEqual(['mined', 'missed', 'missed']);
    expect(s.status).toBe('stalled');
  });

  it('stops when the merchant stops', () => {
    const { at, runner, setNow, rec } = setup();
    setNow(roundTime(rec.installments[0]!.release_round) + 30);
    runner.stop('sub_t', 'token');
    const s = at(T0 + 600);
    expect(s.installments[0]!.state).toBe('mined');
    expect(s.installments.slice(1).map((i) => i.state)).toEqual(['cancelled', 'cancelled']);
    expect(s.status).toBe('stopped');
  });

  it('requires a bearer token for merchant endpoints', () => {
    const { runner } = setup();
    expect(() => runner.stop('sub_t', undefined)).toThrow(/bearer/);
    expect(() => runner.createOffer({}, undefined)).toThrow(/bearer/);
  });

  it('cheats fail at the right defence', () => {
    const { runner, setNow, rec, chain } = setup(4, 60);
    // Installment 3 is still sealed: tlock.
    const early = runner.cheat({ subscription_id: 'sub_t', kind: 'open_early', k: 3 });
    expect(early.stage).toBe('tlock');
    expect(early.log.at(-1)).toBe('age: No matching keys found');
    // Installment 1 opened: tampering breaks the signature.
    setNow(roundTime(rec.installments[0]!.release_round) + 60);
    expect(runner.cheat({ subscription_id: 'sub_t', kind: 'tamper_amount', k: 1 }).stage).toBe('signature');
    // A stretched plan: the schedule check.
    expect(runner.cheat({ subscription_id: 'sub_t', kind: 'stretch_schedule', k: 2 }).stage).toBe('schedule');
    // Rebroadcasting a paid installment, before any cancel: double-spend.
    expect(runner.cheat({ subscription_id: 'sub_t', kind: 'rebroadcast', k: 1 }).stage).toBe('double-spend');
    // It still fails the same way after a cancel.
    const tCancel = roundTime(rec.installments[1]!.release_round) + 30;
    chain.send({ kind: 'cancel', to: 'refund', value_zat: 1, spends_pocket: rec.pocket_ufvk }, tCancel);
    setNow(tCancel + 30);
    expect(runner.cheat({ subscription_id: 'sub_t', kind: 'rebroadcast', k: 2 }).stage).toBe('double-spend');
  });

  it('rebroadcasts the latest paid installment, and only once one is paid', () => {
    const { runner, setNow, rec } = setup(4, 60);
    const before = runner.cheat({ subscription_id: 'sub_t', kind: 'rebroadcast', k: 1 });
    expect(before).toEqual({ kind: 'rebroadcast', k: 1, outcome: 'not_applicable', stage: null, log: ['no installment has been released yet'] });

    setNow(roundTime(rec.installments[1]!.release_round) + 60);
    const sub = runner.getSubscription('sub_t');
    expect(sub.status).toBe('active');
    const paid = [...sub.installments].reverse().find((i) => i.state === 'mined')!;
    const res = runner.cheat({ subscription_id: 'sub_t', kind: 'rebroadcast', k: paid.k });
    expect(res).toMatchObject({ kind: 'rebroadcast', k: paid.k, outcome: 'rejected', stage: 'double-spend' });
    expect(res.log[0]).toBe(`runner: broadcasting installment ${paid.k} again (${paid.txid!.slice(0, 16)}…), whose pocket note is already spent`);
    expect(res.log.at(-1)).toMatch(/^node: transaction rejected: Ironwood double-spend: nullifier .* already revealed by .* at height \d+$/);
    // The old name is an alias, answered under the new one.
    // The old name still works and, like the real runner, is echoed back.
    expect(runner.cheat({ subscription_id: 'sub_t', kind: 'replay_after_cancel', k: paid.k })).toEqual({ ...res, kind: 'replay_after_cancel' });
    expect(() => runner.cheat({ subscription_id: 'sub_t', kind: 'replay', k: 1 })).toThrow(/unknown cheat/);
  });

  it('refuses a stretched plan at the schedule check, at any time', () => {
    const { runner, rec } = setup(4, 60);
    const res = runner.cheat({ subscription_id: 'sub_t', kind: 'stretch_schedule', k: 2 });
    expect(res).toMatchObject({ kind: 'stretch_schedule', k: 2, outcome: 'rejected', stage: 'schedule' });
    expect(res.log.at(-1)).toBe(`runner: subscription refused: installment 2 releases ${(365 * 86_400 + 60).toLocaleString('en-US')} s after installment 1, but the offer's period is 60 s`);
    expect(res.log[0]).toContain(`instead of round ${rec.installments[1]!.release_round}, a year late`);
    // The stored schedule is untouched.
    expect(rec.installments[1]!.release_round - rec.installments[0]!.release_round).toBe(60 / QUICKNET.period);
    expect(runner.cheat({ subscription_id: 'sub_t', kind: 'stretch_schedule', k: 1 }).outcome).toBe('not_applicable');
  });
});

describe('mock runner schedule check', () => {
  const offer = { count: 3, period_secs: 30 };
  const plan = (gaps: number[], first = firstRoundAtOrAfter(T0)) => {
    const out = [{ k: 1, release_round: first }];
    for (const g of gaps) out.push({ k: out.length + 1, release_round: out.at(-1)!.release_round + g });
    return out;
  };

  it("accepts the signer's own schedules, rounded up to whole rounds", () => {
    for (const period of [20, 30, 31, 45, 3600]) {
      for (let t = T0; t < T0 + 6; t++) {
        const p = { amount_zat: 1, period_secs: period, count: 4 };
        expect(scheduleProblem(p, planSchedule(p, t))).toBeNull();
      }
    }
    expect(scheduleProblem(offer, plan([10, 10]))).toBeNull();
  });

  it('refuses a schedule that does not follow the offer', () => {
    expect(scheduleProblem(offer, plan([10, 12]))).toMatch(/installment 3 releases 36 s after installment 2, but the offer's period is 30 s/);
    expect(scheduleProblem(offer, plan([10, 8]))).toMatch(/installment 3 releases 24 s/);
    expect(scheduleProblem(offer, plan([10, 0]))).toBe('release rounds must increase');
    expect(scheduleProblem(offer, plan([10]))).toBe('expected 3 installments, got 2');
    expect(scheduleProblem(offer, plan([10, 10]).map((i) => ({ ...i, k: 4 - i.k })))).toMatch(/numbered/);
  });

  it('refuses a stretched upload', () => {
    const { runner, chain, rec } = setup(3, 30);
    const funding = chain.send({ kind: 'wallet', to: 'pocket2', value_zat: 330_000 }, T0);
    const body = (rounds: number[]) => ({
      offer_id: rec.offer.offer_id,
      pocket_ufvk: `uviewtest1${seededBech32('p2', 189)}`,
      birthday_height: 5_000_000,
      funding_txid: funding.txid,
      installments: rounds.map((release_round, i) => ({ k: i + 1, release_round, sealed: 'x'.repeat(64) })),
    });
    const honest = planSchedule(rec.offer, T0).map((i) => i.release_round);
    const stretched = honest.map((r, i) => (i >= 1 ? r + (365 * 86_400) / QUICKNET.period : r));
    expect(() => runner.createSubscription(body(stretched))).toThrow(/installment 2 releases .* the offer's period is 30 s/);
    expect(runner.createSubscription(body(honest)).status).toBe('active');
  });
});
