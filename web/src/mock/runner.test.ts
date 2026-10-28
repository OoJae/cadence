import { describe, expect, it } from 'vitest';
import type { Offer, PassPayload } from '../api/types';
import { base64urlToBytes } from '../lib/base64url';
import { firstRoundAtOrAfter, QUICKNET, roundTime } from '../lib/drand';
import { parsePass, verifyPassSignature } from '../lib/pass';
import { payerAuthFromSeed } from '../lib/payerAuth';
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

describe('mock runner v2 features', () => {
  it('lists the features it implements, so mock builds show them', () => {
    expect(setup().runner.status().features).toEqual(['trial', 'quote', 'payer_auth', 'pass', 'charge_after_cancel', 'fund_offer']);
  });

  it('charges after a cancel only once the voided package opens, and the node refuses it', () => {
    const { runner, setNow, rec, chain } = setup(4, 60);
    const cheat = () => runner.cheat({ subscription_id: 'sub_t', kind: 'charge_after_cancel', k: 3 });
    expect(cheat).toThrow(/installment 3 was not voided by a cancel/);
    const tCancel = roundTime(rec.installments[1]!.release_round) + 30;
    const cancel = chain.send({ kind: 'cancel', to: 'refund', value_zat: 1, spends_pocket: rec.pocket_ufvk }, tCancel);
    setNow(tCancel + 2 * MOCK_BLOCK_SECS);
    expect(runner.getSubscription('sub_t').installments[2]!.state).toBe('cancelled');
    const r3 = roundTime(rec.installments[2]!.release_round);
    const early = (() => {
      try {
        cheat();
      } catch (e) {
        return e as Error & { status: number };
      }
    })();
    expect(early).toMatchObject({ status: 409, message: `installment 3 opens in ${Math.ceil(r3 - (tCancel + 2 * MOCK_BLOCK_SECS))} s` });
    setNow(r3 + 1);
    const res = cheat();
    expect(res).toMatchObject({ kind: 'charge_after_cancel', k: 3, outcome: 'rejected', stage: 'node' });
    expect(res.log.at(-1)).toMatch(new RegExp(`^node: transaction rejected: Ironwood double-spend: .* by the cancel ${cancel.txid.slice(0, 12)}.* at height ${cancel.mined_height}$`));
  });

  it('stores a trial and a quote with an offer, and checks both', () => {
    const { runner } = setup();
    const base = { name: 'Plan', amount_zat: 11_876_485, period_secs: 86400, count: 2, merchant_ua: `utest1${seededBech32('m', 104)}` };
    const quote = { currency: 'USD', amount_minor: 500, zec_rate_minor: 4210, set_at: T0 };
    const termed = runner.getOffer(runner.createOffer({ ...base, trial_secs: 7 * 86400, quote }, 'token').offer_id);
    expect(termed).toMatchObject({ trial_secs: 604_800, quote });
    const plain = runner.getOffer(runner.createOffer(base, 'token').offer_id);
    expect(plain.trial_secs).toBe(0);
    expect(plain).not.toHaveProperty('quote');
    expect(() => runner.createOffer({ ...base, trial_secs: 30 * 86400 + 1 }, 'token')).toThrow(/trial_secs/);
    expect(() => runner.createOffer({ ...base, quote: { ...quote, currency: 'usd' } }, 'token')).toThrow(/quote/);
    expect(() => runner.createOffer({ ...base, quote: { ...quote, zec_rate_minor: 0 } }, 'token')).toThrow(/quote/);
  });

  it("funds a pocket with exactly an offer's prepay when told which offer", () => {
    const { runner, rec } = setup(4, 60);
    const ua = `utest1${seededBech32('p', 104)}`;
    expect(() => runner.fund({ ua, amount_zat: 440_001, offer_id: rec.offer.offer_id })).toThrow(/this offer's prepay, 440000 zats/);
    expect(() => runner.fund({ ua, amount_zat: 440_000, offer_id: 'off_nope' })).toThrow(/no such offer/);
    expect(runner.fund({ ua, amount_zat: 440_000, offer_id: rec.offer.offer_id }).txid).toMatch(/^[0-9a-f]{64}$/);
    // Without an offer, as an older page asks.
    expect(runner.fund({ ua, amount_zat: 123 }).txid).toMatch(/^[0-9a-f]{64}$/);
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

describe('mock runner access passes', () => {
  const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const PATH = '/api/subscriptions/sub_t/pass';
  const payload = (pass: string) => JSON.parse(new TextDecoder().decode(base64urlToBytes(pass.split('.')[0]!))) as PassPayload;

  async function signed(now: () => number) {
    const s = setup(3, 30);
    const auth = await payerAuthFromSeed(SEED, { now });
    s.rec.payer_auth_key = auth.publicKeyHex;
    s.setNow(now());
    return { ...s, auth, ask: async () => s.runner.issuePass('sub_t', await auth.sign('POST', PATH, '{}'), '{}', PATH) };
  }

  it('issues a pass to the payer, good until half a period past the next release', async () => {
    const { ask, rec, runner } = await signed(() => T0);
    const res = await ask();
    const p = payload(res.pass);
    expect(p).toEqual({ v: 1, iss: 'test', offer_id: 'off_t', sub: 'sub_t', paid: 0, valid_until: roundTime(rec.installments[0]!.release_round) + 15, iat: T0 });
    expect(Object.keys(p)).toEqual(['v', 'iss', 'offer_id', 'sub', 'paid', 'valid_until', 'iat']);
    expect(res.valid_until).toBe(p.valid_until);
    const parsed = parsePass(res.pass);
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(await verifyPassSignature((await runner.passKey()).public_key, parsed.payloadBytes, parsed.signature)).toBe(true);
    expect(await runner.verifyPass({ pass: res.pass })).toEqual({ valid: true, reason: null, offer_id: 'off_t', sub: 'sub_t', paid: 0, valid_until: p.valid_until });
  });

  it('counts mined installments and, once every one is mined, lasts a period and a half past the last release', async () => {
    let now = T0;
    const s = await signed(() => now);
    const lastRelease = roundTime(s.rec.installments[2]!.release_round);
    now = lastRelease + 40;
    s.setNow(now);
    expect(s.runner.getSubscription('sub_t').status).toBe('completed');
    const p = payload((await s.ask()).pass);
    expect(p.paid).toBe(3);
    expect(p.valid_until).toBe(lastRelease + 30 + 15);
    now = lastRelease + 46;
    s.setNow(now);
    await expect(s.ask()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a replay, a stale timestamp, another key and a subscription with no key, with 403', async () => {
    const s = await signed(() => T0);
    const headers = await s.auth.sign('POST', PATH, '{}');
    await s.runner.issuePass('sub_t', headers, '{}', PATH);
    await expect(s.runner.issuePass('sub_t', headers, '{}', PATH)).rejects.toMatchObject({ status: 403, message: 'this payer signature was already used' });

    const stale = await payerAuthFromSeed(SEED, { now: () => T0 - 301 });
    await expect(s.runner.issuePass('sub_t', await stale.sign('POST', PATH, '{}'), '{}', PATH)).rejects.toMatchObject({ status: 403, message: /300 s/ });

    const other = await payerAuthFromSeed(Uint8Array.from(SEED, (b) => b ^ 1), { now: () => T0 });
    await expect(s.runner.issuePass('sub_t', await other.sign('POST', PATH, '{}'), '{}', PATH)).rejects.toMatchObject({ status: 403, message: /does not verify/ });
    // A signature over another body does not stand for this one.
    await expect(s.runner.issuePass('sub_t', await s.auth.sign('POST', PATH, '{"x":1}'), '{}', PATH)).rejects.toMatchObject({ status: 403 });

    delete s.rec.payer_auth_key;
    await expect(s.ask()).rejects.toMatchObject({ status: 403, message: /no payer auth key/ });
  });

  it('refuses a cancelled or stalled subscription with 409', async () => {
    const s = await signed(() => T0);
    s.rec.installments[1]!.window = [1, 2];
    s.setNow(T0 + 600);
    const late = await payerAuthFromSeed(SEED, { now: () => T0 + 600 });
    await expect(s.runner.issuePass('sub_t', await late.sign('POST', PATH, '{}'), '{}', PATH)).rejects.toMatchObject({ status: 409, message: 'the subscription is stalled' });

    const c = await signed(() => T0);
    c.chain.send({ kind: 'cancel', to: 'refund', value_zat: 1, spends_pocket: c.rec.pocket_ufvk }, T0);
    c.setNow(T0 + 60);
    const after = await payerAuthFromSeed(SEED, { now: () => T0 + 60 });
    await expect(c.runner.issuePass('sub_t', await after.sign('POST', PATH, '{}'), '{}', PATH)).rejects.toMatchObject({ status: 409, message: 'the subscription is cancelled' });
  });

  it('verifies passes: expired, tampered and malformed ones are not valid', async () => {
    const s = await signed(() => T0);
    const { pass, valid_until } = await s.ask();
    s.setNow(valid_until + 1);
    expect(await s.runner.verifyPass({ pass })).toMatchObject({ valid: false, reason: 'expired', sub: 'sub_t' });
    const [body, sig] = pass.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload(pass), valid_until: valid_until + 86_400 })).toString('base64url');
    expect(await s.runner.verifyPass({ pass: `${forged}.${sig}` })).toEqual({ valid: false, reason: 'bad signature', offer_id: null, sub: null, paid: null, valid_until: null });
    expect(await s.runner.verifyPass({ pass: body! })).toMatchObject({ valid: false, reason: 'malformed pass' });
  });

  it('stores a payer auth key from the upload, and refuses one that is not 64 hex characters', async () => {
    const { runner, chain, rec } = setup(3, 30);
    const body = (n: string, key?: unknown) => ({
      offer_id: rec.offer.offer_id,
      pocket_ufvk: `uviewtest1${seededBech32(n, 189)}`,
      birthday_height: 5_000_000,
      funding_txid: chain.send({ kind: 'wallet', to: n, value_zat: 330_000 }, T0).txid,
      installments: planSchedule(rec.offer, T0).map((i) => ({ k: i.k, release_round: i.release_round, sealed: 'x'.repeat(64) })),
      ...(key === undefined ? {} : { payer_auth_key: key }),
    });
    expect(() => runner.createSubscription(body('p3', 'AB'.repeat(32)))).toThrow(/64 hex/);
    const id = runner.createSubscription(body('p4', 'ab'.repeat(32))).subscription_id;
    expect(runner.subs.get(id)!.payer_auth_key).toBe('ab'.repeat(32));
    const old = runner.createSubscription(body('p5')).subscription_id;
    expect(runner.subs.get(old)!.payer_auth_key).toBeUndefined();
    expect(runner.status().features).toEqual(expect.arrayContaining(['payer_auth', 'pass']));
  });
});
