/**
 * The payer's mandate flow, shared by /subscribe and the sandbox:
 * pocket → ZIP 321 funding → pre-sign once the signer sees the funding → upload sealed packages.
 */
import { ApiError, type CadenceClient } from './api/client';
import type { Offer, SealedInstallment } from './api/types';
import { horizonProblem } from './lib/offer';
import { unitFor, totalPrepaidZat, zatToZecString } from './lib/zat';
import { buildZip321Uri } from './lib/zip321';
import { nowSecs } from './lib/time';
import { api } from './runtime';
import { SignerError, type FundingTx, type PocketInfo, type PresignProgress, type Signer } from './signer/types';

export type FlowPhase = 'idle' | 'pocket' | 'funding' | 'signing' | 'uploading' | 'done' | 'error';

export interface FlowState {
  phase: FlowPhase;
  pocket?: PocketInfo;
  totalZat?: number;
  uri?: string;
  funding?: FundingTx;
  progress?: PresignProgress;
  /** One entry per installment whose packages are finished. */
  finished?: PresignProgress[];
  sealed?: SealedInstallment[];
  signedAt?: number;
  subscriptionId?: string;
  error?: string;
  /** The signer refused what it saw (an underpaid pocket, say), so watching again would repeat the error. */
  refused?: boolean;
}

/** The memo the payer's own wallet shows for the funding payment. Opaque to everyone else. */
export function fundingMemo(offer: Offer): string {
  return `Cadence: ${offer.name} (${offer.count} × ${zatToZecString(offer.amount_zat)} ${unitFor(offer.network)})`;
}

export function fundingUri(offer: Offer, pocketUa: string): string {
  return buildZip321Uri({ address: pocketUa, amountZat: totalPrepaidZat(offer.amount_zat, offer.count), memo: fundingMemo(offer) });
}

export async function runMandate(
  offer: Offer,
  signer: Signer,
  update: (patch: Partial<FlowState>) => void,
  opts: {
    signal?: AbortSignal;
    /** The runner to upload to: the offer's (default: the build's default runner). */
    api?: CadenceClient;
    onPocket?: (pocket: PocketInfo, totalZat: number) => void | Promise<void>;
  } = {},
): Promise<void> {
  try {
    // Refused before any pocket exists: the signer could not seal it, and the payer would have paid.
    const horizon = horizonProblem(offer);
    if (horizon) throw new Error(horizon);
    update({ phase: 'pocket', error: undefined, refused: undefined });
    const pocket = await signer.createPocket(offer.network);
    const totalZat = totalPrepaidZat(offer.amount_zat, offer.count);
    update({ pocket, totalZat, uri: fundingUri(offer, pocket.ua), phase: 'funding' });
    await opts.onPocket?.(pocket, totalZat);

    const funding = await signer.awaitFunding(totalZat, { signal: opts.signal });
    update({ funding, phase: 'signing' });
    await signAndUpload(offer, signer, pocket, funding, update, opts);
  } catch (e) {
    if (opts.signal?.aborted) return;
    update({ phase: 'error', error: (e as Error).message, ...(e instanceof SignerError ? { refused: true } : {}) });
  }
}

/** Pre-signs every installment against the funding, then uploads the sealed packages. */
async function signAndUpload(
  offer: Offer,
  signer: Signer,
  pocket: PocketInfo,
  funding: FundingTx,
  update: (patch: Partial<FlowState>) => void,
  opts: { signal?: AbortSignal; api?: CadenceClient },
): Promise<void> {
  const signedAt = nowSecs();
  const finished: PresignProgress[] = [];
  const sealed = await signer.presign(offer, funding, {
    signedAt,
    signal: opts.signal,
    onProgress: (progress) => {
      if (progress.phase === 'done') finished.push(progress);
      update({ progress, finished: [...finished] });
    },
  });
  update({ sealed, signedAt, phase: 'uploading' });
  const subscriptionId = await uploadSealed(offer, pocket, funding, sealed, opts);
  update({ subscriptionId, phase: 'done' });
}

/** Upload attempts, and the wait before each retry. */
const UPLOAD_RETRY_MS = [3_000, 10_000];

/**
 * Uploads the sealed packages. A timeout or a 5xx is retried: the runner accepts the
 * same packages again for the same pocket and answers with the same subscription, so
 * an upload that landed after the page gave up costs nothing.
 */
async function uploadSealed(
  offer: Offer,
  pocket: PocketInfo,
  funding: FundingTx,
  sealed: SealedInstallment[],
  opts: { signal?: AbortSignal; api?: CadenceClient; sleep?: (ms: number) => Promise<void> },
): Promise<string> {
  const body = {
    offer_id: offer.offer_id,
    ...(pocket.pocket_id ? { pocket_id: pocket.pocket_id } : {}),
    pocket_ufvk: pocket.ufvk,
    birthday_height: pocket.birthday_height,
    funding_txid: funding.txid,
    installments: sealed,
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return (await (opts.api ?? api).createSubscription(body, opts.signal)).subscription_id;
    } catch (e) {
      const retriable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!retriable || attempt >= UPLOAD_RETRY_MS.length || opts.signal?.aborted) throw e;
      await sleep(UPLOAD_RETRY_MS[attempt]!);
    }
  }
}

/**
 * Uploads again after a failed upload, from what the flow already holds: the packages
 * are sealed and the pocket is funded, so starting over would only strand the pocket.
 */
export async function retryUpload(
  offer: Offer,
  s: FlowState,
  update: (patch: Partial<FlowState>) => void,
  opts: { signal?: AbortSignal; api?: CadenceClient } = {},
): Promise<void> {
  if (!s.pocket || !s.funding || !s.sealed) return;
  try {
    update({ phase: 'uploading', error: undefined });
    const subscriptionId = await uploadSealed(offer, s.pocket, s.funding, s.sealed, opts);
    update({ subscriptionId, phase: 'done' });
  } catch (e) {
    if (opts.signal?.aborted) return;
    update({ phase: 'error', error: (e as Error).message, ...(e instanceof SignerError ? { refused: true } : {}) });
  }
}

/** Whether a failed flow can upload again rather than start over. */
export const canRetryUpload = (s: FlowState): boolean => Boolean(s.pocket && s.funding && s.sealed && !s.subscriptionId);

/**
 * Signs again after signing failed with the pocket already funded. The signer still
 * holds the pocket's key and its funding note, and marks a pocket pre-signed only once
 * every installment is sealed, so a second attempt starts clean; starting over instead
 * would abandon the paid pocket.
 */
export async function retrySigning(
  offer: Offer,
  signer: Signer,
  s: FlowState,
  update: (patch: Partial<FlowState>) => void,
  opts: { signal?: AbortSignal; api?: CadenceClient } = {},
): Promise<void> {
  if (!canRetrySigning(s)) return;
  try {
    update({ phase: 'signing', error: undefined, progress: undefined, finished: [] });
    await signAndUpload(offer, signer, s.pocket!, s.funding!, update, opts);
  } catch (e) {
    if (opts.signal?.aborted) return;
    update({ phase: 'error', error: (e as Error).message, ...(e instanceof SignerError ? { refused: true } : {}) });
  }
}

/**
 * Watches for the payment again after the watch itself failed (the runner did not
 * answer, say). The pocket and its key are unchanged in the signer, so a payment the
 * payer already sent still lands in it; starting over would make a new pocket instead.
 */
export async function watchAgain(
  offer: Offer,
  signer: Signer,
  s: FlowState,
  update: (patch: Partial<FlowState>) => void,
  opts: { signal?: AbortSignal; api?: CadenceClient } = {},
): Promise<void> {
  if (!canWatchAgain(s)) return;
  try {
    update({ phase: 'funding', error: undefined, refused: undefined });
    const funding = await signer.awaitFunding(s.totalZat!, { signal: opts.signal });
    update({ funding, phase: 'signing' });
    await signAndUpload(offer, signer, s.pocket!, funding, update, opts);
  } catch (e) {
    if (opts.signal?.aborted) return;
    update({ phase: 'error', error: (e as Error).message, ...(e instanceof SignerError ? { refused: true } : {}) });
  }
}

/** Whether a failed flow has a pocket to pay but has not seen the payment, so it can watch again; not after a refusal, which would repeat. */
export const canWatchAgain = (s: FlowState): boolean => Boolean(s.pocket && s.totalZat !== undefined && !s.funding && !s.refused);

/** Whether a failed flow is funded but has nothing sealed yet, so it can sign again. */
export const canRetrySigning = (s: FlowState): boolean => Boolean(s.pocket && s.funding && !s.sealed && !s.subscriptionId);
