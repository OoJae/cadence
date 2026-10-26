/**
 * The payer's mandate flow, shared by /subscribe and the sandbox:
 * pocket → ZIP 321 funding → pre-sign once the signer sees the funding → upload sealed packages.
 */
import type { CadenceClient } from './api/client';
import type { Offer, SealedInstallment } from './api/types';
import { unitFor, totalPrepaidZat, zatToZecString } from './lib/zat';
import { buildZip321Uri } from './lib/zip321';
import { nowSecs } from './lib/time';
import { api } from './runtime';
import type { FundingTx, PocketInfo, PresignProgress, Signer } from './signer/types';

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
    update({ phase: 'pocket', error: undefined });
    const pocket = await signer.createPocket(offer.network);
    const totalZat = totalPrepaidZat(offer.amount_zat, offer.count);
    update({ pocket, totalZat, uri: fundingUri(offer, pocket.ua), phase: 'funding' });
    await opts.onPocket?.(pocket, totalZat);

    const funding = await signer.awaitFunding(totalZat, { signal: opts.signal });
    update({ funding, phase: 'signing' });

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

    const res = await (opts.api ?? api).createSubscription(
      {
        offer_id: offer.offer_id,
        ...(pocket.pocket_id ? { pocket_id: pocket.pocket_id } : {}),
        pocket_ufvk: pocket.ufvk,
        birthday_height: pocket.birthday_height,
        funding_txid: funding.txid,
        installments: sealed,
      },
      opts.signal,
    );
    update({ subscriptionId: res.subscription_id, phase: 'done' });
  } catch (e) {
    if (opts.signal?.aborted) return;
    update({ phase: 'error', error: (e as Error).message });
  }
}
