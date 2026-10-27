import { useEffect, useMemo, useState } from 'react';
import type { Offer } from '../api/types';
import { cancelKeySettled, NO_CANCEL_KEY, SaveCancelKey, type CancelKeyState } from '../components/CancelKey';
import { CancelCertificate } from '../components/CancelCertificate';
import { CancelPanel, CancelReceiptView, DoneMoment, FundingView, SigningView } from '../components/FlowViews';
import { KeyIcon, ShieldCheckIcon, TabIcon } from '../components/Icons';
import { MerchantLearns } from '../components/MerchantLearns';
import { Timeline } from '../components/Timeline';
import { Badge, Callout, CopyButton, ErrorNote, Round, Spinner, StatusBadge } from '../components/ui';
import { canRetrySigning, canRetryUpload, retrySigning, retryUpload, runMandate, type FlowState } from '../flow';
import { createStore, useDocumentTitle, useNow, usePoll, useStore } from '../hooks';
import { shorten } from '../lib/addresses';
import { encodeOfferPayload, horizonProblem, parseOfferFragment } from '../lib/offer';
import { planSchedule } from '../lib/schedule';
import { formatDateTime, formatPeriod, formatRelative } from '../lib/time';
import { formatZec, INSTALLMENT_FEE_ZAT, totalPrepaidZat } from '../lib/zat';
import { Link, useLocation } from '../router';
import { apiLabel, createSigner, isMock, mockHooks, pickRunner, type Runner } from '../runtime';
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
  /** The runner the offer names, once the payer starts. */
  runner: Runner | null;
  signer: Signer | null;
  abort: AbortController | null;
  lastStep: Step;
  manage: boolean;
  cancel: CancelReceipt | null;
  /** The cancel key: downloaded (ciphertext only, for "download again"), checked, or skipped. */
  key: CancelKeyState;
}

/** In memory only: survives in-app navigation (e.g. to the decoder), never a reload. */
const session = createStore<Session>(() => ({ hash: '', phase: 'idle', runner: null, signer: null, abort: null, lastStep: 'plan', manage: false, cancel: null, key: NO_CANCEL_KEY }));

/** Only the WASM signer's pocket can be cancelled after the tab closes, so only it asks for a cancel key. */
const needsCancelKey = (s: Session) => s.signer?.implementation === 'wasm';

/**
 * Whether losing this tab now loses money: the payment is in the pocket, and the pocket's
 * key is still only in this tab's memory (no cancel key checked or knowingly skipped, and
 * no cancel made). The mock signer has no cancel key: its pocket is past saving once the
 * schedule is uploaded.
 */
function pocketAtRisk(s: Session): boolean {
  if (!s.funding || s.cancel) return false;
  return needsCancelKey(s) ? !cancelKeySettled(s.key) : s.phase !== 'done';
}

/** What the payer must finish before this tab may close. */
const keepUntil = (s: Session) => (needsCancelKey(s) ? 'you have saved your cancel key' : 'the schedule is signed and uploaded');

// A reload or a closed tab while a paid pocket is at risk: the browser asks first. It
// follows the session, not the page, because in-app navigation keeps the session (and
// its pocket key) alive. Nothing is asked before the payment is seen.
if (typeof window !== 'undefined') {
  const ask = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    // Older browsers show the prompt only when returnValue is set.
    e.returnValue = '';
  };
  let asking = false;
  session.subscribe(() => {
    const risk = pocketAtRisk(session.get());
    if (risk === asking) return;
    asking = risk;
    if (risk) window.addEventListener('beforeunload', ask);
    else window.removeEventListener('beforeunload', ask);
  });
}

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

/** A flow update, remembering the step it reached so an error shows where it happened. */
function applyFlow(patch: Partial<FlowState>) {
  const step = patch.phase && patch.phase !== 'error' ? stepOf({ ...session.get(), ...patch } as Session) : undefined;
  session.set({ ...patch, ...(step ? { lastStep: step } : {}) });
}

function start(offer: Offer, runner: Runner) {
  const s = session.get();
  if (s.phase !== 'idle' && s.phase !== 'error') return;
  // The plan step offers no way to start such a plan, or to drop a paid pocket; these are the backstops.
  if (horizonProblem(offer) || pocketAtRisk(s)) return;
  s.signer?.destroy();
  const signer = createSigner(runner.api);
  const abort = new AbortController();
  session.set({ runner, signer, abort, phase: 'pocket', error: undefined, lastStep: 'fund', manage: false, cancel: null, key: NO_CANCEL_KEY });
  void runMandate(offer, signer, applyFlow, { signal: abort.signal, api: runner.api });
}

/**
 * Abandon, or start over, with a second step when it costs money: once the payment is
 * seen (and no checked cancel key holds the pocket's key), or while it may be on its way.
 * In the page, not window.confirm, so it reads like the rest of the flow.
 */
function ForgetPocket({
  label,
  confirm,
  risk,
  onForget,
  className = 'btn ghost sm',
}: {
  label: string;
  confirm: string;
  risk: ForgetRisk;
  onForget: () => void;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!risk || !asking) {
    return (
      <button type="button" className={className} onClick={risk ? () => setAsking(true) : onForget}>
        {label}
      </button>
    );
  }
  return (
    <div style={{ flexBasis: '100%' }}>
      <Callout kind="danger">
        <div className="stack" style={{ ['--gap' as string]: '10px' }}>
          <span className="small">
            {risk === 'paid' ? (
              <>
                <strong>Your payment is in this pocket, and its key exists only in this tab.</strong> No cancel key holds it, so if you go on, the funds in the pocket are lost
                for good: nobody, the runner included, can return them.
              </>
            ) : risk === 'unchecked' ? (
              <>
                <strong>Your payment is in this pocket.</strong> Apart from this tab, only the cancel key you downloaded holds its key, and that file has not been checked: if it
                does not open, going on loses the funds in the pocket for good.
              </>
            ) : (
              <>
                <strong>Have you already sent the payment?</strong> If it is on its way to this pocket, going on loses it for good: the pocket's key exists only in this tab. Go on
                only if you have not paid.
              </>
            )}
          </span>
          <div className="row" style={{ ['--gap' as string]: '12px' }}>
            <button type="button" className="btn sm danger" onClick={onForget}>
              {confirm}
            </button>
            <button type="button" className="link-btn small" onClick={() => setAsking(false)}>
              Keep this pocket
            </button>
          </div>
        </div>
      </Callout>
    </div>
  );
}

type ForgetRisk = 'paid' | 'unchecked' | 'maybe' | null;

/**
 * What forgetting the session now risks: the payment, once it is seen, unless a checked
 * cancel key holds the pocket's key; maybe the payment, once there is a pocket to pay.
 */
function forgetRisk(s: Session): ForgetRisk {
  if (s.funding) {
    if (s.key.step === 'verified') return null;
    return s.key.step === 'downloaded' || (s.key.step === 'skipped' && s.key.kit) ? 'unchecked' : 'paid';
  }
  return s.pocket ? 'maybe' : null;
}

/** Checks that this build may talk to the runner the offer names, and the link's offer against that runner's own copy. */
function useVerifiedOffer(offer: Offer | null) {
  const [state, setState] = useState<{ status: 'checking' | 'ok' | 'bad'; message?: string; runner?: Runner }>({ status: 'checking' });
  useEffect(() => {
    if (!offer) return;
    let alive = true;
    const pick = pickRunner(offer.runner_endpoint, 'offer');
    if (!pick.ok) {
      setState({ status: 'bad', message: pick.message });
      return;
    }
    const runner = pick.runner;
    setState({ status: 'checking', runner });
    mockHooks?.adoptOffer(offer);
    runner.api
      .getOffer(offer.offer_id)
      .then((remote) => {
        if (!alive) return;
        if (encodeOfferPayload(remote) !== encodeOfferPayload(offer)) setState({ status: 'bad', runner, message: "The link's offer does not match the runner's copy. Do not subscribe; ask the merchant for a new link." });
        else setState({ status: 'ok', runner });
      })
      .catch((e: Error) => alive && setState({ status: 'bad', runner, message: `The runner could not confirm this offer: ${e.message}` }));
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

/** A paid pocket for another link, still at risk in this tab. */
interface Held {
  hash: string;
  name: string;
  until: string;
}

function PlanStep({ offer, verified, held }: { offer: Offer; verified: ReturnType<typeof useVerifiedOffer>; held: Held | null }) {
  const now = useNow();
  const schedule = useMemo(() => planSchedule(offer, Math.floor(now / 10) * 10), [offer, Math.floor(now / 10)]);
  const total = totalPrepaidZat(offer.amount_zat, offer.count);
  const horizon = horizonProblem(offer);
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
          <Badge tone={offer.network === 'main' ? 'sealed' : 'muted'}>{offer.network === 'main' ? 'Mainnet' : 'Testnet'}</Badge>
        </dd>
        <dt>Offer check</dt>
        <dd>
          {verified.status === 'checking' && <Spinner label="Asking the runner for its copy…" />}
          {verified.status === 'ok' && (
            <span className="row small" style={{ ['--gap' as string]: '6px' }}>
              <ShieldCheckIcon size={15} /> Matches the runner's copy of {offer.offer_id}
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

      {held ? (
        <Callout kind="warn">
          <div className="stack" style={{ ['--gap' as string]: '10px' }}>
            <span className="small">
              <strong>This tab still holds a pocket you paid into, for {held.name}.</strong> Its key exists only in this tab, so this page will not start another plan until{' '}
              {held.until}.
            </span>
            <Link to={`/subscribe${held.hash}`} className="btn sm" style={{ alignSelf: 'flex-start' }}>
              Back to that plan
            </Link>
          </div>
        </Callout>
      ) : verified.status === 'bad' ? (
        <Callout kind="danger">{verified.message}</Callout>
      ) : horizon ? (
        <Callout kind="danger">{horizon}</Callout>
      ) : (
        <div className="stack" style={{ ['--gap' as string]: '10px' }}>
          <button type="button" className="btn primary lg" onClick={() => verified.runner && start(offer, verified.runner)} disabled={verified.status !== 'ok'}>
            Create my pocket and continue
          </button>
          <p className="tiny muted">
            A pocket is a fresh, single-use key made in this tab, never your wallet's seed. Its view-only key goes to the runner as soon as it is made, so the runner can watch for your
            payment; once you have paid and the schedule is signed, the sealed packages follow. The spending key stays in this tab, apart from the encrypted cancel key you download.
          </p>
        </div>
      )}
    </div>
  );
}

function ManageStep({ offer, s }: { offer: Offer; s: Session }) {
  const sub = usePoll((signal) => s.runner!.api.getSubscription(s.subscriptionId!, signal), isMock ? 1500 : 10000, [s.subscriptionId]);
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
        <SaveCancelKey signer={s.signer} subscriptionId={s.subscriptionId ?? null} runner={s.runner?.url} state={s.key} onChange={(key) => session.set({ key })} skip="confirm" />
      )}
      <hr />
      <div className="stack" style={{ ['--gap' as string]: '10px' }}>
        <span className="h4">Cancel</span>
        {s.cancel ? (
          <>
            <CancelReceiptView receipt={s.cancel} network={offer.network} />
            {s.runner && <CancelCertificate receipt={s.cancel} client={s.runner.api} network={offer.network} subscriptionId={s.subscriptionId ?? null} count={offer.count} />}
          </>
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

  // Another link starts a new session, except over a paid pocket still at risk: the plan
  // step points back to it instead, and the session resets once that pocket is safe.
  const holding = s.hash !== hash && pocketAtRisk(s);
  useEffect(() => {
    const cur = session.get();
    if (cur.hash !== hash && !pocketAtRisk(cur)) resetSession(hash);
  }, [hash, holding]);

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
  const heldOffer = holding ? parseOfferFragment(s.hash) : null;
  const held = holding ? { hash: s.hash, name: heldOffer?.ok ? heldOffer.offer.name : 'another plan', until: keepUntil(s) } : null;

  return <SubscribeView offer={o} step={step} s={s} hash={hash} verified={verified} held={held} />;
}

function SubscribeView({
  offer: o,
  step,
  s,
  hash,
  verified,
  held,
}: {
  offer: Offer;
  step: Step;
  s: Session;
  hash: string;
  verified: ReturnType<typeof useVerifiedOffer>;
  held: Held | null;
}) {
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
          {step === 'plan' && <PlanStep offer={o} verified={verified} held={held} />}
          {step === 'fund' && (
            <div className="stack" style={{ ['--gap' as string]: '18px' }}>
              <div className="stack" style={{ ['--gap' as string]: '4px' }}>
                <span className="h3">Fund your pocket</span>
                <span className="small muted">
                  One payment covers every installment.{' '}
                  {s.signer?.implementation === 'wasm' ? 'Signing starts once the payment is mined in a block (the runner only reports mined payments).' : 'Signing starts the moment it reaches the mempool.'}
                </span>
              </div>
              <Callout kind="warn" icon={<TabIcon size={16} />}>
                <span className="small">
                  <strong>Keep this tab open until {keepUntil(s)}.</strong> Until then the pocket's key exists only in this tab, so closing or reloading it after you pay loses
                  the payment.
                </span>
              </Callout>
              <FundingView
                offer={o}
                flow={s}
                onSimulate={mockHooks && s.pocket && s.totalZat ? () => mockHooks?.simulateWalletPayment(s.pocket!.ua, s.totalZat!) : undefined}
                walletNote={`Paying from a wallet on this device? Come back to this tab once you have paid: it has to stay open until ${keepUntil(s)}.`}
              />
            </div>
          )}
          {step === 'sign' && <SigningView offer={o} flow={s} />}
          {step === 'done' && (
            <DoneMoment
              offer={o}
              flow={s}
              closeable={!needsCancelKey(s) || cancelKeySettled(s.key)}
              notice={
                needsCancelKey(s) && s.signer ? (
                  <SaveCancelKey signer={s.signer} subscriptionId={s.subscriptionId ?? null} runner={s.runner?.url} state={s.key} onChange={(key) => session.set({ key })} skip="confirm" />
                ) : undefined
              }
            >
              <div className="row" style={{ justifyContent: 'center', ['--gap' as string]: '10px' }}>
                <button type="button" className="btn" onClick={() => session.set({ manage: true })}>
                  Manage or cancel
                </button>
                {needsCancelKey(s) && s.key.step === 'verified' && (
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
              {canRetryUpload(s) ? (
                <>
                  <span className="small text-2">Your pocket is funded and every installment is signed; only the upload failed. Keep this tab open and try again.</span>
                  {needsCancelKey(s) && s.signer && (
                    <>
                      <span className="small text-2">
                        Save a cancel key first. It holds the pocket's key, so even if the upload never succeeds, <code>cadence sweep</code> returns what you paid.
                      </span>
                      <SaveCancelKey signer={s.signer} subscriptionId={null} runner={s.runner?.url} state={s.key} onChange={(key) => session.set({ key })} skip="confirm" />
                    </>
                  )}
                  <div className="row" style={{ ['--gap' as string]: '8px' }}>
                    <button type="button" className="btn" onClick={() => void retryUpload(o, s, (patch) => session.set(patch), { signal: s.abort?.signal, api: s.runner?.api })}>
                      Retry upload
                    </button>
                    <ForgetPocket label="Start over (abandons this funded pocket)" confirm="Start over and lose the funds" risk={forgetRisk(s)} onForget={() => resetSession(hash)} />
                  </div>
                </>
              ) : canRetrySigning(s) && s.signer ? (
                <>
                  <span className="small text-2">
                    Your payment is in the pocket, but signing failed before every installment was sealed, and nothing was uploaded. Keep this tab open and sign again: the pocket and its
                    payment are unchanged.
                  </span>
                  <div className="row" style={{ ['--gap' as string]: '8px' }}>
                    <button type="button" className="btn" onClick={() => void retrySigning(o, s.signer!, s, applyFlow, { signal: s.abort?.signal, api: s.runner?.api })}>
                      Retry signing
                    </button>
                    <ForgetPocket label="Start over (abandons this funded pocket)" confirm="Start over and lose the funds" risk={forgetRisk(s)} onForget={() => resetSession(hash)} />
                  </div>
                </>
              ) : (
                <ForgetPocket label="Start over" confirm="Start over anyway" risk={forgetRisk(s)} onForget={() => resetSession(hash)} className="btn" />
              )}
            </div>
          )}
          {(step === 'fund' || step === 'sign') && s.phase !== 'error' && (
            <div className="row" style={{ marginTop: 18 }}>
              <ForgetPocket
                label="Abandon and forget this pocket"
                confirm={forgetRisk(s) === 'maybe' ? 'I have not paid: abandon it' : 'Abandon it and lose the funds'}
                risk={forgetRisk(s)}
                onForget={() => resetSession(hash)}
              />
            </div>
          )}
        </section>

        <aside className="stack" style={{ ['--gap' as string]: '16px' }}>
          <MerchantLearns />
          <div className="card flat stack small" style={{ ['--gap' as string]: '8px' }}>
            <span className="h4">This tab</span>
            <span className="text-2">
              Signer: <span className="mono">{s.signer?.implementation ?? (isMock ? 'mock' : 'wasm')}</span>, keys in {s.signer?.keyCustody === 'passkey' ? 'a passkey-sealed store' : 'memory only'}
              {s.key.step === 'verified' ? ', and in the cancel key you saved and checked' : ''}.
            </span>
            <span className="text-2">
              Talks to: <span className="mono">{isMock ? 'nothing (mock)' : (s.runner ?? verified.runner)?.label ?? apiLabel}</span>.
            </span>
            <span className="text-2">
              The offer was read from the link's # fragment, which your browser never sends to a server.
              {isMock ? '' : ' To check it, this page asked the runner for its copy by id, so that runner saw your IP address open this offer.'}
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
