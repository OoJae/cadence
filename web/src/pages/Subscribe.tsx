import { useEffect, useMemo, useState } from 'react';
import type { Offer } from '../api/types';
import { SaveCancelKey } from '../components/CancelKey';
import { CancelPanel, CancelReceiptView, DoneMoment, FundingView, SigningView } from '../components/FlowViews';
import { KeyIcon, ShieldCheckIcon } from '../components/Icons';
import { MerchantLearns } from '../components/MerchantLearns';
import { Timeline } from '../components/Timeline';
import { Badge, Callout, CopyButton, ErrorNote, Round, Spinner, StatusBadge } from '../components/ui';
import { runMandate, type FlowState } from '../flow';
import { createStore, useDocumentTitle, useNow, usePoll, useStore } from '../hooks';
import { shorten } from '../lib/addresses';
import { encodeOfferPayload, parseOfferFragment } from '../lib/offer';
import { planSchedule } from '../lib/schedule';
import { formatDateTime, formatPeriod, formatRelative } from '../lib/time';
import { formatZec, INSTALLMENT_FEE_ZAT, totalPrepaidZat } from '../lib/zat';
import { Link, useLocation } from '../router';
import { api, apiLabel, apiSetting, createSigner, isMock, mockHooks } from '../runtime';
import type { SealedKit } from '../signer/kit';
import type { CancelReceipt, Signer } from '../signer/types';

type Step = 'plan' | 'fund' | 'sign' | 'done' | 'manage';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'fund', label: 'Fund' },
  { id: 'sign', label: 'Sign' },
  { id: 'done', label: 'Done' },
  { id: 'manage', label: 'Manage' },
];

interface Session extends FlowState {
  hash: string;
  signer: Signer | null;
  abort: AbortController | null;
  lastStep: Step;
  manage: boolean;
  cancel: CancelReceipt | null;
  /** The encrypted cancel key, once saved (ciphertext only, for "download again"). */
  kit: SealedKit | null;
}

/** In memory only: survives in-app navigation (e.g. to the decoder), never a reload. */
const session = createStore<Session>(() => ({ hash: '', phase: 'idle', signer: null, abort: null, lastStep: 'plan', manage: false, cancel: null, kit: null }));

/** Only the WASM signer's pocket can be cancelled after the tab closes, so only it asks for a cancel key. */
const needsCancelKey = (s: Session) => s.signer?.implementation === 'wasm';

function stepOf(s: Session): Step {
  switch (s.phase) {
    case 'idle':
      return 'plan';
    case 'pocket':
    case 'funding':
      return 'fund';
    case 'signing':
    case 'uploading':
      return 'sign';
    case 'done':
      return s.manage ? 'manage' : 'done';
    case 'error':
      return s.lastStep;
  }
}

function resetSession(hash: string) {
  const s = session.get();
  s.abort?.abort();
  s.signer?.destroy();
  session.reset();
  session.set({ hash });
}

function start(offer: Offer) {
  const s = session.get();
  if (s.phase !== 'idle' && s.phase !== 'error') return;
  s.signer?.destroy();
  const signer = createSigner();
  const abort = new AbortController();
  session.set({ signer, abort, phase: 'pocket', error: undefined, lastStep: 'fund', manage: false, cancel: null, kit: null });
  void runMandate(
    offer,
    signer,
    (patch) => {
      const step = patch.phase && patch.phase !== 'error' ? stepOf({ ...session.get(), ...patch } as Session) : undefined;
      session.set({ ...patch, ...(step ? { lastStep: step } : {}) });
    },
    { signal: abort.signal },
  );
}

/** Checks the link's offer against the runner's own copy, and that this build may talk to that runner. */
function useVerifiedOffer(offer: Offer | null) {
  const [state, setState] = useState<{ status: 'checking' | 'ok' | 'bad'; message?: string }>({ status: 'checking' });
  useEffect(() => {
    if (!offer) return;
    let alive = true;
    setState({ status: 'checking' });
    if (apiSetting.kind === 'http') {
      const expected = apiSetting.origin ?? location.origin;
      let named = '';
      try {
        named = new URL(offer.runner_endpoint).origin;
      } catch {
        /* validated already */
      }
      if (named !== expected) {
        setState({ status: 'bad', message: `This offer names the runner ${offer.runner_endpoint}, but this page is built to talk only to ${expected}. Open the link on that runner's own page.` });
        return;
      }
    } else {
      mockHooks?.adoptOffer(offer);
    }
    api
      .getOffer(offer.offer_id)
      .then((remote) => {
        if (!alive) return;
        if (encodeOfferPayload(remote) !== encodeOfferPayload(offer)) setState({ status: 'bad', message: "The link's offer does not match the runner's copy. Do not subscribe; ask the merchant for a new link." });
        else setState({ status: 'ok' });
      })
      .catch((e: Error) => alive && setState({ status: 'bad', message: `The runner could not confirm this offer: ${e.message}` }));
    return () => {
      alive = false;
    };
  }, [offer]);
  return state;
}

function Stepper({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.id} data-state={i < idx ? 'done' : i === idx ? 'current' : 'todo'} aria-current={i === idx ? 'step' : undefined}>
          <span className="n">{i < idx ? '✓' : i + 1}</span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function PlanStep({ offer, verified }: { offer: Offer; verified: ReturnType<typeof useVerifiedOffer> }) {
  const now = useNow();
  const schedule = useMemo(() => planSchedule(offer, Math.floor(now / 10) * 10), [offer, Math.floor(now / 10)]);
  const total = totalPrepaidZat(offer.amount_zat, offer.count);
  return (
    <div className="stack" style={{ ['--gap' as string]: '22px' }}>
      <div>
        <div className="display" style={{ fontSize: 'clamp(30px, 4.6vw, 44px)' }}>
          {formatZec(offer.amount_zat, offer.network)} <span className="muted">{formatPeriod(offer.period_secs)}</span>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          {offer.count} installments · you prepay <span className="mono text-2">{formatZec(total, offer.network)}</span> once, including{' '}
          {formatZec(INSTALLMENT_FEE_ZAT * offer.count, offer.network)} in network fees
        </div>
      </div>

      <dl className="kv">
        <dt>Pays to</dt>
        <dd className="row" style={{ ['--gap' as string]: '6px' }}>
          <span className="mono small">{shorten(offer.merchant_ua, 14, 8)}</span>
          <CopyButton text={offer.merchant_ua} label="Copy merchant address" />
        </dd>
        <dt>Runner</dt>
        <dd className="mono small">{isMock ? 'in-page mock runner' : offer.runner_endpoint}</dd>
        <dt>Network</dt>
        <dd>
          <Badge tone={offer.network === 'main' ? 'accent' : 'blue'}>{offer.network === 'main' ? 'Mainnet' : 'Testnet'}</Badge>
        </dd>
        <dt>Offer check</dt>
        <dd>
          {verified.status === 'checking' && <Spinner label="Asking the runner for its copy…" />}
          {verified.status === 'ok' && (
            <span className="row small" style={{ ['--gap' as string]: '6px' }}>
              <ShieldCheckIcon size={15} className="accent" /> Matches the runner's copy of {offer.offer_id}
            </span>
          )}
          {verified.status === 'bad' && <span className="small" style={{ color: 'var(--red)' }}>Failed</span>}
        </dd>
      </dl>

      <div className="card flat pad-0">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Releases (if you sign now)</th>
                <th scope="col">drand round</th>
                <th scope="col" className="r">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {schedule.slice(0, 6).map((i) => (
                <tr key={i.k}>
                  <td className="mono">{i.k}</td>
                  <td>
                    <span className="small">{formatDateTime(i.release_at)}</span> <span className="tiny muted">· {formatRelative(i.release_at - now)}</span>
                  </td>
                  <td>
                    <Round round={i.release_round} />
                  </td>
                  <td className="r mono num">{formatZec(i.amount_zat, offer.network)}</td>
                </tr>
              ))}
              {schedule.length > 6 && (
                <tr>
                  <td colSpan={4} className="small muted">
                    … and {schedule.length - 6} more, {formatPeriod(offer.period_secs)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {verified.status === 'bad' ? (
        <Callout kind="danger">{verified.message}</Callout>
      ) : (
        <div className="stack" style={{ ['--gap' as string]: '10px' }}>
          <button type="button" className="btn primary lg" onClick={() => start(offer)} disabled={verified.status !== 'ok'}>
            Create my pocket and continue
          </button>
          <p className="tiny muted">
            A pocket is a fresh, single-use key made in this tab, never your wallet's seed. Nothing about it leaves the tab until you have paid and the schedule is signed; then only the
            sealed packages and the pocket's view-only key go to the runner.
          </p>
        </div>
      )}
    </div>
  );
}

function ManageStep({ offer, s }: { offer: Offer; s: Session }) {
  const sub = usePoll((signal) => api.getSubscription(s.subscriptionId!, signal), isMock ? 1500 : 10000, [s.subscriptionId]);
  const data = sub.data;
  const settled = data && (data.status === 'completed' || data.status === 'cancelled' || data.status === 'stopped');
  return (
    <div className="stack" style={{ ['--gap' as string]: '20px' }}>
      <div className="row between">
        <div className="stack" style={{ ['--gap' as string]: '2px' }}>
          <span className="h3">Your subscription</span>
          <span className="mono tiny muted">{s.subscriptionId}</span>
        </div>
        {data && <StatusBadge status={data.status} lg />}
      </div>
      {sub.error && <ErrorNote error={sub.error} retry={sub.refresh} />}
      {data ? <Timeline installments={data.installments} network={offer.network} /> : <Spinner label="Asking the runner…" />}
      {needsCancelKey(s) && s.signer && !s.cancel && (
        <SaveCancelKey signer={s.signer} subscriptionId={s.subscriptionId ?? null} saved={s.kit} onSaved={(kit) => session.set({ kit })} />
      )}
      <hr />
      <div className="stack" style={{ ['--gap' as string]: '10px' }}>
        <span className="h4">Cancel</span>
        {s.cancel ? (
          <CancelReceiptView receipt={s.cancel} network={offer.network} />
        ) : (
          s.signer && (
            <CancelPanel
              signer={s.signer}
              showDemo={isMock}
              network={offer.network}
              disabled={
                settled
                  ? data!.status === 'stopped'
                    ? 'The merchant stopped this subscription and the runner deleted the pocket. What is left in it is yours: save your cancel key, then run cadence sweep with it.'
                    : `This subscription is ${data!.status}; there is nothing left to cancel.`
                  : undefined
              }
              onCancelled={(r) => session.set({ cancel: r })}
            />
          )
        )}
      </div>
    </div>
  );
}

export function Subscribe() {
  const { hash } = useLocation();
  const parsed = useMemo(() => parseOfferFragment(hash), [hash]);
  const offer = parsed.ok ? parsed.offer : null;
  const verified = useVerifiedOffer(offer);
  const s = useStore(session);
  useDocumentTitle(offer ? `Subscribe · ${offer.name}` : 'Subscribe');

  useEffect(() => {
    if (session.get().hash !== hash) resetSession(hash);
  }, [hash]);

  if (!parsed.ok) {
    return (
      <div className="page container narrow">
        <div className="card stack" style={{ ['--gap' as string]: '16px' }}>
          <span className="kicker">Subscribe</span>
          <h1 className="h2">This link doesn't carry a usable offer.</h1>
          <ul className="prose small text-2">
            {parsed.problems.map((p, i) => (
              <li key={i}>
                {p.field === 'fragment' ? p.message : <><code>{p.field}</code> {p.message}</>}
              </li>
            ))}
          </ul>
          <p className="small muted">Ask the merchant for a fresh link, or create one yourself on the merchant page.</p>
          <div className="row">
            <Link to="/merchant" className="btn">
              Create an offer
            </Link>
            <Link to="/sandbox" className="btn ghost">
              Or try the sandbox
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const o = parsed.offer;
  const step = s.hash === hash ? stepOf(s) : 'plan';

  return <SubscribeView offer={o} step={step} s={s} hash={hash} verified={verified} />;
}

function SubscribeView({ offer: o, step, s, hash, verified }: { offer: Offer; step: Step; s: Session; hash: string; verified: ReturnType<typeof useVerifiedOffer> }) {
  // Each new step starts at the top, so the "close this tab" moment is never off-screen.
  useEffect(() => {
    if (window.scrollY > 200) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  return (
    <div className="page container">
      <header className="stack" style={{ ['--gap' as string]: '14px', marginBottom: 26 }}>
        <span className="kicker">Subscribe</span>
        <h1 className="h2">{o.name}</h1>
        <Stepper current={step} />
      </header>

      <div className="grid aside" style={{ ['--gap' as string]: '24px' }}>
        <section className="card" aria-live="polite">
          {step === 'plan' && <PlanStep offer={o} verified={verified} />}
          {step === 'fund' && (
            <div className="stack" style={{ ['--gap' as string]: '18px' }}>
              <div className="stack" style={{ ['--gap' as string]: '4px' }}>
                <span className="h3">Fund your pocket</span>
                <span className="small muted">
                  One payment covers every installment.{' '}
                  {s.signer?.implementation === 'wasm' ? 'Signing starts once the payment is mined in a block (the runner only reports mined payments).' : 'Signing starts the moment it reaches the mempool.'}
                </span>
              </div>
              <FundingView offer={o} flow={s} onSimulate={mockHooks && s.pocket && s.totalZat ? () => mockHooks?.simulateWalletPayment(s.pocket!.ua, s.totalZat!) : undefined} />
            </div>
          )}
          {step === 'sign' && <SigningView offer={o} flow={s} />}
          {step === 'done' && (
            <DoneMoment
              offer={o}
              flow={s}
              closeable={!needsCancelKey(s) || !!s.kit}
              notice={
                needsCancelKey(s) && s.signer ? (
                  <SaveCancelKey signer={s.signer} subscriptionId={s.subscriptionId ?? null} saved={s.kit} onSaved={(kit) => session.set({ kit })} />
                ) : undefined
              }
            >
              <div className="row" style={{ justifyContent: 'center', ['--gap' as string]: '10px' }}>
                <button type="button" className="btn" onClick={() => session.set({ manage: true })}>
                  Manage or cancel
                </button>
                {needsCancelKey(s) && (
                  <Link to="/manage" className="btn ghost">
                    Cancel later with your key
                  </Link>
                )}
              </div>
              {!needsCancelKey(s) && s.signer?.keyCustody === 'memory' && (
                <Callout kind="plain" icon={<KeyIcon size={16} />}>
                  <span className="small">
                    Closing this tab is safe: payments continue without you. In this mock build the pocket key lives only in this tab's memory, so closing it also gives up the option to
                    cancel. The real signer first has you save an encrypted cancel key, so you can come back and cancel from Manage.
                  </span>
                </Callout>
              )}
            </DoneMoment>
          )}
          {step === 'manage' && <ManageStep offer={o} s={s} />}

          {s.phase === 'error' && s.hash === hash && (
            <div className="stack" style={{ marginTop: 18, ['--gap' as string]: '10px' }}>
              <ErrorNote error={new Error(s.error ?? 'Something went wrong')} />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  resetSession(hash);
                }}
              >
                Start over
              </button>
            </div>
          )}
          {(step === 'fund' || step === 'sign') && s.phase !== 'error' && (
            <div className="row" style={{ marginTop: 18 }}>
              <button type="button" className="btn ghost sm" onClick={() => resetSession(hash)}>
                Abandon and forget this pocket
              </button>
            </div>
          )}
        </section>

        <aside className="stack" style={{ ['--gap' as string]: '16px' }}>
          <MerchantLearns />
          <div className="card flat stack small" style={{ ['--gap' as string]: '8px' }}>
            <span className="h4">This tab</span>
            <span className="text-2">
              Signer: <span className="mono">{s.signer?.implementation ?? (isMock ? 'mock' : 'wasm')}</span>, keys in {s.signer?.keyCustody === 'passkey' ? 'a passkey-sealed store' : 'memory only'}
              {s.kit ? ', and in the cancel key you saved' : ''}.
            </span>
            <span className="text-2">
              Talks to: <span className="mono">{isMock ? 'nothing (mock)' : apiLabel}</span>.
            </span>
            <span className="text-2">The offer was read from the link's # fragment, which your browser never sends to a server.</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
