import { useState, type ReactNode } from 'react';
import type { CheatKind, Installment, Offer, RunnerStatus, SandboxCheatResponse, Subscription } from '../api/types';
import { cancelKeySettled, NO_CANCEL_KEY, SaveCancelKey, type CancelKeyState } from '../components/CancelKey';
import { CancelCertificate } from '../components/CancelCertificate';
import { CancelPanel, CancelReceiptView, DoneMoment, FundingView, PayerOffline, SigningView, StatusLink } from '../components/FlowViews';
import { BanIcon, BoltIcon, ClockIcon, KeyIcon, LockIcon, PenIcon, ServerIcon, TabIcon } from '../components/Icons';
import { LogView, useRunnerLog } from '../components/RunnerLog';
import { ShapeTable } from '../components/ShapeTable';
import { Timeline } from '../components/Timeline';
import { Badge, Callout, ErrorNote, PageHead, Spinner, StatusBadge } from '../components/ui';
import { STOCK_SEND_REFERENCE } from '../data/stockReference';
import { runMandate, type FlowState } from '../flow';
import { createStore, useDocumentTitle, useNow, usePoll, useStore } from '../hooks';
import { roundAt } from '../lib/drand';
import type { LogLine } from '../lib/runnerLog';
import { formatZec, totalPrepaidZat } from '../lib/zat';
import { Link } from '../router';
import { api, createSigner, isMock, mockHooks } from '../runtime';
import type { CancelReceipt, Signer } from '../signer/types';

type CheatResult = SandboxCheatResponse | { error: string };

interface SandboxState extends FlowState {
  offer: Offer | null;
  signer: Signer | null;
  abort: AbortController | null;
  creating: boolean;
  createError?: string;
  tabClosedAt: number | null;
  reopened: boolean;
  cancel: CancelReceipt | null;
  /** The cancel key (real mode): downloaded, checked, or skipped. */
  key: CancelKeyState;
  decodeTxid: string | null;
  decodedOnce: boolean;
  cheats: Partial<Record<CheatKind, CheatResult>>;
  events: LogLine[];
}

const store = createStore<SandboxState>(() => ({
  phase: 'idle',
  offer: null,
  signer: null,
  abort: null,
  creating: false,
  tabClosedAt: null,
  reopened: false,
  cancel: null,
  key: NO_CANCEL_KEY,
  decodeTxid: null,
  decodedOnce: false,
  cheats: {},
  events: [],
}));

const note = (text: string, tone?: LogLine['tone']) => store.set((s) => ({ events: [...s.events, { at: Date.now() / 1000, text, tone }] }));

const SANDBOX_TOKEN = 'sandbox-judge';

/** Only the WASM signer's pocket can be cancelled after the tab closes, so only it asks for a cancel key. */
const needsCancelKey = (s: SandboxState) => s.signer?.implementation === 'wasm';

async function createMandate(cfg: { count: number; period: number; amount: number }) {
  const s = store.get();
  if (s.creating || s.offer) return;
  store.set({ creating: true, createError: undefined });
  try {
    let created;
    if (isMock) {
      const merchantUa = mockHooks?.demoMerchantUa;
      if (!merchantUa) throw new Error('the mock runner has no demo merchant');
      created = await api.createOffer({ name: 'Sandbox standing order', amount_zat: cfg.amount, period_secs: cfg.period, count: cfg.count, merchant_ua: merchantUa }, SANDBOX_TOKEN);
    } else {
      // The real sandbox runner pays installments back into its own testnet wallet.
      created = await api.sandboxOffer({ count: cfg.count, period_secs: cfg.period, amount_zat: cfg.amount });
    }
    const offer = await api.getOffer(created.offer_id);
    const signer = createSigner();
    const abort = new AbortController();
    store.set({ offer, signer, abort, creating: false });
    note(`merchant: created ${offer.offer_id}: ${offer.count} × ${formatZec(offer.amount_zat)} every ${offer.period_secs} s`);
    void runMandate(offer, signer, (patch) => {
      store.set(patch);
      if (patch.phase === 'signing' && patch.funding) {
        const f = patch.funding;
        note(`payer: funding ${f.status === 'mined' && f.mined_height ? `mined at ${f.mined_height.toLocaleString('en-US')}` : 'seen in the mempool'}; pre-signing every installment`);
      }
      if (patch.phase === 'done' && patch.subscriptionId) note(`payer: uploaded ${offer.count} sealed packages; subscription ${patch.subscriptionId}`, 'ok');
      if (patch.phase === 'error') note(`payer: ${patch.error}`, 'err');
    }, {
      signal: abort.signal,
      onPocket: async (pocket, total) => {
        note(`payer: fresh pocket ${pocket.ua.slice(0, 16)}…; requesting ${formatZec(total)}`);
        const fund = await api.sandboxFund({ ua: pocket.ua, amount_zat: total }, abort.signal);
        store.set({ events: [...store.get().events, { at: Date.now() / 1000, text: `faucet: paid ${formatZec(total)} to the pocket in ${fund.txid.slice(0, 16)}…${fund.mined_height ? ` (mined at ${fund.mined_height})` : ' (in the mempool)'}` }] });
      },
    });
  } catch (e) {
    store.set({ creating: false, createError: (e as Error).message });
  }
}

function reset() {
  const s = store.get();
  s.abort?.abort();
  s.signer?.destroy();
  store.reset();
}

interface StepDef {
  id: string;
  title: string;
  desc: string;
  done: boolean;
}

function steps(s: SandboxState, sub: Subscription | undefined): StepDef[] {
  const mined = sub?.installments.filter((i) => i.state === 'mined').length ?? 0;
  return [
    { id: 'create', title: 'Create a mandate', desc: 'A merchant offer: N installments, a short period apart.', done: !!s.offer },
    { id: 'fund', title: 'Auto-fund it', desc: 'The sandbox faucet pays the pocket QR for you.', done: !!s.funding },
    { id: 'sign', title: 'Sign', desc: 'Every installment, every candidate height, sealed.', done: s.phase === 'done' },
    {
      id: 'close',
      title: 'Close the tab',
      desc: needsCancelKey(s) ? 'Save the cancel key and check it opens, then go away. Nothing on the payer side runs.' : 'The payer goes away. Nothing on their side runs.',
      done: s.tabClosedAt !== null,
    },
    { id: 'watch', title: 'Watch 3 installments land', desc: 'Sealed → due → broadcast → mined, by the runner alone.', done: mined >= 3 },
    { id: 'decode', title: 'Decode one', desc: 'Compare its shape with a stock wallet send.', done: s.decodedOnce },
    { id: 'cancel', title: 'Cancel', desc: 'Spend the pocket note. The rest can never be valid.', done: !!s.cancel && sub?.status === 'cancelled' },
  ];
}

function pick(sub: Subscription | undefined, kind: CheatKind): Installment | undefined {
  if (!sub) return undefined;
  const list = sub.installments;
  switch (kind) {
    case 'open_early':
      return list.find((i) => i.k === 3 && i.state === 'sealed') ?? list.find((i) => i.state === 'sealed');
    case 'tamper_amount':
      return [...list].reverse().find((i) => i.state === 'due' || i.state === 'broadcast' || i.state === 'mined');
    case 'rebroadcast':
      // The runner rebroadcasts the latest paid installment.
      return [...list].reverse().find((i) => i.state === 'mined' && i.txid);
    case 'stretch_schedule':
      return list.find((i) => i.k === 2);
  }
}

const UNAVAILABLE: Record<CheatKind, string> = {
  open_early: 'No sealed installment left.',
  tamper_amount: 'Wait for installment 1 to open.',
  rebroadcast: 'Wait for installment 1 to be mined.',
  stretch_schedule: 'This plan has no installment 2.',
};

// The verify script finds the first three cards by position: keep this order.
const CHEATS: Array<{ kind: CheatKind; title: (k?: number) => string; expect: string; why: string; icon: ReactNode }> = [
  {
    kind: 'open_early',
    title: (k) => `Open installment ${k ?? 3} early`,
    expect: 'fails: tlock',
    why: "The package is time-locked to a drand round. Its decryption key is drand's signature on that round, which nobody holds until the round is published.",
    icon: <LockIcon size={16} />,
  },
  {
    kind: 'tamper_amount',
    title: (k) => `Tamper with installment ${k ?? 1}'s amount`,
    expect: 'fails: signature',
    why: "The payer signed the exact outputs. Changing the amount changes the sighash, so the payer's spend authorization no longer verifies.",
    icon: <PenIcon size={16} />,
  },
  {
    kind: 'rebroadcast',
    title: () => 'Rebroadcast a paid installment',
    expect: 'fails: double-spend',
    why: 'Each installment spends one pocket note, and a paid installment has already spent its note, so the node refuses the same transaction again. No cancel is needed.',
    icon: <BanIcon size={16} />,
  },
  {
    kind: 'stretch_schedule',
    title: () => 'Stretch the plan: payer seals installment 2 a year late',
    expect: 'fails: schedule',
    why: "The runner checks every installment's drand round against the offer's period before it accepts a schedule, so one sealed a year late is refused.",
    icon: <ClockIcon size={16} />,
  },
];

function CheatPanel({ sub, s }: { sub: Subscription | undefined; s: SandboxState }) {
  const [busy, setBusy] = useState<CheatKind | null>(null);
  const run = async (kind: CheatKind, k: number) => {
    if (!sub) return;
    setBusy(kind);
    try {
      const res = await api.sandboxCheat({ subscription_id: sub.subscription_id, kind, k });
      store.set((st) => ({ cheats: { ...st.cheats, [kind]: res } }));
      if (res.outcome === 'rejected') note(`cheat: ${kind.replace(/_/g, ' ')} on installment ${res.k} rejected by ${res.stage}`, 'err');
    } catch (e) {
      store.set((st) => ({ cheats: { ...st.cheats, [kind]: { error: (e as Error).message } } }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-labelledby="cheats">
      <div className="card-head">
        <div className="stack" style={{ ['--gap' as string]: '6px' }}>
          <span className="kicker">Cheat buttons</span>
          <h2 id="cheats" className="h3">
            Make the runner, or the payer, misbehave
          </h2>
          <p className="small muted">Each attempt goes to the runner, which tries the forbidden action and reports what stopped it.</p>
        </div>
        {isMock && <span className="tag">mock runner · reproduces the real failure path</span>}
      </div>
      <div className="grid cols-2" style={{ ['--gap' as string]: '12px', alignItems: 'start' }}>
        {CHEATS.map((c) => {
          const target = pick(sub, c.kind);
          const result = s.cheats[c.kind];
          const disabled = !sub ? 'Sign a mandate first.' : !target ? UNAVAILABLE[c.kind] : null;
          return (
            <div className="cheat" key={c.kind}>
              <div className="row between">
                <span className="row h4" style={{ ['--gap' as string]: '8px' }}>
                  {c.icon} {c.title(target?.k)}
                </span>
              </div>
              <Badge tone="red">{c.expect}</Badge>
              <p className="tiny muted">{c.why}</p>
              <button type="button" className="btn sm" disabled={!!disabled || busy === c.kind} onClick={() => target && run(c.kind, target.k)}>
                <BoltIcon size={14} /> {busy === c.kind ? 'Trying…' : 'Try it'}
              </button>
              {disabled && <span className="tiny faint">{disabled}</span>}
              {result && (
                <div className="result stack" style={{ ['--gap' as string]: '6px' }}>
                  {'error' in result ? (
                    <ErrorNote error={new Error(result.error)} />
                  ) : (
                    <>
                      <div className="row" style={{ ['--gap' as string]: '6px' }}>
                        {result.outcome === 'rejected' ? (
                          <Badge tone="green" dot>
                            Rejected · {result.stage}
                          </Badge>
                        ) : (
                          <Badge tone="muted">Not applicable yet</Badge>
                        )}
                        <span className="tiny muted">installment {result.k}</span>
                      </div>
                      <div className="log" role="log" aria-label={`${c.title(result.k)}: runner output`}>
                        {result.log.map((l, i) => (
                          <div className={`line ${result.outcome === 'rejected' && i >= result.log.length - 1 ? 'err' : ''}`} key={i}>
                            <span className="msg">{l}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CreateForm() {
  const s = useStore(store);
  const [count, setCount] = useState(isMock ? 6 : 3);
  const [period, setPeriod] = useState(isMock ? 20 : 90);
  const amount = 100_000;
  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      <div className="stack" style={{ ['--gap' as string]: '4px' }}>
        <span className="h3">A standing order, sped up</span>
        <span className="small muted">
          Real cadences are days or weeks. Here installments are seconds or minutes apart so you can watch them land.
          {!isMock && ' To have time to cancel before the last one, choose 4 installments every 300 seconds.'}
        </span>
      </div>
      <div className="grid cols-3" style={{ ['--gap' as string]: '12px' }}>
        <div className="field">
          <label htmlFor="sb-count">Installments</label>
          <select id="sb-count" className="select" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {(isMock ? [4, 5, 6, 8] : [3, 4]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sb-period">Every</label>
          <select id="sb-period" className="select" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
            {(isMock ? [20, 30, 45] : [90, 120, 180, 300]).map((n) => (
              <option key={n} value={n}>
                {n} seconds
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="label">Amount</span>
          <div className="input mono" style={{ display: 'flex', alignItems: 'center' }} aria-readonly="true">
            {formatZec(amount)}
          </div>
        </div>
      </div>
      <div className="panel small text-2">
        Prepaid in one payment: <span className="mono">{formatZec(totalPrepaidZat(amount, count))}</span>, every installment plus its fee.
      </div>
      {s.createError && <ErrorNote error={new Error(s.createError)} />}
      <button type="button" className="btn primary lg" onClick={() => createMandate({ count, period, amount })} disabled={s.creating}>
        {s.creating ? 'Creating…' : 'Create mandate and auto-fund'}
      </button>
    </div>
  );
}

/** The runner log's payer line for a cancel-key step. */
function keyNote(key: CancelKeyState): string | null {
  switch (key.step) {
    case 'downloaded':
      return `payer: downloaded the cancel key as ${key.kit.fileName}, encrypted to a passphrase; it went to no server`;
    case 'verified':
      return `payer: picked ${key.kit.fileName} again and opened it with its passphrase; it is this pocket's key`;
    case 'skipped':
      return key.kit ? 'payer: skipped checking the cancel key' : 'payer: skipped saving a cancel key; only this tab can cancel';
    case 'none':
      return null;
  }
}

function PayerPane({ s, sub, runner }: { s: SandboxState; sub: Subscription | undefined; runner: RunnerStatus | undefined }) {
  const closed = s.tabClosedAt !== null && !s.reopened;
  const settled = sub && (sub.status === 'completed' || sub.status === 'cancelled' || sub.status === 'stopped');
  // A sandbox offer's merchant is the sandbox wallet: a refund address for judges without a testnet wallet.
  const sandboxRefund = runner?.sandbox && runner.network === 'test' ? s.offer?.merchant_ua : undefined;
  return (
    <section className={`pane${closed ? ' closed' : ''}`} aria-label="Payer tab">
      <div className="pane-head">
        <span className="row" style={{ ['--gap' as string]: '0' }}>
          <span className="lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          payer tab · /subscribe
        </span>
        <span>{closed ? 'closed' : s.reopened ? 'reopened' : s.phase === 'idle' ? 'new' : s.phase}</span>
      </div>
      <div className="pane-body">
        {closed ? (
          <div className="stack" style={{ ['--gap' as string]: '16px', alignItems: 'center' }}>
            <PayerOffline since={s.tabClosedAt!} />
            <button type="button" className="btn" onClick={() => { store.set({ reopened: true }); note(isMock ? 'payer: tab reopened; pocket key unlocked (passkey, simulated)' : 'payer: back in the tab; the pocket key never left its memory'); }}>
              <KeyIcon size={15} /> Reopen and unlock to cancel
            </button>
            <span className="tiny muted" style={{ maxWidth: 360 }}>
              {isMock ? (
                'Simulated: this mock kept the pocket key in memory. The real signer has the payer save an encrypted cancel key instead.'
              ) : s.key.step === 'verified' ? (
                <>
                  The tab was only hidden, so the pocket key is still in its memory. For the real thing, reload this page (the key is gone), then open <Link to="/manage">Manage</Link> and
                  load {s.key.kit.fileName} to cancel.
                </>
              ) : (
                'The tab was only hidden: the pocket key is still in this tab’s memory. Without a cancel key you have checked, closing the tab for real gives up the option to cancel.'
              )}
            </span>
          </div>
        ) : s.reopened && s.signer ? (
          <div className="stack" style={{ ['--gap' as string]: '12px' }}>
            <span className="h3">Cancel your subscription</span>
            {s.cancel ? (
              <>
                <CancelReceiptView receipt={s.cancel} />
                {s.offer && <CancelCertificate receipt={s.cancel} client={api} network="test" subscriptionId={s.subscriptionId ?? null} count={s.offer.count} />}
              </>
            ) : (
              <CancelPanel
                signer={s.signer}
                showDemo={isMock}
                sandboxRefund={sandboxRefund}
                disabled={settled ? `The subscription is ${sub!.status}; nothing is left to cancel. Start over with more installments.` : undefined}
                onCancelled={(r) => {
                  store.set({ cancel: r });
                  note(`payer: cancel broadcast ${r.txid.slice(0, 16)}…; refund ${formatZec(r.refunded_zat)} to an address of my own`, 'warn');
                }}
                onNothingLeft={(msg) => note(`payer: ${msg}`)}
              />
            )}
          </div>
        ) : !s.offer ? (
          <CreateForm />
        ) : s.phase === 'pocket' || s.phase === 'funding' ? (
          <div className="stack" style={{ ['--gap' as string]: '14px' }}>
            <span className="h3">Fund the pocket</span>
            <FundingView offer={s.offer} flow={s} />
            <span className="tiny muted">The sandbox faucet is paying this QR for you.</span>
          </div>
        ) : s.phase === 'signing' || s.phase === 'uploading' ? (
          <SigningView offer={s.offer} flow={s} />
        ) : s.phase === 'done' ? (
          <DoneMoment
            offer={s.offer}
            flow={s}
            closeable={!needsCancelKey(s) || cancelKeySettled(s.key)}
            notice={
              needsCancelKey(s) && s.signer ? (
                <SaveCancelKey
                  signer={s.signer}
                  subscriptionId={s.subscriptionId ?? null}
                  state={s.key}
                  onChange={(key) => {
                    store.set({ key });
                    const line = keyNote(key);
                    if (line) note(line);
                  }}
                  skip="quick"
                />
              ) : undefined
            }
          >
            {s.subscriptionId && <StatusLink subscriptionId={s.subscriptionId} closeable={!needsCancelKey(s) || cancelKeySettled(s.key)} />}
            {(!needsCancelKey(s) || cancelKeySettled(s.key)) && (
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn primary lg"
                  onClick={() => {
                    store.set({ tabClosedAt: Date.now() / 1000 });
                    note('payer: tab closed');
                  }}
                >
                  <TabIcon size={16} /> Close the payer tab
                </button>
              </div>
            )}
          </DoneMoment>
        ) : s.phase === 'error' ? (
          <ErrorNote error={new Error(s.error ?? 'failed')} />
        ) : (
          <Spinner />
        )}
      </div>
    </section>
  );
}

function RunnerPane({ sub, s }: { sub: Subscription | undefined; s: SandboxState }) {
  const now = useNow();
  const status = usePoll((signal) => api.status(signal), 3000);
  const lines = useRunnerLog(sub, s.events);
  return (
    <section className="pane" aria-label="Runner">
      <div className="pane-head">
        <span className="row" style={{ ['--gap' as string]: '8px' }}>
          <ServerIcon size={14} /> runner · merchant side
        </span>
        <span className="num">
          tip {status.data?.tip.toLocaleString('en-US') ?? '…'} · drand {roundAt(now).toLocaleString('en-US')}
        </span>
      </div>
      <div className="pane-body stack" style={{ ['--gap' as string]: '16px' }}>
        {sub ? (
          <>
            <div className="row between">
              <span className="mono small muted">{sub.subscription_id}</span>
              <StatusBadge status={sub.status} />
            </div>
            <Timeline
              installments={sub.installments}
              onDecode={(txid) => {
                store.set({ decodeTxid: txid, decodedOnce: true });
                requestAnimationFrame(() => document.getElementById('inline-decode')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
            />
          </>
        ) : (
          <p className="small muted">Holding nothing yet. Once the payer uploads, sealed packages appear here.</p>
        )}
        <LogView lines={lines} label="Runner log" empty="runner idle" />
        <span className="tiny faint">Runner lines are written by this page from the runner's API answers, in the style of its log. Cheat output is what the runner returns.</span>
      </div>
    </section>
  );
}

function InlineDecode({ txid }: { txid: string }) {
  const shape = usePoll((signal) => api.decode(txid, signal), 0, [txid]);
  return (
    <section className="card" id="inline-decode" aria-labelledby="inline-decode-title">
      <div className="card-head">
        <div className="stack" style={{ ['--gap' as string]: '6px', minWidth: 0 }}>
          <span className="kicker">Decode</span>
          <h2 id="inline-decode-title" className="h3">
            Installment {txid.slice(0, 12)}… next to a stock wallet send
          </h2>
        </div>
        <div className="row" style={{ ['--gap' as string]: '8px' }}>
          <Link to={`/decode/${txid}`} className="btn sm">
            Open in decoder
          </Link>
          <button type="button" className="btn sm ghost" onClick={() => store.set({ decodeTxid: null })}>
            Close
          </button>
        </div>
      </div>
      {shape.loading && <Spinner label="Decoding…" />}
      {shape.error && <ErrorNote error={shape.error} />}
      {shape.data && <ShapeTable shape={shape.data} compare={STOCK_SEND_REFERENCE} />}
    </section>
  );
}

export function Sandbox() {
  useDocumentTitle('Judge sandbox');
  const s = useStore(store);
  const sub = usePoll((signal) => (s.subscriptionId ? api.getSubscription(s.subscriptionId, signal) : Promise.resolve(undefined)), 1000, [s.subscriptionId]);
  const current = sub.data && sub.data.subscription_id === s.subscriptionId ? sub.data : undefined;
  const list = steps(s, current);
  const currentIdx = list.findIndex((st) => !st.done);
  const status = usePoll((signal) => (isMock ? Promise.resolve(undefined) : api.status(signal)), 30000, []);

  if (!isMock && status.data && !status.data.sandbox) {
    return (
      <div className="page container narrow">
        <PageHead kicker="Judge sandbox" title="This runner has no sandbox." />
        <Callout kind="warn">
          The judge sandbox runs against the testnet sandbox runner, which serves the <code>/api/sandbox</code> endpoints. This runner does not.
        </Callout>
      </div>
    );
  }

  return (
    <div className="page container">
      <PageHead
        kicker="Judge sandbox"
        title={
          <>
            Subscribe, walk away, <em>then try to cheat.</em>
          </>
        }
        lede={
          isMock
            ? 'A guided run on a mock NU7 testnet with 5-second blocks. Every step uses the same API client and signer interface as the real app.'
            : 'A guided run on the real Zcash testnet (NU7, 25-second blocks). Every transaction is real: decode any of them. The sandbox wallet that funds you is custodial testnet money, and is the merchant here, so payments flow back to it.'
        }
      >
        <div className="row" style={{ ['--gap' as string]: '8px' }}>
          {s.offer && (
            <button type="button" className="btn sm ghost" onClick={reset}>
              Start over
            </button>
          )}
          <Link to="/merchant" className="btn sm ghost">
            See it on the merchant dashboard
          </Link>
        </div>
      </PageHead>

      <nav className="stack" aria-label="Sandbox steps" style={{ ['--gap' as string]: '12px', marginBottom: 22 }}>
        <ol className="stepper">
          {list.map((st, i) => (
            <li key={st.id} data-state={st.done ? 'done' : i === currentIdx ? 'current' : 'todo'} aria-current={i === currentIdx ? 'step' : undefined} title={st.desc}>
              <span className="n">{st.done ? '✓' : i + 1}</span>
              {st.title}
            </li>
          ))}
        </ol>
        <p className="small text-2" aria-live="polite">
          {currentIdx === -1 ? (
            <>All seven steps done. If you haven't yet, try the cheat buttons below.</>
          ) : (
            <>
              <span className="mono accent">
                Step {currentIdx + 1}/{list.length}
              </span>{' '}
              · {list[currentIdx]!.desc}
            </>
          )}
        </p>
      </nav>

      <div className="stack" style={{ ['--gap' as string]: '20px', minWidth: 0 }}>
        <div className="grid cols-2" style={{ ['--gap' as string]: '20px', alignItems: 'start' }}>
          <PayerPane s={s} sub={current} runner={status.data} />
          <RunnerPane s={s} sub={current} />
        </div>
        {s.decodeTxid && <InlineDecode key={s.decodeTxid} txid={s.decodeTxid} />}
        <CheatPanel sub={current} s={s} />
      </div>
    </div>
  );
}
