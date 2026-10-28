import { describe, expect, it } from 'vitest';
import type { Offer } from '../api/types';
import { isUfvk, isUnifiedAddress } from '../lib/addresses';
import { QUICKNET } from '../lib/drand';
import { seededBech32 } from '../lib/prng';
import { totalPrepaidZat } from '../lib/zat';
import { NothingToCancelError } from './cancel';
import { KIT_KIND } from './kit';
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

describe('MockSigner cancel key', () => {
  const ctx = { runner: 'http://localhost:5173', subscriptionId: 'sub_t' };
  const subscribed = async (l: MockLedger) => {
    const signer = new MockSigner(l);
    const pocket = await signer.createPocket('test');
    const funding = await signer.awaitFunding(totalPrepaidZat(100_000, 2));
    await signer.presign(offer, funding);
    return { signer, pocket };
  };

  it('saves an encrypted key that a fresh signer restores and cancels with', async () => {
    const { l, cancels } = ledger([{ value_zat: totalPrepaidZat(100_000, 2) }]);
    const { signer, pocket } = await subscribed(l);
    await expect(signer.sealKit('short', ctx)).rejects.toThrow(/at least 12/);
    await expect(signer.sealKit('password1234', ctx)).rejects.toThrow(/common password/);
    const kit = await signer.sealKit('correct horse battery', ctx);
    // Named for when it was saved: no pocket id in the name.
    expect(kit.fileName).toMatch(/^cadence-cancel-key-\d{8}-\d{4}\.mock$/);
    // Encrypted: neither the seed nor the schedule is readable in the file.
    const text = new TextDecoder().decode(kit.bytes);
    expect(text.startsWith('cadence-mock-kit/1\n')).toBe(true);
    expect(text).not.toContain('seed_hex');
    expect(text).not.toContain(offer.merchant_ua);
    // The tab closes: the key in memory is gone.
    signer.destroy();

    const fresh = new MockSigner(l);
    await expect(fresh.openKit(kit.bytes, 'wrong horse battery')).rejects.toThrow(/wrong passphrase/);
    const opened = await fresh.openKit(kit.bytes, 'correct horse battery');
    expect(opened.seed).toHaveLength(32);
    expect(opened.fields).toMatchObject({ kind: KIT_KIND, network: 'test', subscription_id: 'sub_t', offer_id: offer.offer_id, count: 2, amount_zat: 100_000, pocket_ua: pocket.ua });
    const restored = await fresh.restore(opened);
    expect(restored.ua).toBe(pocket.ua);
    expect(restored.ufvk).toBe(pocket.ufvk);
    // restore() takes the seed over; the caller's copy is zeroised.
    expect(opened.seed.every((b) => b === 0)).toBe(true);

    const statuses: string[] = [];
    const refund = `utest1${seededBech32('refund', 104)}`;
    const r = await fresh.cancel(refund, { onStatus: (s) => statuses.push(s.step) });
    expect(r.refunded_zat).toBe(120_000 - 10_000);
    expect(cancels).toEqual([{ refundUa: refund, valueZat: 110_000 }]);
    expect(statuses).toEqual(['finding', 'proving', 'broadcasting']);
    // The restored signer can save the key again.
    expect((await fresh.sealKit('correct horse battery', ctx)).bytes.length).toBeGreaterThan(100);
  });

  it('refuses to save a key before the schedule is signed, or to restore over a pocket', async () => {
    const { l } = ledger([{ value_zat: totalPrepaidZat(100_000, 2) }]);
    const early = new MockSigner(l);
    await early.createPocket('test');
    await expect(early.sealKit('correct horse battery', ctx)).rejects.toThrow(/pre-sign/);
    const { signer } = await subscribed(l);
    const opened = await signer.openKit((await signer.sealKit('correct horse battery', ctx)).bytes, 'correct horse battery');
    await expect(early.restore(opened)).rejects.toThrow(/already holds a pocket/);
    await expect(signer.openKit(new TextEncoder().encode('age-encryption.org/v1\n'), 'correct horse battery')).rejects.toThrow(/not a cancel key from this mock/);
  });

  it('checks that a re-picked key is this pocket’s, and says what is wrong when it is not', async () => {
    const { l } = ledger([{ value_zat: totalPrepaidZat(100_000, 2) }]);
    const { signer } = await subscribed(l);
    await expect(new MockSigner(l).verifyKit(new Uint8Array(1), 'x')).rejects.toThrow(/create a pocket first/);
    const kit = await signer.sealKit('correct horse battery', ctx);

    expect(await signer.verifyKit(kit.bytes, 'correct horse battery')).toEqual({ ok: true });
    const wrongPass = await signer.verifyKit(kit.bytes, 'correct horse batterY');
    expect(wrongPass).toMatchObject({ ok: false, reason: 'passphrase' });
    const wrongFile = await signer.verifyKit(new TextEncoder().encode('age-encryption.org/v1\n-> scrypt x 17\n'), 'correct horse battery');
    expect(wrongFile).toMatchObject({ ok: false, reason: 'file' });
    expect(!wrongFile.ok && wrongFile.message).toContain(kit.fileName);

    // Another pocket's key, even with the same passphrase, is the wrong file.
    const { signer: other } = await subscribed(l);
    const otherKit = await other.sealKit('correct horse battery', ctx);
    const r = await signer.verifyKit(otherKit.bytes, 'correct horse battery');
    expect(r).toMatchObject({ ok: false, reason: 'pocket' });
    expect(!r.ok && r.message).toMatch(/another pocket/);

    // Checking keeps nothing: the signer still holds only its own pocket.
    expect(await signer.verifyKit(kit.bytes, 'correct horse battery')).toEqual({ ok: true });
    signer.destroy();
    await expect(signer.verifyKit(kit.bytes, 'correct horse battery')).rejects.toThrow(/destroyed/);
  });

  it('refuses a key whose seed does not match its pocket', async () => {
    const { l } = ledger([{ value_zat: totalPrepaidZat(100_000, 2) }]);
    const { signer } = await subscribed(l);
    const opened = await signer.openKit((await signer.sealKit('correct horse battery', ctx)).bytes, 'correct horse battery');
    opened.seed[0] = opened.seed[0]! ^ 1;
    await expect(new MockSigner(l).restore(opened)).rejects.toThrow(/damaged/);
  });

  it('reports an empty pocket as nothing to cancel, not as a failure', async () => {
    const { l } = ledger([{ value_zat: totalPrepaidZat(100_000, 2) }]);
    l.pocketBalance = () => 0;
    const { signer } = await subscribed(l);
    await expect(signer.cancel(`utest1${seededBech32('r', 104)}`)).rejects.toBeInstanceOf(NothingToCancelError);
  });
});
