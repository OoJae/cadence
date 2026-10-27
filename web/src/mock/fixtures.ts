/**
 * Seed data for the mock runner, laid out relative to page-load time so countdowns
 * are live. One subscription carries the real S2 testnet txids; the rest are
 * synthetic and say so in the dashboard.
 */
import type { Offer } from '../api/types';
import { firstRoundAtOrAfter, QUICKNET } from '../lib/drand';
import { seededBech32, seededHex } from '../lib/prng';
import { totalPrepaidZat } from '../lib/zat';
import { S2_RUN } from '../data/s2';
import type { MockChain } from './chain';
import type { MockInstallmentRecord, MockRunner, MockSubRecord } from './runner';

export const DEMO_MERCHANT_UA = `utest1${seededBech32('merchant:shielded-press', 104)}`;

export const mockPocketUa = (seed: string) => `utest1${seededBech32(`pocket-ua:${seed}`, 104)}`;
export const mockPocketUfvk = (seed: string) => `uviewtest1${seededBech32(`pocket-ufvk:${seed}`, 189)}`;

const DAY = 86400;

interface Plan {
  id: string;
  name: string;
  amount_zat: number;
  period_secs: number;
  count: number;
  /** Release time of installment 1. */
  first_release: number;
  provenance?: string;
  tweak?: (inst: MockInstallmentRecord, chain: MockChain) => void;
}

function offerFor(runner: MockRunner, p: Plan): Offer {
  return {
    offer_id: `off_${p.id}`,
    name: p.name,
    amount_zat: p.amount_zat,
    period_secs: p.period_secs,
    count: p.count,
    merchant_ua: DEMO_MERCHANT_UA,
    runner_age_recipient: runner.ageRecipient,
    runner_endpoint: runner.appOrigin,
    network: 'test',
    drand_chain: QUICKNET.hash,
  };
}

function seedPlan(runner: MockRunner, chain: MockChain, p: Plan): MockSubRecord {
  const subscription_id = `sub_${p.id}`;
  const created_at = p.first_release - 90;
  const fundSent = created_at - 60;
  const fundTarget = chain.tipAt(fundSent) + 1;
  const funding = {
    txid: seededHex(`${p.id}:funding`),
    kind: 'wallet' as const,
    to: mockPocketUa(p.id),
    value_zat: totalPrepaidZat(p.amount_zat, p.count),
    sent_at: fundSent,
    target_height: fundTarget,
    mined_height: fundTarget,
  };
  chain.record(funding);
  const installments: MockInstallmentRecord[] = Array.from({ length: p.count }, (_, i) => {
    const inst: MockInstallmentRecord = {
      k: i + 1,
      amount_zat: p.amount_zat,
      release_round: firstRoundAtOrAfter(p.first_release + i * p.period_secs),
      window: null,
      late: (i * 7 + p.id.length) % 2,
    };
    p.tweak?.(inst, chain);
    return inst;
  });
  const rec: MockSubRecord = {
    subscription_id,
    offer: offerFor(runner, p),
    created_at,
    funding: { txid: funding.txid, mined_height: funding.mined_height, amount_zat: funding.value_zat },
    pocket_ufvk: mockPocketUfvk(p.id),
    installments,
    provenance: p.provenance,
  };
  runner.addRecord(rec);
  return rec;
}

export function seedMockRunner(runner: MockRunner, chain: MockChain, now: number): void {
  // 1. The real S2 run: three chained installments mined on NU7 testnet.
  const s2: MockSubRecord = {
    subscription_id: 'sub_s2testnet',
    offer: offerFor(runner, {
      id: 's2testnet',
      name: 'S2 testnet run',
      amount_zat: 100_000,
      period_secs: 180,
      count: 3,
      first_release: 0,
    }),
    created_at: Math.floor(chain.timeOfHeight(S2_RUN.funding.mined_height) + 20),
    funding: { txid: S2_RUN.funding.txidShort, mined_height: S2_RUN.funding.mined_height, amount_zat: 330_000 },
    pocket_ufvk: mockPocketUfvk('s2testnet'),
    provenance: 'Real NU7 testnet txids and heights from evidence/S2-testnet.md. Amounts and release rounds are illustrative.',
    installments: S2_RUN.installments.map((i) => ({
      k: i.k,
      amount_zat: 100_000,
      release_round: firstRoundAtOrAfter(chain.timeOfHeight(i.target_height - 1) - 8),
      window: null,
      late: i.mined_height - i.target_height,
      fixed: { state: 'mined', txid: i.txid, target_height: i.target_height, mined_height: i.mined_height },
    })),
  };
  runner.addRecord(s2);

  // 2. A monthly plan: first month paid, the second still sealed for weeks. Two, as the
  //    45-day horizon allows (lib/offer.ts).
  seedPlan(runner, chain, {
    id: 'press_monthly',
    name: 'Shielded Press · monthly',
    amount_zat: 500_000,
    period_secs: 30 * DAY,
    count: 2,
    first_release: now - 9 * DAY - 3 * 3600,
    provenance: 'Synthetic mock data.',
  });

  // 3. A weekly stipend whose third installment releases about a minute after load,
  //    so the dashboard shows sealed → due → broadcast → mined live.
  const nextRelease = now + 75;
  seedPlan(runner, chain, {
    id: 'relay_stipend',
    name: 'Relay operator stipend · weekly',
    amount_zat: 2_500_000,
    period_secs: 7 * DAY,
    count: 6,
    first_release: nextRelease - 14 * DAY,
    provenance: 'Synthetic mock data. Installment 3 releases about a minute after page load.',
  });

  // 4. Cancelled by the payer three days ago: the pocket note was spent elsewhere.
  const podcast = seedPlan(runner, chain, {
    id: 'podcast_support',
    name: 'Podcast supporter · monthly',
    amount_zat: 1_000_000,
    period_secs: 30 * DAY,
    count: 4,
    first_release: now - 40 * DAY,
    provenance: 'Synthetic mock data. The payer cancelled after two installments.',
  });
  const cancelSent = now - 3 * DAY;
  const cancelTarget = chain.tipAt(cancelSent) + 1;
  chain.record({
    txid: seededHex('podcast_support:cancel'),
    kind: 'cancel',
    to: `utest1${seededBech32('payer-refund', 104)}`,
    value_zat: 2 * 1_010_000 - 10_000,
    sent_at: cancelSent,
    target_height: cancelTarget,
    mined_height: cancelTarget,
    spends_pocket: podcast.pocket_ufvk,
  });

  // 5. Stalled: the runner was offline past installment 2's rung window.
  seedPlan(runner, chain, {
    id: 'mirror_hosting',
    name: 'Mirror hosting · daily',
    amount_zat: 300_000,
    period_secs: DAY,
    count: 5,
    first_release: now - 2 * DAY - 2 * 3600,
    provenance: 'Synthetic mock data. The runner was down for 40 minutes and missed installment 2.',
    tweak: (inst, chain) => {
      if (inst.k !== 2) return;
      const release = now - DAY - 2 * 3600;
      const est = chain.tipAt(release) + 1;
      inst.window = [est - 2, est + 45];
      inst.runner_offline_until = release + 40 * 60;
    },
  });
}
