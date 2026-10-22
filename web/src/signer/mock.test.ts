import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { isUfvk, isUnifiedAddress } from '../lib/addresses';
import { QUICKNET } from '../lib/drand';
import { seededBech32 } from '../lib/prng';
import { totalPrepaidZat } from '../lib/zat';
import { MockSigner, PACKAGE_BYTES, type MockLedger } from './mock';

const offer: Offer = {
  offer_id: 'off_s',
  name: 's',
  amount_zat: 100_000,
  period_secs: 20,
  count: 2,
  merchant_ua: `utest1${seededBech32('m', 104)}`,
  runner_age_recipient: `age1${seededBech32('a', 58)}`,
  runner_endpoint: 'https://r.example',
  network: 'test',
  drand_chain: QUICKNET.hash,
};

function ledger(payments: Array<{ to?: string; value_zat: number }> = []) {
  const windows: Array<[number, number]> = [];
  const cancels: Array<{ refundUa: string; valueZat: number }> = [];
  let pocketUa = '';
  const l: MockLedger = {
    now: () => 1_800_000_000,
    tip: () => 5_000_000,
    blockSecs: 5,
    paymentsTo: (ua) => {
      pocketUa = ua;
      return payments.map((p, i) => ({ txid: String(i).repeat(64).slice(0, 64), value_zat: p.value_zat, mined_height: 5_000_001 }));
    },
    pocketBalance: () => 120_000,
    registerPackage: (_s, w) => void windows.push(w),
    broadcastCancel: (_u, refundUa, valueZat) => (cancels.push({ refundUa, valueZat }), { txid: 'c'.repeat(64), target_height: 5_000_001 }),
  };
  return { l, windows, cancels, pocketUa: () => pocketUa };
}

describe('MockSigner', () => {
  it('creates a single-use pocket with an Orchard-style UA and UFVK', async () => {
    const signer = new MockSigner(ledger().l);
    const pocket = await signer.createPocket('test');
    expect(isUnifiedAddress(pocket.ua, 'test')).toBe(true);
    expect(isUfvk(pocket.ufvk, 'test')).toBe(true);
    expect(pocket.birthday_height).toBe(5_000_000);
    await expect(signer.createPocket('test')).rejects.toThrow(/single-use/);
  });

  it('pre-signs one fixed-size sealed package per installment, rounds increasing', async () => {
    const { l, windows } = ledger([{ value_zat: totalPrepaidZat(100_000, 2) }]);
    const signer = new MockSigner(l);
    await signer.createPocket('test');
    const funding = await signer.awaitFunding(totalPrepaidZat(100_000, 2));
    const phases = new Set<string>();
    const sealed = await signer.presign(offer, funding, { onProgress: (p) => phases.add(p.phase) });
    expect(sealed.map((s) => s.k)).toEqual([1, 2]);
    expect(sealed[1]!.release_round).toBeGreaterThan(sealed[0]!.release_round);
    expect(new Set(sealed.map((s) => s.sealed.length)).size).toBe(1);
    expect(atob(sealed[0]!.sealed).length).toBe(PACKAGE_BYTES);
    expect(windows).toHaveLength(2);
    expect([...phases]).toEqual(['sign', 'redact', 'compress', 'seal', 'timelock', 'done']);
    await expect(signer.presign(offer, funding)).rejects.toThrow(/single-use/);
  });

  it('refuses to sign a schedule the pocket cannot cover', async () => {
    const signer = new MockSigner(ledger().l);
    await signer.createPocket('test');
    await expect(signer.presign(offer, { txid: 'x', value_zat: 1, status: 'mempool' })).rejects.toThrow(/needs/);
  });

  it('cancels only to a valid address of the payer, once', async () => {
    const { l, cancels } = ledger();
    const signer = new MockSigner(l);
    const pocket = await signer.createPocket('test');
    await expect(signer.cancel('not-an-address')).rejects.toThrow(/unified address/);
    await expect(signer.cancel(pocket.ua)).rejects.toThrow(/not to the pocket/);
    const refund = `utest1${seededBech32('refund', 104)}`;
    const r = await signer.cancel(refund);
    expect(r.refunded_zat).toBe(120_000 - 10_000);
    expect(cancels).toEqual([{ refundUa: refund, valueZat: 110_000 }]);
    await expect(signer.cancel(refund)).rejects.toThrow(/already/);
  });

  it('holds keys in memory only and forgets them on destroy', async () => {
    const signer = new MockSigner(ledger().l);
    await signer.createPocket('test');
    expect(signer.keyCustody).toBe('memory');
    signer.destroy();
    await expect(signer.cancel(`utest1${seededBech32('r', 104)}`)).rejects.toThrow(/destroyed/);
  });
});
