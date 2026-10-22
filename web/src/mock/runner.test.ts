import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { firstRoundAtOrAfter, QUICKNET, roundTime } from '../lib/drand';
import { seededBech32 } from '../lib/prng';
import { cadenceChecks } from '../lib/shape';
import { MockChain, MOCK_BLOCK_SECS } from './chain';
import { deriveSubscription, MockRunner, type MockSubRecord } from './runner';

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
    // Replay after cancel: double-spend.
    const tCancel = roundTime(rec.installments[1]!.release_round) + 30;
    chain.send({ kind: 'cancel', to: 'refund', value_zat: 1, spends_pocket: rec.pocket_ufvk }, tCancel);
    setNow(tCancel + 30);
    const replay = runner.cheat({ subscription_id: 'sub_t', kind: 'replay_after_cancel', k: 3 });
    expect(replay.stage).toBe('double-spend');
    expect(replay.log[0]).toBe('installment 3: its input was spent elsewhere; mandate cancelled');
  });
});
