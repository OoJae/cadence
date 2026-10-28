import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiError, CadenceClient } from '../api/client';
import type { Offer, PassPayload, RunnerStatus } from '../api/types';
import { firstRoundAtOrAfter, QUICKNET } from './drand';
import { findPassIssuer, MERCHANT_CHECK_EXAMPLE, parsePass, passValidUntil, verifyPassSignature } from './pass';
import { payerAuthFromSeed } from './payerAuth';

const PAYLOAD: PassPayload = { v: 1, iss: 'test', offer_id: 'off_x', sub: 'sub_x', paid: 2, valid_until: 1_793_200_000, iat: 1_793_170_000 };

/** A runner pass key, and a pass signed with it by node:crypto: independent of the code under test. */
function keyAndPass(payload: object = PAYLOAD) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const bytes = Buffer.from(JSON.stringify(payload));
  return { hex, pass: `${bytes.toString('base64url')}.${sign(null, bytes, privateKey).toString('base64url')}` };
}

function parsed(pass: string) {
  const p = parsePass(pass);
  if (!p.ok) throw new Error(p.problem);
  return p;
}

describe('reading a pass', () => {
  it('decodes the payload and keeps its exact bytes for the signature', async () => {
    const { hex, pass } = keyAndPass();
    const p = parsed(`  ${pass}\n`);
    expect(p.payload).toEqual(PAYLOAD);
    expect(new TextDecoder().decode(p.payloadBytes)).toBe(JSON.stringify(PAYLOAD));
    expect(await verifyPassSignature(hex, p.payloadBytes, p.signature)).toBe(true);
    expect(await verifyPassSignature(keyAndPass().hex, p.payloadBytes, p.signature)).toBe(false);
    expect(await verifyPassSignature('not hex', p.payloadBytes, p.signature)).toBe(false);
  });

  it('says what is wrong with something that is not a pass', () => {
    const { pass } = keyAndPass();
    const [body, sig] = pass.split('.');
    const problem = (text: string) => {
      const p = parsePass(text);
      return p.ok ? null : p.problem;
    };
    expect(problem('')).toMatch(/two base64url parts/);
    expect(problem(body!)).toMatch(/two base64url parts/);
    expect(problem(`${body}.${sig}.x`)).toMatch(/two base64url parts/);
    expect(problem(`${body}!.${sig}`)).toMatch(/damaged/);
    expect(problem(`${body}.${sig!.slice(0, 40)}`)).toMatch(/not 64 bytes/);
    expect(problem(keyAndPass({ ...PAYLOAD, v: 2 }).pass)).toMatch(/version 2/);
    expect(problem(keyAndPass({ ...PAYLOAD, iss: 'regtest' }).pass)).toMatch(/network/);
    expect(problem(keyAndPass({ ...PAYLOAD, paid: -1 }).pass)).toMatch(/missing a field/);
  });
});

describe('until when a pass is good', () => {
  const at = (states: string[], first = 1000, period = 100) => states.map((state, i) => ({ state: state as 'mined', release_at: first + i * period }));

  it('is half a period past the first installment not mined', () => {
    expect(passValidUntil(at(['mined', 'sealed', 'sealed']), 100)).toBe(1100 + 50);
    expect(passValidUntil(at(['mined', 'broadcast', 'sealed']), 100)).toBe(1100 + 50);
  });

  it('during a trial, nothing is mined: installment 1 release plus the grace', () => {
    expect(passValidUntil(at(['sealed', 'sealed'], 90_000), 86_400)).toBe(90_000 + 43_200);
  });

  it('once every installment is mined, a period past the last, plus the grace; odd periods round down', () => {
    expect(passValidUntil(at(['mined', 'mined']), 100)).toBe(1100 + 100 + 50);
    expect(passValidUntil(at(['mined'], 1000, 31), 31)).toBe(1000 + 31 + 15);
  });
});

describe('finding the runner that signed a pass', () => {
  const status = (network: 'main' | 'test', features?: string[]) => ({ network, tip: 1, drand_round: 1, subscriptions: 0, ...(features ? { features } : {}) }) as RunnerStatus;
  const fake = (name: string, st: RunnerStatus | Error, key?: string) => ({
    name,
    api: {
      status: async () => {
        if (st instanceof Error) throw st;
        return st;
      },
      passKey: async () => ({ alg: 'Ed25519', public_key: key }),
    } as unknown as CadenceClient,
  });

  it('picks the runner on the pass network whose key verifies, past an old mainnet runner', async () => {
    const { hex, pass } = keyAndPass();
    const main = fake('main', status('main'));
    const test = fake('test', status('test', ['payer_auth', 'pass']), hex);
    expect(await findPassIssuer(parsed(pass), [main, test])).toEqual({ kind: 'signed', runner: test, publicKey: hex });
  });

  it('says the runner does not issue passes when the runners on that network list no pass', async () => {
    const { pass } = keyAndPass({ ...PAYLOAD, iss: 'main' });
    const main = fake('main', status('main'));
    const test = fake('test', status('test', ['pass']), keyAndPass().hex);
    expect(await findPassIssuer(parsed(pass), [main, test])).toEqual({ kind: 'no-pass', runners: [main] });
  });

  it('says no known runner is on that network', async () => {
    const { pass } = keyAndPass({ ...PAYLOAD, iss: 'main' });
    expect(await findPassIssuer(parsed(pass), [fake('test', status('test', ['pass']), keyAndPass().hex)])).toEqual({ kind: 'no-runner' });
  });

  it('reports a signature that the runner key does not verify', async () => {
    const { pass } = keyAndPass();
    const other = keyAndPass().hex;
    const test = fake('test', status('test', ['pass']), other);
    expect(await findPassIssuer(parsed(pass), [test])).toEqual({ kind: 'bad-signature', runner: test, publicKey: other });
  });

  it('looks past a runner that is down, and fails only when no other signed it', async () => {
    const { hex, pass } = keyAndPass();
    const down = fake('down', new ApiError(0, 'could not reach the runner'));
    const test = fake('test', status('test', ['pass']), hex);
    expect(await findPassIssuer(parsed(pass), [down, test])).toMatchObject({ kind: 'signed', runner: test });
    await expect(findPassIssuer(parsed(pass), [down, fake('main', status('main'))])).rejects.toMatchObject({ status: 0 });
  });
});

describe('a pass through the mock runner, end to end', () => {
  it('is asked for with the payer signature, then checks locally and with the runner', async () => {
    const { transport, runner, chain, DEMO_MERCHANT_UA } = await import('../mock');
    const now = Math.floor(Date.now() / 1000);
    const auth = await payerAuthFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const offer: Offer = {
      offer_id: 'off_pass-e2e',
      name: 'Pass e2e',
      amount_zat: 100_000,
      period_secs: 3600,
      count: 2,
      merchant_ua: DEMO_MERCHANT_UA,
      runner_age_recipient: runner.ageRecipient,
      runner_endpoint: runner.appOrigin,
      network: 'test',
      drand_chain: QUICKNET.hash,
    };
    const funding = chain.send({ kind: 'wallet', to: 'utest1pass', value_zat: 1_000_000 }, now);
    runner.addRecord({
      subscription_id: 'sub_pass-e2e',
      offer,
      created_at: now,
      funding: { txid: funding.txid, mined_height: funding.mined_height, amount_zat: 1_000_000 },
      pocket_ufvk: 'uviewtest1passe2e',
      installments: [1, 2].map((k) => ({ k, amount_zat: offer.amount_zat, release_round: firstRoundAtOrAfter(now + 600 + (k - 1) * 3600), window: null, late: 0 })),
      payer_auth_key: auth.publicKeyHex,
    });
    const client = new CadenceClient(transport);
    const got = await client.getPass('sub_pass-e2e', auth);
    const p = parsed(got.pass);
    expect(p.payload).toMatchObject({ iss: 'test', sub: 'sub_pass-e2e', offer_id: 'off_pass-e2e', paid: 0, valid_until: got.valid_until });
    expect(await findPassIssuer(p, [{ api: client }])).toMatchObject({ kind: 'signed' });
    expect(await client.verifyPass(got.pass)).toMatchObject({ valid: true, reason: null, sub: 'sub_pass-e2e' });
    // The same request signed again in the same second takes the next one, so it is no replay.
    expect((await client.getPass('sub_pass-e2e', auth)).pass).toMatch(/\./);
  });
});

describe('the merchant example on /pass', () => {
  it('is six lines that accept a good pass for the offer and refuse a forged, expired or foreign one', () => {
    const lines = MERCHANT_CHECK_EXAMPLE.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("import { createPublicKey, verify } from 'node:crypto';");
    // The other five lines, run as written, with the import's names and the merchant's two constants.
    const run = new Function('createPublicKey', 'verify', 'Buffer', 'pass', 'RUNNER_PASS_KEY', 'MY_OFFER_ID', `${lines.slice(1).join('\n')}\nreturn ok;`);
    const check = (pass: string, key: string, offer = 'off_x') => run(createPublicKey, verify, Buffer, pass, key, offer) as boolean;

    const future = { ...PAYLOAD, valid_until: Math.floor(Date.now() / 1000) + 3600 };
    const { hex, pass } = keyAndPass(future);
    expect(check(pass, hex)).toBe(true);
    expect(check(pass, hex, 'off_other')).toBe(false);
    expect(check(pass, keyAndPass().hex)).toBe(false);
    const sig = pass.split('.')[1];
    expect(check(`${Buffer.from(JSON.stringify({ ...future, offer_id: 'off_y' })).toString('base64url')}.${sig}`, hex, 'off_y')).toBe(false);
    const old = keyAndPass({ ...PAYLOAD, valid_until: 1_000 });
    expect(check(old.pass, old.hex)).toBe(false);
  });
});
