import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CreateOfferRequest, CreateOfferResponse, NetworkId, Offer, RunnerStatus, Subscription, SubscriptionStatus } from '../api/types';
import { InstallmentTable } from '../components/InstallmentTable';
import { LinkIcon, ServerIcon } from '../components/Icons';
import { Qr } from '../components/Qr';
import { Badge, Callout, CopyButton, Countdown, ErrorNote, PageHead, Spinner, Stat, StatusBadge, Txid } from '../components/ui';
import { createStore, useDocumentTitle, useNow, usePoll, useStore } from '../hooks';
import { isUnifiedAddress, shorten, uaPrefix } from '../lib/addresses';
import { roundAt } from '../lib/drand';
import { hasFeature } from '../lib/features';
import { LIMITS, MAX_HORIZON_DAYS, maxCountWithinHorizon, parseOfferFragment } from '../lib/offer';
import { aTrial, formatMoney, formatTrial, parseQuote, parseTrial, type Quote } from '../lib/terms';
import { formatDate, formatPeriod } from '../lib/time';
import { formatZec, parseZecToZat, totalPrepaidZat, unitFor, INSTALLMENT_FEE_ZAT } from '../lib/zat';
import { Link } from '../router';
import { api, isMock, mockHooks } from '../runtime';

/** The most installments the runner's `POST /api/offers` accepts (crates/cadence-runner/src/api.rs, create_offer). */
const OFFER_COUNT_MAX = 12;

/** The merchant's bearer token: in this tab's memory only, never persisted. */
const session = createStore(() => ({ token: isMock ? 'mock-merchant-token' : '' }));

export const STOP_NEEDS_TOKEN = 'merchant token required (not available in the demo)';

/**
 * Why Stop is disabled, or undefined. A sandbox runner's merchant is its own demo wallet, and
 * the demo hands out no token for it, so without one entered Stop could only fail with a 401.
 */
export function stopBlocked(status: Pick<RunnerStatus, 'sandbox'> | undefined, token: string): string | undefined {
  return status?.sandbox && !token.trim() ? STOP_NEEDS_TOKEN : undefined;
}

/**
 * The optional terms a v2 runner takes with an offer: a trial only when there is one, and the
 * merchant's fiat label stamped now. The form computes neither unless the runner lists its feature.
 */
export function offerTerms(trialSecs: number, quote: Omit<Quote, 'set_at'> | null, setAt: number): Pick<CreateOfferRequest, 'trial_secs' | 'quote'> {
  return { ...(trialSecs > 0 ? { trial_secs: trialSecs } : {}), ...(quote ? { quote: { ...quote, set_at: Math.floor(setAt) } } : {}) };
}

const FILTERS: Array<{ id: 'all' | SubscriptionStatus; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'stalled', label: 'Stalled' },
  { id: 'stopped', label: 'Stopped' },
];

const offerCache = new Map<string, Promise<Offer | null>>();
function fetchOffer(id: string): Promise<Offer | null> {
  let p = offerCache.get(id);
  if (!p) {
    p = api.getOffer(id).catch(() => null);
    offerCache.set(id, p);
  }
  return p;
}

function useOffer(id: string): Offer | null | undefined {
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetchOffer(id).then((o) => alive && setOffer(o));
    return () => {
      alive = false;
    };
  }, [id]);
  return offer;
}

function nextRelease(sub: Subscription): number | null {
  const s = sub.installments.find((i) => i.state === 'sealed');
  return s ? s.release_at : null;
}

function SubscriptionCard({ sub, defaultOpen, onChanged, blocked }: { sub: Subscription; defaultOpen: boolean; onChanged: () => void; blocked?: string }) {
  const offer = useOffer(sub.offer_id);
  const provenance = mockHooks?.provenanceOf(sub.subscription_id);
  const [open, setOpen] = useState(defaultOpen || !!provenance?.startsWith('Real'));
  const [confirming, setConfirming] = useState(false);
  const [stopError, setStopError] = useState<Error>();
  const [stopping, setStopping] = useState(false);
  const { token } = useStore(session);
  const mined = sub.installments.filter((i) => i.state === 'mined').length;
  const next = nextRelease(sub);
  const network = offer?.network ?? 'test';
  const canStop = sub.status === 'active' || sub.status === 'stalled';

  const stop = async () => {
    setStopping(true);
    setStopError(undefined);
    try {
      await api.stopSubscription(sub.subscription_id, token);
      setConfirming(false);
      onChanged();
    } catch (e) {
      setStopError(e as Error);
    } finally {
      setStopping(false);
    }
  };

  return (
    <article className="sub-card">
      <button type="button" className="sub-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ ['--gap' as string]: '10px' }}>
            <span className="title">{offer?.name ?? sub.offer_id}</span>
            <StatusBadge status={sub.status} />
            {provenance?.startsWith('Real') && <Badge tone="sealed">evidence</Badge>}
          </div>
          <div className="sub-meta">
            <span>{sub.subscription_id}</span>
            {offer && (
              <span>
                {formatZec(offer.amount_zat, network)} {formatPeriod(offer.period_secs)} × {offer.count}
              </span>
            )}
            <span>
              {mined}/{sub.installments.length} mined
            </span>
            {next && (
              <span>
                next <Countdown at={next} />
              </span>
            )}
          </div>
        </div>
        <div className="sub-progress" aria-label={`${mined} of ${sub.installments.length} installments mined`}>
          {sub.installments.map((i) => (
            <i key={i.k} data-state={i.state} title={`Installment ${i.k}: ${i.state}`} />
          ))}
        </div>
      </button>
      {open && (
        <div className="sub-body">
          <InstallmentTable installments={sub.installments} network={network} />
          <div className="sub-foot">
            <div className="row" style={{ ['--gap' as string]: '6px 16px' }}>
              <span>
                Funded <span className="mono text-2">{formatZec(sub.funding.amount_zat, network)}</span>
              </span>
              <span className="row" style={{ ['--gap' as string]: '6px' }}>
                funding <Txid value={sub.funding.txid} />
                {sub.funding.mined_height ? <span className="mono">@ {sub.funding.mined_height.toLocaleString('en-US')}</span> : <span className="mono">mempool</span>}
              </span>
              <span>created {formatDate(sub.created_at)}</span>
            </div>
            {canStop &&
              (blocked ? (
                <span className="row" style={{ ['--gap' as string]: '8px' }}>
                  <button type="button" className="btn sm" disabled aria-describedby={`stop-why-${sub.subscription_id}`}>
                    Stop subscription
                  </button>
                  <span id={`stop-why-${sub.subscription_id}`} className="tiny muted">
                    {blocked}
                  </span>
                </span>
              ) : confirming ? (
                <span className="row" style={{ ['--gap' as string]: '8px' }}>
                  <span className="small">The runner discards the remaining packages and shreds the pocket data.</span>
                  <button type="button" className="btn sm danger" onClick={stop} disabled={stopping}>
                    {stopping ? 'Stopping…' : 'Confirm stop'}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="btn sm" onClick={() => setConfirming(true)}>
                  Stop subscription
                </button>
              ))}
          </div>
          {provenance && (
            <div className="sub-foot" style={{ background: 'transparent' }}>
              <span className="tiny">
                <span className="tag">{provenance.startsWith('Real') ? 'evidence' : 'mock'}</span> {provenance}
              </span>
            </div>
          )}
          {stopError && (
            <div style={{ padding: '0 18px 14px' }}>
              <ErrorNote error={stopError} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

const PERIODS = [
  { secs: 3600, label: 'Hourly' },
  { secs: 86400, label: 'Daily' },
  { secs: 604800, label: 'Weekly' },
  { secs: 2592000, label: 'Monthly (30 days)' },
  { secs: 0, label: 'Custom…' },
];

/**
 * Why `ua` cannot receive installments from a runner on `network`, or undefined if it
 * can. The runner checks it again; until its network is known nothing is accepted.
 */
export function merchantUaProblem(ua: string, network: NetworkId | undefined): string | undefined {
  if (!network) return 'Waiting for the runner to say which network it is on.';
  if (isUnifiedAddress(ua, network)) return undefined;
  const name = (net: NetworkId) => (net === 'main' ? 'mainnet' : 'testnet');
  const want = `A ${name(network)} unified address (${uaPrefix(network)}…) with an Orchard receiver`;
  const other: NetworkId = network === 'main' ? 'test' : 'main';
  return isUnifiedAddress(ua, other) ? `${want}. This is a ${name(other)} address, and this runner is on ${name(network)}.` : `${want}.`;
}

function CreateOffer({ network, status }: { network: NetworkId | undefined; status: RunnerStatus | undefined }) {
  const { token } = useStore(session);
  // Trial and quote go to a runner only when it lists them; an older one sees the form it always did.
  const trialOn = hasFeature(status, 'trial');
  const quoteOn = hasFeature(status, 'quote');
  const [name, setName] = useState('Shielded Press · monthly');
  const [amount, setAmount] = useState('0.005');
  const [period, setPeriod] = useState(2592000);
  const [customPeriod, setCustomPeriod] = useState('60');
  // Two months, not three: the last installment must fall due within the signer's horizon.
  const [count, setCount] = useState('2');
  const [ua, setUa] = useState(mockHooks?.demoMerchantUa ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [result, setResult] = useState<CreateOfferResponse>();
  const [touched, setTouched] = useState(false);
  const [trial, setTrial] = useState('0');
  const [trialUnit, setTrialUnit] = useState(86400);
  const [priceIn, setPriceIn] = useState<'zec' | 'fiat'>('zec');
  const [currency, setCurrency] = useState('USD');
  const [price, setPrice] = useState('5.00');
  // No default rate: it is the merchant's own figure, and the page fetches no price feed.
  const [rate, setRate] = useState('');

  const unit = unitFor(network ?? 'test');
  const fiat = quoteOn && priceIn === 'fiat';
  const quoted = fiat ? parseQuote({ currency, price, rate }, network ?? 'test') : null;
  const amountZat = quoted ? (quoted.ok ? quoted.amountZat : null) : parseZecToZat(amount);
  const trialParse = trialOn ? parseTrial(trial, trialUnit) : { secs: 0 };
  const trialSecs = 'secs' in trialParse ? trialParse.secs : 0;
  const periodSecs = period === 0 ? Number(customPeriod) : period;
  const countN = Number(count);
  const problems: Record<string, string> = {};
  if (!name.trim()) problems.name = 'Give the plan a name payers will recognise.';
  if (name.length > LIMITS.nameMax) problems.name = `At most ${LIMITS.nameMax} characters.`;
  if (quoted) {
    if (!quoted.ok) Object.assign(problems, quoted.problems);
  } else if (amountZat === null || amountZat < 1) problems.amount = 'A positive amount with at most 8 decimals.';
  if ('problem' in trialParse) problems.trial = trialParse.problem;
  if (!Number.isSafeInteger(periodSecs) || periodSecs < LIMITS.periodMin || periodSecs > LIMITS.periodMax) problems.period = `Between ${LIMITS.periodMin} seconds and 366 days.`;
  if (!Number.isSafeInteger(countN) || countN < LIMITS.countMin || countN > OFFER_COUNT_MAX) problems.count = `Between ${LIMITS.countMin} and ${OFFER_COUNT_MAX}.`;
  const periodOk = !problems.period;
  // The trial counts towards the horizon: the last installment falls due trial + lead + (count - 1) periods after signing.
  const horizonMax = periodOk ? maxCountWithinHorizon(periodSecs, trialSecs) : null;
  const maxCount = horizonMax ? Math.min(horizonMax, OFFER_COUNT_MAX) : null;
  const atMost = maxCount ? `at most ${maxCount} installment${maxCount === 1 ? '' : 's'}, one ${formatPeriod(periodSecs)}${trialSecs ? `, after ${aTrial(trialSecs)} trial` : ''}` : '';
  if (!problems.count && horizonMax && countN > horizonMax) {
    problems.count = `Make it ${atMost}: Cadence cannot yet seal a payment due more than ${MAX_HORIZON_DAYS} days after the payer signs.`;
  }
  const uaProblem = merchantUaProblem(ua.trim(), network);
  if (uaProblem) problems.ua = uaProblem;
  const valid = Object.keys(problems).length === 0;
  const show = (k: string) => (touched ? problems[k] : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || amountZat === null) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const terms = offerTerms(trialSecs, quoted?.ok ? quoted.quote : null, Date.now() / 1000);
      setResult(await api.createOffer({ name: name.trim(), amount_zat: amountZat, period_secs: periodSecs, count: countN, merchant_ua: ua.trim(), ...terms }, token));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  const shareFragment = result ? new URL(result.share_url).hash : '';
  const decoded = useMemo(() => (shareFragment ? parseOfferFragment(shareFragment) : null), [shareFragment]);
  const sameOrigin = result ? new URL(result.share_url).origin === location.origin : false;
  const payerPath = result && sameOrigin ? new URL(result.share_url).pathname + shareFragment : null;

  return (
    <section className="card" aria-labelledby="create-offer">
      <div className="stack" style={{ ['--gap' as string]: '6px', marginBottom: 18 }}>
        <span className="kicker">New plan</span>
        <h2 id="create-offer" className="h3">
          Create an offer
        </h2>
        <p className="small muted">The share link carries the offer after the #. Browsers never send that part to any server.</p>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="o-name">Plan name</label>
          <input id="o-name" className="input" value={name} maxLength={LIMITS.nameMax} onChange={(e) => setName(e.target.value)} aria-invalid={!!show('name')} />
          {show('name') && <span className="error-text">{show('name')}</span>}
        </div>
        {quoteOn && (
          <div className="field">
            <label htmlFor="o-price-in">Price in</label>
            <select id="o-price-in" className="select" value={priceIn} onChange={(e) => setPriceIn(e.target.value === 'fiat' ? 'fiat' : 'zec')}>
              <option value="zec">{unit}</option>
              <option value="fiat">A currency, at your own rate</option>
            </select>
          </div>
        )}
        {fiat && (
          <div className="grid cols-2" style={{ ['--gap' as string]: '12px' }}>
            <div className="field">
              <label htmlFor="o-currency">Currency</label>
              <input
                id="o-currency"
                className="input mono"
                value={currency}
                maxLength={3}
                autoCapitalize="characters"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                aria-invalid={!!show('currency')}
              />
              {show('currency') ? <span className="error-text">{show('currency')}</span> : <span className="hint">A three-letter code: USD, EUR, GBP…</span>}
            </div>
            <div className="field">
              <label htmlFor="o-rate">Your rate</label>
              <div className="input-group">
                <input id="o-rate" className="input mono" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="42.10" aria-invalid={!!show('rate')} />
                <span className="suffix nowrap">per {unit}</span>
              </div>
              {show('rate') ? <span className="error-text">{show('rate')}</span> : <span className="hint">Your own figure: no price feed is asked.</span>}
            </div>
          </div>
        )}
        <div className="grid cols-2" style={{ ['--gap' as string]: '12px' }}>
          {fiat ? (
            <div className="field">
              <label htmlFor="o-price">Price per installment</label>
              <div className="input-group">
                <input id="o-price" className="input mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!!(show('price') || show('amount'))} />
                <span className="suffix">{currency.trim().toUpperCase() || '…'}</span>
              </div>
              {show('price') || show('amount') ? (
                <span className="error-text">{show('price') ?? show('amount')}</span>
              ) : (
                quoted?.ok && <span className="hint">≈ {formatZec(quoted.amountZat, network)} per payment at your rate. Payers sign this amount.</span>
              )}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="o-amount">Amount per installment</label>
              <div className="input-group">
                <input id="o-amount" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!show('amount')} />
                <span className="suffix">{unit}</span>
              </div>
              {show('amount') && <span className="error-text">{show('amount')}</span>}
            </div>
          )}
          <div className="field">
            <label htmlFor="o-count">Installments</label>
            <input id="o-count" className="input mono" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} aria-invalid={!!show('count')} />
            {show('count') ? (
              <span className="error-text">{show('count')}</span>
            ) : (
              <span className="hint">
                The last must fall due within {MAX_HORIZON_DAYS} days of signing{trialSecs ? ', trial included' : ''}
                {atMost ? `: ${atMost}` : ''}.
              </span>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="o-period">Every</label>
          <select id="o-period" className="select" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
            {PERIODS.map((p) => (
              <option key={p.secs} value={p.secs}>
                {p.label}
              </option>
            ))}
          </select>
          {period === 0 && (
            <div className="input-group">
              <input className="input mono" inputMode="numeric" value={customPeriod} onChange={(e) => setCustomPeriod(e.target.value)} aria-label="Period in seconds" aria-invalid={!!show('period')} />
              <span className="suffix">seconds</span>
            </div>
          )}
          {show('period') && <span className="error-text">{show('period')}</span>}
        </div>
        {trialOn && (
          <div className="field">
            <label htmlFor="o-trial">Free trial</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
              <input id="o-trial" className="input mono" inputMode="numeric" value={trial} onChange={(e) => setTrial(e.target.value)} aria-invalid={!!show('trial')} />
              <select className="select" aria-label="Trial unit" value={trialUnit} onChange={(e) => setTrialUnit(Number(e.target.value))}>
                <option value={86400}>days</option>
                <option value={3600}>hours</option>
              </select>
            </div>
            {show('trial') ? (
              <span className="error-text">{show('trial')}</span>
            ) : (
              <span className="hint">Installment 1 releases this long after the payer signs. 0 for none, up to 30 days.</span>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="o-ua">Your receiving address</label>
          <input id="o-ua" className="input mono" value={ua} onChange={(e) => setUa(e.target.value)} placeholder={network ? `${uaPrefix(network)}…` : undefined} spellCheck={false} autoComplete="off" aria-invalid={!!show('ua')} />
          <span className="hint">Orchard-only unified address. Installments pay here with no outgoing-viewing record.</span>
          {show('ua') && <span className="error-text">{show('ua')}</span>}
        </div>
        <div className="field">
          <label htmlFor="o-token">Runner bearer token</label>
          <input
            id="o-token"
            className="input mono"
            type="password"
            value={token}
            onChange={(e) => session.set({ token: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="hint">Kept in this tab's memory only. {isMock && 'The mock runner accepts any non-empty token.'}</span>
        </div>
        {amountZat !== null && valid && (
          <div className="panel small text-2">
            Each payer prepays{' '}
            <strong className="mono">
              {countN} × ({formatZec(amountZat, network)} + {formatZec(INSTALLMENT_FEE_ZAT, network)} fee) = {formatZec(totalPrepaidZat(amountZat, countN), network)}
            </strong>{' '}
            into a pocket only they can spend.
            {trialSecs > 0 && ` Installment 1 waits out the ${formatTrial(trialSecs)} trial; a payer who cancels before then gets it all back, less a network fee.`}
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create offer and share link'}
        </button>
      </form>

      {error && (
        <div style={{ marginTop: 14 }}>
          <ErrorNote error={error} />
        </div>
      )}

      {result && (
        <div className="stack" style={{ marginTop: 20, ['--gap' as string]: '12px' }} aria-live="polite">
          <hr />
          <div className="row between">
            <span className="h4 row" style={{ ['--gap' as string]: '8px' }}>
              <LinkIcon size={15} /> Share link
            </span>
            <Badge tone="green" dot>
              {result.offer_id}
            </Badge>
          </div>
          <div className="code-block" style={{ maxHeight: 120, overflow: 'auto' }}>
            <span className="muted">{result.share_url.split('#')[0]}</span>
            <span className="text-2">#{result.share_url.split('#')[1]}</span>
          </div>
          <div className="row" style={{ ['--gap' as string]: '8px' }}>
            <CopyButton text={result.share_url} label="Copy share link" />
            <span className="small muted">Copy link</span>
            {payerPath && (
              <Link to={payerPath} className="btn sm" style={{ marginLeft: 'auto' }}>
                Open as payer
              </Link>
            )}
          </div>
          <div className="row top" style={{ ['--gap' as string]: '16px' }}>
            <Qr value={result.share_url} label="QR code of the share link" size={176} />
            <div className="small text-2" style={{ flex: '1 1 160px' }}>
              <p>
                Everything after <code>#</code> stays in the payer's browser, so no web host sees the offer itself. Opening the link is not anonymous: the page asks your runner for
                its copy of the offer by id, so the runner and its hosting edge see the payer's IP address and which offer was opened.
              </p>
              {decoded?.ok && (
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  Decoded: {decoded.offer.name}, {formatZec(decoded.offer.amount_zat, decoded.offer.network)} {formatPeriod(decoded.offer.period_secs)} × {decoded.offer.count}
                  {decoded.offer.trial_secs ? ` after ${aTrial(decoded.offer.trial_secs)} trial` : ''}
                  {decoded.offer.quote ? `, labelled ${formatMoney(decoded.offer.quote.amount_minor, decoded.offer.quote.currency)}` : ''}, runner key{' '}
                  {shorten(decoded.offer.runner_age_recipient, 8, 4)}.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Integrate() {
  return (
    <section className="card flat" aria-labelledby="integrate">
      <div className="stack" style={{ ['--gap' as string]: '10px' }}>
        <span className="kicker">Integrate</span>
        <h2 id="integrate" className="h3">
          Webhooks, with CipherPay's signature
        </h2>
        <p className="small text-2">
          The runner signs each POST twice with your webhook secret: its own header, and CipherPay's three headers computed as CipherPay computes them, so CipherPay's verification code
          accepts them. The body's <code>event</code> carries CipherPay's event name. The rest of the body is Cadence's: an installment is <code>subscription_id</code> and <code>k</code>,
          with no <code>invoice_id</code>.
        </p>
        <div className="code-block tiny">X-Cadence-Signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256(secret, "&lt;t&gt;.&lt;body&gt;")&gt;</div>
        <div className="code-block tiny">X-CipherPay-Signature: &lt;hex HMAC-SHA256(secret, "&lt;X-CipherPay-Timestamp&gt;.&lt;body&gt;")&gt;</div>
        <table className="data events">
          <tbody>
            <tr>
              <td className="mono">invoice.confirmed · confirmed</td>
              <td className="small muted">an installment is mined</td>
            </tr>
            <tr>
              <td className="mono">invoice.expired · expired</td>
              <td className="small muted">an installment was missed (its window passed with no rung) or invalid (its package did not match the offer); nothing was broadcast. The payer can cancel or sweep, and subscribe again</td>
            </tr>
            <tr>
              <td className="mono">invoice.cancelled · subscription.canceled</td>
              <td className="small muted">the payer spent the pocket</td>
            </tr>
          </tbody>
        </table>
        <p className="tiny muted">
          At most 3 attempts (at once, then 30 s and 2 min after each failure), from the runner's memory: there is no outbox, so reconcile from the subscription API. Dedupe on <code>delivery_id</code>.
          Details in docs/api.md.
        </p>
      </div>
    </section>
  );
}

export function Merchant() {
  useDocumentTitle('Merchant');
  const now = useNow();
  const status = usePoll((s) => api.status(s), 5000);
  const subs = usePoll((s) => api.listSubscriptions(session.get().token || undefined, s), isMock ? 2000 : 10000);
  const { token } = useStore(session);
  const blocked = stopBlocked(status.data, token);
  const [filter, setFilter] = useState<'all' | SubscriptionStatus>('all');

  const list = subs.data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.length };
    for (const s of list) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [list]);
  const shown = filter === 'all' ? list : list.filter((s) => s.status === filter);
  const nextAt = list
    .flatMap((s) => s.installments.filter((i) => i.state === 'sealed').map((i) => i.release_at))
    .sort((a, b) => a - b)[0];

  return (
    <div className="page container">
      <PageHead
        kicker="Merchant"
        title="Subscriptions"
        lede="Every installment your runner holds, from sealed to mined. Countdowns run to each installment's drand round; until then not even the runner can read it."
      />

      <div className="stat-strip" style={{ marginBottom: 24 }}>
        <Stat label="Network" value={status.data ? (status.data.network === 'main' ? 'Mainnet' : 'Testnet') : '…'} sub={isMock ? 'mock runner' : 'runner'} />
        <Stat label="Chain tip" value={status.data ? status.data.tip.toLocaleString('en-US') : '…'} sub={isMock ? `mock · ${mockHooks?.blockSecs} s blocks` : 'as the runner sees it'} />
        <Stat label="drand round" value={roundAt(now).toLocaleString('en-US')} sub="quicknet · every 3 s" />
        <Stat label="Next release" value={nextAt ? <Countdown at={nextAt} /> : '—'} sub={`${counts.active ?? 0} active · ${list.length} total`} />
      </div>

      <div className="grid aside" style={{ ['--gap' as string]: '24px' }}>
        <div className="stack" style={{ ['--gap' as string]: '14px', minWidth: 0 }}>
          <div className="row between">
            <div className="segmented" role="group" aria-label="Filter by status">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="count">{counts[f.id] ?? 0}</span>
                </button>
              ))}
            </div>
            {subs.loading && !subs.data && <Spinner label="Loading" />}
          </div>
          {subs.error && <ErrorNote error={subs.error} retry={subs.refresh} />}
          {subs.data && shown.length === 0 && (
            <div className="card empty-state">
              <ServerIcon size={22} />
              <span>No {filter === 'all' ? '' : `${filter} `}subscriptions yet.</span>
            </div>
          )}
          <div>
            {shown.map((s) => (
              <SubscriptionCard key={s.subscription_id} sub={s} defaultOpen={s.status === 'active' || s.status === 'stalled'} onChanged={subs.refresh} blocked={blocked} />
            ))}
          </div>
          {isMock && (
            <Callout kind="plain">
              <span className="small">
                Rows marked <span className="tag">evidence</span> carry the real txids and heights of the S2 run on NU7 testnet; their txid links decode the real shapes. Everything else
                is synthetic. The weekly stipend's third installment releases about a minute after this page loads, so you can watch sealed → due → broadcast → mined.
              </span>
            </Callout>
          )}
        </div>
        <div className="stack" style={{ ['--gap' as string]: '16px' }}>
          <CreateOffer network={status.data?.network} status={status.data} />
          <Integrate />
        </div>
      </div>
    </div>
  );
}
