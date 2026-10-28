import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  derivePayerSeed,
  PAYER_SIGNATURE_HEADER,
  PAYER_TIMESTAMP_HEADER,
  payerAuthFromSeed,
  payerMessage,
  toHex,
  verifyPayerSignature,
} from './payerAuth';

/** The shared vector: seed 0x01..0x20, POST /api/subscriptions/sub_test/pass at 1793170000, body {}. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PATH = '/api/subscriptions/sub_test/pass';
const TS = 1_793_170_000;
const VECTOR = {
  edSeed: '2256d985575eb7e7580292e57139d598cc56f7808161b5be20e0c9948afcf6e1',
  publicKey: '32cc7e26e3bf02cd5ba16783fde89f15f6f0c8cb8f18f4006411751799aae0d5',
  bodySha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  signature: '98dc04db1f0c00c6870a2f6add486e13f08d576070e98f39180940ba5c82ab5162e490caabf70b04990c1a424dfae6867d1b463115564f455b99e8a28c3c1205',
};

/** The same derivation and signature with node:crypto alone, independent of the code under test. */
function nodeVector() {
  const edSeed = Buffer.from(hkdfSync('sha256', Buffer.from(SEED), Buffer.from('cadence payer auth v1'), Buffer.alloc(0), 32));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), edSeed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
  const bodySha256 = createHash('sha256').update('{}').digest('hex');
  const message = `cadence-payer-v1\nPOST\n${PATH}\n${TS}\n${bodySha256}`;
  return { edSeed: edSeed.toString('hex'), publicKey: publicKey.toString('hex'), bodySha256, message, signature: nodeSign(null, Buffer.from(message), key).toString('hex'), spki: createPublicKey(key) };
}

describe('payer auth key', () => {
  it('matches the vector node:crypto computes on its own', () => {
    const v = nodeVector();
    expect(v.edSeed).toBe(VECTOR.edSeed);
    expect(v.publicKey).toBe(VECTOR.publicKey);
    expect(v.bodySha256).toBe(VECTOR.bodySha256);
    expect(v.signature).toBe(VECTOR.signature);
  });

  it('derives the Ed25519 seed with HKDF-SHA256 and the payer salt', async () => {
    expect(toHex(await derivePayerSeed(SEED))).toBe(VECTOR.edSeed);
    await expect(derivePayerSeed(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it('exports the public key as 64 hex characters and signs the vector message', async () => {
    const auth = await payerAuthFromSeed(SEED, { now: () => TS });
    expect(auth.publicKeyHex).toBe(VECTOR.publicKey);
    const headers = await auth.sign('POST', PATH, '{}');
    expect(headers).toEqual({ [PAYER_TIMESTAMP_HEADER]: String(TS), [PAYER_SIGNATURE_HEADER]: VECTOR.signature });
    expect(payerMessage('POST', PATH, TS, VECTOR.bodySha256)).toBe(nodeVector().message);
    expect(nodeVerify(null, Buffer.from(nodeVector().message), nodeVector().spki, Buffer.from(VECTOR.signature, 'hex'))).toBe(true);
  });

  it('does not read the seed again after it is made', async () => {
    const seed = Uint8Array.from(SEED);
    const auth = await payerAuthFromSeed(seed, { now: () => TS });
    seed.fill(0);
    expect((await auth.sign('POST', PATH, '{}'))[PAYER_SIGNATURE_HEADER]).toBe(VECTOR.signature);
  });

  it('gives two requests in one second distinct timestamps, so the runner never sees a replay', async () => {
    const auth = await payerAuthFromSeed(SEED, { now: () => TS + 0.4 });
    const a = await auth.sign('POST', PATH, '{}');
    const b = await auth.sign('POST', PATH, '{}');
    expect(a[PAYER_TIMESTAMP_HEADER]).toBe(String(TS));
    expect(b[PAYER_TIMESTAMP_HEADER]).toBe(String(TS + 1));
    expect(a[PAYER_SIGNATURE_HEADER]).not.toBe(b[PAYER_SIGNATURE_HEADER]);
  });

  it('signs the method, path, timestamp and body, and nothing verifies with any of them changed', async () => {
    const auth = await payerAuthFromSeed(SEED, { now: () => TS });
    const sig = (await auth.sign('POST', PATH, '{}'))[PAYER_SIGNATURE_HEADER];
    expect(await verifyPayerSignature(VECTOR.publicKey, 'POST', PATH, TS, '{}', sig)).toBe(true);
    expect(await verifyPayerSignature(VECTOR.publicKey, 'GET', PATH, TS, '{}', sig)).toBe(false);
    expect(await verifyPayerSignature(VECTOR.publicKey, 'POST', '/api/subscriptions/sub_other/pass', TS, '{}', sig)).toBe(false);
    expect(await verifyPayerSignature(VECTOR.publicKey, 'POST', PATH, TS + 1, '{}', sig)).toBe(false);
    expect(await verifyPayerSignature(VECTOR.publicKey, 'POST', PATH, TS, '{ }', sig)).toBe(false);
    const other = await payerAuthFromSeed(Uint8Array.from(SEED, (b) => b ^ 0xff));
    expect(other.publicKeyHex).not.toBe(VECTOR.publicKey);
    expect(await verifyPayerSignature(other.publicKeyHex, 'POST', PATH, TS, '{}', sig)).toBe(false);
  });

  it('refuses a path with an origin or a query', async () => {
    const auth = await payerAuthFromSeed(SEED);
    await expect(auth.sign('POST', 'https://runner.example/api/x', '{}')).rejects.toThrow(/no origin and no query/);
    await expect(auth.sign('POST', '/api/x?y=1', '{}')).rejects.toThrow(/no origin and no query/);
  });
});
