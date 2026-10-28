/**
 * Access passes. A runner that lists `pass` signs one for a payer whose
 * subscription is paid up: `<b64url(payload)>.<b64url(signature)>`, the signature
 * Ed25519 over the payload's exact bytes with the runner's pass key
 * (`GET /api/passes/key`). The payload names the offer and the subscription, which the
 * merchant already knows, and never the payer. Anyone can check one with the key alone.
 */
import { hasFeature, type CadenceClient } from '../api/client';
import type { Installment, NetworkId, PassPayload } from '../api/types';
import { askInTurn } from '../config/runners';
import { base64urlToBytes, utf8Decode } from './base64url';
import { fromHex } from './payerAuth';

export type ParsedPass = { ok: true; payload: PassPayload; payloadBytes: Uint8Array; signature: Uint8Array } | { ok: false; problem: string };

const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Splits and decodes a pasted pass, and checks its payload's shape. Does not check the signature. */
export function parsePass(input: string): ParsedPass {
  const parts = input.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, problem: 'This is not an access pass: a pass is two base64url parts joined by a dot.' };
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  let json: unknown;
  try {
    payloadBytes = base64urlToBytes(parts[0]);
    signature = base64urlToBytes(parts[1]);
    json = JSON.parse(utf8Decode(payloadBytes));
  } catch {
    return { ok: false, problem: 'This pass is damaged: its parts are not base64url, or its payload is not JSON. Copy it again.' };
  }
  if (signature.length !== 64) return { ok: false, problem: 'This pass is damaged: its signature is not 64 bytes. Copy it again.' };
  const o = (json ?? {}) as Record<string, unknown>;
  if (o.v !== 1) return { ok: false, problem: `This pass has version ${JSON.stringify(o.v)}; this page reads version 1.` };
  if (o.iss !== 'main' && o.iss !== 'test') return { ok: false, problem: 'This pass names no network it was issued on.' };
  if (!text(o.offer_id) || !text(o.sub) || !uint(o.paid) || !uint(o.valid_until) || !uint(o.iat)) return { ok: false, problem: 'This pass is missing a field: offer_id, sub, paid, valid_until or iat.' };
  const payload: PassPayload = { v: 1, iss: o.iss, offer_id: o.offer_id, sub: o.sub, paid: o.paid, valid_until: o.valid_until, iat: o.iat };
  return { ok: true, payload, payloadBytes, signature };
}

/** Ed25519 over the payload bytes, with a runner's pass key (hex). WebCrypto, in this tab. */
export async function verifyPassSignature(publicKeyHex: string, payloadBytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) return false;
  const key = await crypto.subtle.importKey('raw', fromHex(publicKeyHex) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signature as BufferSource, payloadBytes as BufferSource);
}

/**
 * Until when a pass for this subscription is good: half a period past the release time of
 * the first installment not yet mined, or, once every one is mined, half a period past
 * the period after the last. During a trial that is installment 1's release plus the grace.
 */
export function passValidUntil(installments: ReadonlyArray<Pick<Installment, 'state' | 'release_at'>>, periodSecs: number): number {
  const next = installments.find((i) => i.state !== 'mined');
  const t = next ? next.release_at : (installments.at(-1)?.release_at ?? 0) + periodSecs;
  return t + Math.floor(periodSecs / 2);
}

export const passNetworkName = (n: NetworkId) => (n === 'main' ? 'mainnet' : 'testnet');

/**
 * Which known runner signed a pass. `signed`: one on the pass's network lists `pass` and
 * its key verifies the signature. `bad-signature`: one does, but its key does not.
 * `no-pass`: the runners on that network issue no passes. `no-runner`: this app knows
 * no runner on that network.
 */
export type PassIssuer<R> =
  | { kind: 'signed'; runner: R; publicKey: string }
  | { kind: 'bad-signature'; runner: R; publicKey: string }
  | { kind: 'no-pass'; runners: R[] }
  | { kind: 'no-runner' };

class NotTheIssuer extends Error {}

/**
 * Asks the runners in `order` in turn (src/config/runners.ts askInTurn) for their network,
 * features and pass key, and checks the signature here against each candidate's key. A
 * runner that cannot be reached, when no other signed the pass, is an error.
 */
export async function findPassIssuer<R extends { api: CadenceClient }>(pass: Extract<ParsedPass, { ok: true }>, order: readonly R[], signal?: AbortSignal): Promise<PassIssuer<R>> {
  const skipped: Array<{ runner: R; why: 'network' | 'no-pass' | 'signature'; publicKey?: string }> = [];
  const skip = (runner: R, why: 'network' | 'no-pass' | 'signature', publicKey?: string): never => {
    skipped.push({ runner, why, publicKey });
    throw new NotTheIssuer();
  };
  try {
    const { value, runner } = await askInTurn(
      order,
      async (r) => {
        const status = await r.api.status(signal);
        if (status.network !== pass.payload.iss) return skip(r, 'network');
        if (!hasFeature(status, 'pass')) return skip(r, 'no-pass');
        const key = await r.api.passKey(signal);
        if (!(await verifyPassSignature(key.public_key, pass.payloadBytes, pass.signature))) return skip(r, 'signature', key.public_key);
        return key.public_key;
      },
      (e) => e instanceof NotTheIssuer,
    );
    return { kind: 'signed', runner, publicKey: value };
  } catch (e) {
    if (!(e instanceof NotTheIssuer)) throw e;
    const bad = skipped.find((s) => s.why === 'signature');
    if (bad) return { kind: 'bad-signature', runner: bad.runner, publicKey: bad.publicKey! };
    const noPass = skipped.filter((s) => s.why === 'no-pass').map((s) => s.runner);
    return noPass.length ? { kind: 'no-pass', runners: noPass } : { kind: 'no-runner' };
  }
}

/** The SPKI DER of an Ed25519 public key, up to its 32 bytes. */
export const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

/**
 * How a merchant's own server checks a pass, in six lines of Node.js: the runner's pass
 * key (hex, from `GET /api/passes/key`) wrapped as SPKI DER, Ed25519 over the payload
 * bytes as received, then `valid_until` and the merchant's own offer. pass.test.ts runs it.
 */
export const MERCHANT_CHECK_EXAMPLE = `import { createPublicKey, verify } from 'node:crypto';
const key = createPublicKey({ key: Buffer.from('${ED25519_SPKI_PREFIX}' + RUNNER_PASS_KEY, 'hex'), format: 'der', type: 'spki' });
const [payload, signature] = pass.split('.').map((part) => Buffer.from(part, 'base64url'));
const signed = verify(null, payload, key, signature);
const claims = JSON.parse(payload);
const ok = signed && claims.valid_until >= Date.now() / 1000 && claims.offer_id === MY_OFFER_ID;`;
