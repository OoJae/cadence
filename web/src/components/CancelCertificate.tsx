import { useMemo } from 'react';
import type { CadenceClient } from '../api/client';
import type { Offer } from '../api/types';
import { usePoll } from '../hooks';
import { certify, installmentRange, type Certificate } from '../lib/certificate';
import { downloadBytes } from '../lib/download';
import { formatDateTime, nowSecs } from '../lib/time';
import { formatZec } from '../lib/zat';
import { Link } from '../router';
import type { CancelReceipt } from '../signer/types';
import { ShieldCheckIcon } from './Icons';
import { Callout, Spinner, Txid } from './ui';

const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/**
 * After a cancel: waits until it is mined and the decoder shows it revealing the
 * spent note's nullifier, then states what that proves about the rest of the plan.
 */
export function CancelCertificate({
  receipt,
  client,
  network,
  subscriptionId,
  count,
}: {
  receipt: CancelReceipt;
  client: CadenceClient;
  network: Offer['network'];
  subscriptionId: string | null;
  count: number;
}) {
  const decoded = usePoll((signal) => client.decode(receipt.txid, signal), 20_000, [receipt.txid]);
  const cert = useMemo<Certificate | null>(
    () => certify(receipt, decoded.data, { network, subscription_id: subscriptionId, count }, Math.floor(nowSecs())),
    [receipt, decoded.data, network, subscriptionId, count],
  );
  if (receipt.spent_k === undefined || !receipt.spent_nullifier) return null;
  if (!cert) return <Spinner label="Waiting for the cancel to be mined…" />;

  const voids = cert.void_installments;
  return (
    <Callout kind="ok" icon={<ShieldCheckIcon size={16} />}>
      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <strong>Cancelled at block {cert.mined_height.toLocaleString('en-US')}.</strong>
        <span className="small">
          The cancel spent {receipt.spent ?? 'the pocket note'}, whose nullifier <span className="mono">{short(cert.spent_nullifier)}</span> is now on chain in{' '}
          <Txid value={cert.cancel_txid} />.{' '}
          {voids.length === 0
            ? 'No installment was left to pay.'
            : voids.length === 1
              ? `Installment ${voids[0]} spends exactly that note, so no node will accept it.`
              : `Installment ${voids[0]} spends exactly that note, so no node will accept it, and ${voids.length === 2 ? 'installment' : 'installments'} ${installmentRange(voids.slice(1))} would spend change that installment ${voids[0]} can now never make. Installments ${installmentRange(voids)} can never be valid.`}
        </span>
        <span className="small">
          {formatZec(cert.returned_zat, network)} returned to your address (fee {formatZec(cert.fee_zat, network)}). Seen mined {formatDateTime(cert.confirmed_at)}.
        </span>
        <div className="row" style={{ ['--gap' as string]: '10px' }}>
          <Link to={`/decode/${cert.cancel_txid}?nf=${cert.spent_nullifier}`} className="link-btn small">
            Verify in the decoder
          </Link>
          <button
            type="button"
            className="link-btn small"
            onClick={() =>
              downloadBytes(new TextEncoder().encode(JSON.stringify(cert, null, 2) + '\n'), `cadence-cancellation-${cert.cancel_txid.slice(0, 12)}.json`, 'application/json')
            }
          >
            Save certificate
          </button>
        </div>
        <span className="tiny muted">The certificate leaves out your refund address. Anyone can check it: the decoder lists the nullifiers a transaction reveals.</span>
      </div>
    </Callout>
  );
}
