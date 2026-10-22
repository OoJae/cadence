import { useState, type ReactNode } from 'react';
import type { Offer } from '../api/types';
import type { FlowState } from '../flow';
import { BECH32_CHARS, isUnifiedAddress, shorten } from '../lib/addresses';
import { roundTime } from '../lib/drand';
import { formatDateTime, formatRelative, nowSecs } from '../lib/time';
import { formatZec, INSTALLMENT_FEE_ZAT } from '../lib/zat';
import { PACKAGE_BYTES } from '../signer/mock';
import type { CancelReceipt, Signer } from '../signer/types';
import { CheckIcon, LockIcon, TabIcon } from './Icons';
import { Qr } from './Qr';
import { Badge, Callout, CopyButton, Countdown, ErrorNote, Spinner, Txid } from './ui';
import { useNow } from '../hooks';

// ---------------------------------------------------------------- fund

export function FundingView({ offer, flow, onSimulate, simulateLabel = 'Simulate the payment from Zodl' }: { offer: Offer; flow: FlowState; onSimulate?: () => void; simulateLabel?: string }) {
  if (!flow.pocket || !flow.uri || flow.totalZat === undefined) return <Spinner label="Creating a fresh pocket…" />;
  const unitAmount = formatZec(flow.totalZat, offer.network);
  return (
    <div className="fund-grid">
      <div style={{ justifySelf: 'center' }}>
        <Qr value={flow.uri} label={`ZIP 321 payment request for ${unitAmount}`} ribbon={onSimulate ? 'mock pocket · do not pay' : undefined} size={260} />
      </div>
      <div className="stack" style={{ ['--gap' as string]: '14px' }}>
        <div>
          <div className="kicker plain">Pay exactly</div>
          <div className="display" style={{ fontSize: 40, marginTop: 4 }}>
            {unitAmount}
          </div>
          <div className="small muted mono">
            {offer.count} × ({formatZec(offer.amount_zat, offer.network)} + {formatZec(INSTALLMENT_FEE_ZAT, offer.network)} fee)
          </div>
        </div>
        <p className="small text-2">Scan with Zodl, or any ZIP 321 wallet, and pay from your shielded (Ironwood) balance. A transparent payment would publicly link your wallet to this pocket.</p>
        <div className="field">
          <span className="label">Pocket address</span>
          <div className="row" style={{ ['--gap' as string]: '6px' }}>
            <span className="mono small break text-2" style={{ flex: 1 }}>
              {shorten(flow.pocket.ua, 18, 10)}
            </span>
            <CopyButton text={flow.pocket.ua} label="Copy pocket address" />
          </div>
        </div>
        <div className="row" style={{ ['--gap' as string]: '8px' }}>
          <a className="btn" href={flow.uri}>
            Open in wallet
          </a>
          <span className="row small muted" style={{ ['--gap' as string]: '4px' }}>
            <CopyButton text={flow.uri} label="Copy payment URI" /> Copy URI
          </span>
        </div>
        <div className="panel row no-wrap" style={{ ['--gap' as string]: '10px' }} aria-live="polite">
          {flow.funding ? (
            <>
              <CheckIcon size={16} className="accent" />
              <span className="small">
                Payment seen {flow.funding.status === 'mempool' ? 'in the mempool' : 'on chain'}: <Txid value={flow.funding.txid} link={false} />
              </span>
            </>
          ) : (
            <>
              <span className="spinner" aria-hidden="true" />
              <span className="small text-2">Watching for your payment through this pocket's viewing key…</span>
            </>
          )}
        </div>
        {onSimulate && !flow.funding && (
          <button type="button" className="btn primary" onClick={onSimulate}>
            {simulateLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sign

const PHASE_TEXT: Record<string, string> = {
  redact: 'Redacting: ZIP 32 paths, ock, user_address, proprietary fields',
  compress: 'Compressing (zstd) and padding to a fixed size',
  seal: 'Sealing to the runner (age)',
  timelock: 'Time-locking to its drand round (tlock)',
};
const PHASE_WEIGHT: Record<string, number> = { sign: 0, redact: 0.84, compress: 0.88, seal: 0.92, timelock: 0.96, done: 1 };

export function SigningView({ offer, flow }: { offer: Offer; flow: FlowState }) {
  const p = flow.progress;
  const finished = flow.finished ?? [];
  const uploading = flow.phase === 'uploading' || flow.phase === 'done';
  let frac = 0;
  if (p) {
    const within = p.phase === 'sign' ? (p.rungsDone / p.rungsTotal) * 0.8 : PHASE_WEIGHT[p.phase]!;
    frac = (p.k - 1 + within) / p.count;
  }
  if (uploading) frac = 1;

  return (
    <div className="stack" style={{ ['--gap' as string]: '18px' }}>
      <div className="stack" style={{ ['--gap' as string]: '8px' }}>
        <div className="row between">
          <span className="h4">{uploading ? (flow.phase === 'done' ? 'Uploaded' : `Uploading ${offer.count} sealed packages to the runner…`) : 'Signing your schedule…'}</span>
          <span className="mono small muted num">{Math.round(frac * 100)}%</span>
        </div>
        <div className={`progress${uploading ? ' done' : ' running'}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label="Signing progress">
          <span style={{ width: `${frac * 100}%` }} />
        </div>
        <p className="tiny muted">
          Each installment is signed once per candidate block height (a rung), so the runner can broadcast at whatever height it falls due without ever needing a different expiry. All
          rungs of one installment share identical actions.
        </p>
      </div>
      <ol className="timeline-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {Array.from({ length: offer.count }, (_, i) => {
          const k = i + 1;
          const done = finished.find((f) => f.k === k);
          const current = !done && p?.k === k ? p : null;
          return (
            <li className="tl-item" key={k} data-state={done ? 'sealed' : current ? 'due' : 'pending'}>
              <span className="ico" aria-hidden="true">
                {done ? <LockIcon size={16} /> : current ? <span className="spinner" /> : <span className="mono tiny">{k}</span>}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="title">Installment {k}</div>
                <div className="meta">
                  {done && (
                    <>
                      {done.rungsTotal} rungs (heights {done.window[0].toLocaleString('en-US')}–{done.window[1].toLocaleString('en-US')}) · sealed {(done.sealedBytes ?? PACKAGE_BYTES) / 1024} KiB · opens at round{' '}
                      {done.release_round.toLocaleString('en-US')}
                    </>
                  )}
                  {current &&
                    (current.phase === 'sign' ? (
                      <>
                        signing rung {current.rungsDone + 1} of {current.rungsTotal} · heights {current.window[0].toLocaleString('en-US')}–{current.window[1].toLocaleString('en-US')}
                      </>
                    ) : (
                      PHASE_TEXT[current.phase]
                    ))}
                  {!done && !current && 'waiting'}
                </div>
              </div>
              {done ? <Badge tone="sealed">Sealed</Badge> : current ? <Badge tone="amber">Working</Badge> : <span />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- the moment

export function DoneMoment({ offer, flow, children }: { offer: Offer; flow: FlowState; children?: ReactNode }) {
  const finished = flow.finished ?? [];
  const first = finished[0];
  const firstAt = first ? roundTime(first.release_round) : null;
  return (
    <div className="stack" style={{ ['--gap' as string]: '26px' }}>
      <div className="done-hero">
        <div className="done-mark" aria-hidden="true">
          <span className="halo" />
          <svg viewBox="0 0 92 92">
            <circle className="ring" cx="46" cy="46" r="44" />
            <path className="check" d="M28 47.5 41 60l23-27" />
          </svg>
        </div>
        <h2 className="done-title">You can close this tab now.</h2>
        <p className="lede done-sub center" style={{ marginInline: 'auto' }}>
          All {offer.count} installments are signed, sealed and with the runner. Each one opens only when drand publishes its round
          {firstAt ? (
            <>
              ; the first is due <strong className="text-2">{formatRelative(firstAt - nowSecs())}</strong>
            </>
          ) : null}
          . Nothing on your side needs to keep running.
        </p>
      </div>

      <div className="envelopes" aria-label="Sealed installments">
        {finished.map((f, i) => (
          <div className="envelope" key={f.k} style={{ animationDelay: `${0.9 + i * 0.09}s` }}>
            <div className="k">
              <span>#{f.k}</span>
              <LockIcon size={13} />
            </div>
            <div className="when">
              <Countdown at={roundTime(f.release_round)} />
            </div>
            <div className="round">round {f.release_round.toLocaleString('en-US')}</div>
          </div>
        ))}
      </div>

      <div className="fit-grid">
        {[
          ['When a round passes', 'drand publishes its signature, which is the key to that one package. The runner opens it, adds a fresh anchor, proves and broadcasts.'],
          ['What the runner cannot do', 'Change the amount or recipient, open a package early, or spend your pocket any other way.'],
          ['What your wallet shows', 'Only the one funding payment. Installments come from the pocket, not from your wallet.'],
        ].map(([t, d]) => (
          <div className="panel" key={t}>
            <div className="h4" style={{ marginBottom: 4 }}>
              {t}
            </div>
            <p className="small text-2">{d}</p>
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- cancel

/** A testnet UA of the right shape for demos; it has no valid checksum, so nothing can pay it. */
export function demoRefundUa(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(104));
  return `utest1${Array.from(bytes, (b) => BECH32_CHARS[b & 31]).join('')}`;
}

export function CancelPanel({ signer, disabled, onCancelled, showDemo }: { signer: Signer; disabled?: string; onCancelled: (r: CancelReceipt) => void; showDemo?: boolean }) {
  const [ua, setUa] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<Error>();
  const valid = isUnifiedAddress(ua.trim(), 'test');
  useNow();

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onCancelled(await signer.cancel(ua.trim()));
    } catch (e) {
      setError(e as Error);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ ['--gap' as string]: '12px' }}>
      <p className="small text-2">
        Cancelling spends your pocket's current note to an address of your own, with no outgoing-viewing record. Every later installment then spends a note that no longer exists: no
        node will accept it, and the runner marks the subscription cancelled.
      </p>
      <div className="field">
        <label htmlFor="refund-ua">Refund to (an address in your own wallet)</label>
        <input id="refund-ua" className="input mono" value={ua} onChange={(e) => setUa(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" disabled={!!disabled || busy} />
        {showDemo && (
          <button type="button" className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setUa(demoRefundUa())} disabled={!!disabled}>
            Use a demo refund address
          </button>
        )}
      </div>
      {disabled && <Callout kind="plain">{disabled}</Callout>}
      {error && <ErrorNote error={error} />}
      {confirm ? (
        <div className="row" style={{ ['--gap' as string]: '8px' }}>
          <button type="button" className="btn danger" onClick={go} disabled={busy}>
            {busy ? 'Broadcasting the cancel…' : 'Yes, cancel and refund'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)} disabled={busy}>
            Keep the subscription
          </button>
        </div>
      ) : (
        <button type="button" className="btn danger" onClick={() => setConfirm(true)} disabled={!valid || !!disabled}>
          Cancel subscription
        </button>
      )}
    </div>
  );
}

export function CancelReceiptView({ receipt, network = 'test' }: { receipt: CancelReceipt; network?: Offer['network'] }) {
  return (
    <Callout kind="ok">
      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <strong>Cancel broadcast.</strong>
        <span className="small">
          {formatZec(receipt.refunded_zat, network)} returns to your address (fee {formatZec(receipt.fee_zat, network)}), targeting block {receipt.target_height.toLocaleString('en-US')}.
        </span>
        <span className="small row" style={{ ['--gap' as string]: '6px' }}>
          txid <Txid value={receipt.txid} />
        </span>
        <span className="tiny muted">The merchant learns that you cancelled. It cannot see where the refund went.</span>
      </div>
    </Callout>
  );
}

export function PayerOffline({ since }: { since: number }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '10px', alignItems: 'center' }}>
      <TabIcon size={28} />
      <div className="h3">Tab closed</div>
      <p className="small muted">Payer offline since {formatDateTime(since)}. No payer code is running.</p>
    </div>
  );
}
