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
import type { CancelPurpose } from './FlowViews';
import { Guilloche } from './Guilloche';
import { Callout, Spinner, Txid } from './ui';

const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/** "the runner at host" for a runner named by its host; "the in-page mock runner" for one named in words. */
const reporterName = (label: string) => (label.includes(' ') ? `the ${label}` : `the runner at ${label}`);

/** The host a saved certificate names: a same-origin runner is this page's own host. */
const reporterOf = (label: string) => (label === 'same-origin runner' ? location.host : label);

/**
 * After a cancel: waits until it is mined and the decoder shows it revealing the
 * spent note's nullifier, then states what that proves about the rest of the plan.
 * "Mined" is the runner's report (it relays the cancel and decodes it), so the
 * certificate says so and names the runner, rather than claiming a check of its own.
 * Drawn as a certificate on Paper; its rosette comes from the spent nullifier, so
 * every certificate's engraving is its own.
 */
export function CancelCertificate({
  receipt,
  client,
  network,
  subscriptionId,
  count,
  purpose = 'cancel',
}: {
  receipt: CancelReceipt;
  client: CadenceClient;
  network: Offer['network'];
  subscriptionId: string | null;
  count: number;
  /** 'refund': the same proof, for what a stopped or missed plan left in the pocket. */
  purpose?: CancelPurpose;
}) {
  const decoded = usePoll((signal) => client.decode(receipt.txid, signal), 20_000, [receipt.txid]);
  const runner = reporterOf(client.transport.label);
  const cert = useMemo<Certificate | null>(
    () => certify(receipt, decoded.data, { network, subscription_id: subscriptionId, count, runner }, Math.floor(nowSecs())),
    [receipt, decoded.data, network, subscriptionId, count, runner],
  );
  if (receipt.spent_k === undefined || !receipt.spent_nullifier) return null;
  if (!cert) return <Spinner label={`Waiting for the ${purpose} to be mined…`} />;

  const voids = cert.void_installments;
  const refund = purpose === 'refund';
  return (
    <Callout kind="ok" className="certificate" icon={<Guilloche seed={cert.spent_nullifier} />}>
      <div className="stack" style={{ ['--gap' as string]: '10px' }}>
        <span className="kicker plain">{refund ? 'Refund certificate' : 'Cancellation certificate'}</span>
        <strong className="certificate-title">
          {refund ? 'Refunded' : 'Cancelled'} at block {cert.mined_height.toLocaleString('en-US')}.
        </strong>
        <dl className="certificate-figures">
          <div>
            <dt>Never valid now</dt>
            <dd>{voids.length === 0 ? 'none were left' : `${voids.length === 1 ? 'installment' : 'installments'} ${installmentRange(voids)}`}</dd>
          </div>
          <div>
            <dt>Returned to you</dt>
            <dd>{formatZec(cert.returned_zat, network)}</dd>
          </div>
          <div>
            <dt>Network fee</dt>
            <dd>{formatZec(cert.fee_zat, network)}</dd>
          </div>
          <div>
            <dt>Spent nullifier</dt>
            <dd>{short(cert.spent_nullifier)}</dd>
          </div>
        </dl>
        <span className="small">
          The {purpose} spent {receipt.spent ?? 'the pocket note'}, whose nullifier is now on chain in <Txid value={cert.cancel_txid} />.{' '}
          {voids.length === 0
            ? 'No installment was left to pay.'
            : voids.length === 1
              ? `Installment ${voids[0]} spends exactly that note, so no node will accept it.`
              : `Installment ${voids[0]} spends exactly that note, so no node will accept it, and ${voids.length === 2 ? 'installment' : 'installments'} ${installmentRange(voids.slice(1))} would spend change that installment ${voids[0]} can now never make. Installments ${installmentRange(voids)} can never be valid.`}{' '}
          Mined, as reported by {reporterName(cert.reported_by)} (seen {formatDateTime(cert.confirmed_at)}).
        </span>
        <div className="row" style={{ ['--gap' as string]: '10px' }}>
          <Link to={`/decode/${cert.cancel_txid}?nf=${cert.spent_nullifier}`} className="link-btn small">
            Open in the decoder
          </Link>
          <button
            type="button"
            className="link-btn small"
            onClick={() =>
              downloadBytes(new TextEncoder().encode(JSON.stringify(cert, null, 2) + '\n'), `cadence-${refund ? 'refund' : 'cancellation'}-${cert.cancel_txid.slice(0, 12)}.json`, 'application/json')
            }
          >
            Save certificate
          </button>
        </div>
        <span className="tiny muted">
          The certificate leaves out your refund address. It rests on what that runner reports, and this app's decoder reads from a runner too. To check it without a runner, look
          up the cancel txid in any explorer, or with <code>cadence-decode</code> through a lightwalletd of your own, and see the refund arrive in your own wallet.
        </span>
      </div>
    </Callout>
  );
}
