/**
 * /status#sub=sub_…: a demo view of one subscription as this origin's runner reports
 * it. The id comes from the URL fragment. The page polls GET /api/subscriptions/:id
 * every 30 seconds and decodes each mined installment once with GET /api/decode/:txid,
 * keeping the results in this tab's memory only. On an app host, a subscription the
 * default runner does not know (404) is asked of the other runners, and the page says
 * which one holds it; that runner then answers every request for it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { Installment, NetworkId, Shape, Subscription } from '../api/types';
import { SearchIcon } from '../components/Icons';
import { Badge, Callout, CopyButton, Countdown, ErrorNote, PageHead, Round, Spinner, Stat, StateBadge, StatusBadge, Txid } from '../components/ui';
import { useDocumentTitle, usePoll } from '../hooks';
import { byK, fragmentNamesSubscription, installmentNote, MISSED_NOTE, nextDue, nu7Crossing, paidOf, subscriptionIdFromFragment, type Nu7Crossing } from '../lib/planStatus';
import { summarizeShape } from '../lib/shape';
import { subscriptionStatusInfo } from '../lib/states';
import { formatDateTime, formatRelative } from '../lib/time';
import { formatZec } from '../lib/zat';
import { navigate, useLocation } from '../router';
import type { CadenceClient } from '../api/client';
import { askRunners, defaultRunner, manyRunners, runnerName, runnersText, type Runner } from '../runtime';

const POLL_MS = 30_000;
const n = (x: number) => x.toLocaleString('en-US');

/** Decoded shapes of mined installments, in memory only. A failed decode is dropped so a later poll retries it. */
const shapes = new Map<string, Promise<Shape>>();
function decodeOnce(txid: string, client: CadenceClient): Promise<Shape> {
  let p = shapes.get(txid);
  if (!p) {
    p = client.decode(txid);
    shapes.set(txid, p);
    p.catch(() => shapes.delete(txid));
  }
  return p;
}

/** The runner that answered for each subscription id, in memory only, so later polls go straight to it. */
const holders = new Map<string, Runner>();
async function fetchSubscription(id: string, signal: AbortSignal): Promise<{ sub: Subscription; runner: Runner }> {
  const known = holders.get(id);
  if (known) return { sub: await known.api.getSubscription(id, signal), runner: known };
  const { value, runner } = await askRunners((c) => c.getSubscription(id, signal));
  holders.set(id, runner);
  return { sub: value, runner };
}

/** The decode of `txid` by the subscription's runner, asked again (from the cache) whenever `poll` changes. */
function useShape(txid: string | undefined, client: CadenceClient, poll: unknown): { shape?: Shape; error?: Error } {
  const [state, setState] = useState<{ shape?: Shape; error?: Error }>({});
  useEffect(() => {
    if (!txid) return;
    let alive = true;
    decodeOnce(txid, client).then(
      (shape) => alive && setState({ shape }),
      (error: Error) => alive && setState((s) => (s.shape ? s : { error })),
    );
    return () => {
      alive = false;
    };
  }, [txid, client, poll]);
  return state;
}

function ShapeCell({ inst, network, client, poll }: { inst: Installment; network: NetworkId | undefined; client: CadenceClient; poll: unknown }) {
  const mined = inst.state === 'mined' && inst.txid ? inst.txid : undefined;
  const { shape, error } = useShape(mined, client, poll);
  if (!mined) return <span className="faint">—</span>;
  if (shape && network) {
    const s = summarizeShape(shape, network);
    return (
      <span className="row" style={{ ['--gap' as string]: '4px' }}>
        <Badge title={`consensus branch ${shape.branch_id}`}>{s.branch}</Badge>
        <Badge title="expiry height relative to the target height">{s.delta === null ? 'target + ?' : `target + ${s.delta}`}</Badge>
        <Badge title="Ironwood value balance">{s.fee === null ? 'no fee' : `fee ${n(s.fee)}`}</Badge>
        <Badge tone={s.passing === s.total ? 'green' : 'red'} title="Cadence invariants, as on the decoder page">
          {s.passing}/{s.total} invariants
        </Badge>
      </span>
    );
  }
  if (error) return <span className="tiny muted" title={error.message}>decode unavailable</span>;
  return <Spinner />;
}

function InstallmentRows({ sub, network, crossing, client, poll }: { sub: Subscription; network: NetworkId | undefined; crossing: Nu7Crossing; client: CadenceClient; poll: unknown }) {
  return (
    <div className="table-wrap">
      <table className="data stackable">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">State</th>
            <th scope="col" className="r">
              Amount
            </th>
            <th scope="col">Release · drand round</th>
            <th scope="col">Txid</th>
            <th scope="col" className="r">
              Mined height
            </th>
            <th scope="col">Shape</th>
          </tr>
        </thead>
        <tbody>
          {byK(sub).map((i) => (
            <tr key={i.k}>
              <td data-label="Installment" className="mono">
                {i.k}
              </td>
              <td data-label="State" className="wide">
                <span className="row" style={{ ['--gap' as string]: '6px' }}>
                  <StateBadge state={i.state} />
                  {crossing.kind === 'crossed' && crossing.k === i.k && (
                    <Badge tone="sealed" title={`This mandate's first installment mined at or after NU7 activation (height ${n(crossing.nu7)})`}>
                      first Cadence installment after NU7
                    </Badge>
                  )}
                </span>
                <div className="tiny muted" style={{ marginTop: 6, maxWidth: 320 }}>
                  {installmentNote(i, sub.status)}
                </div>
              </td>
              <td data-label="Amount" className="r mono num nowrap">
                {network ? formatZec(i.amount_zat, network) : '…'}
              </td>
              <td data-label="Release · drand round">
                <div className="small text-2 nowrap">{formatDateTime(i.release_at)}</div>
                {i.state === 'sealed' && sub.status === 'active' && (
                  <div className="tiny">
                    <Countdown at={i.release_at} />
                  </div>
                )}
                <div className="tiny faint">
                  round <Round round={i.release_round} />
                </div>
              </td>
              <td data-label="Txid" className="nowrap">
                {i.txid ? <Txid value={i.txid} head={6} tail={4} /> : <span className="faint mono">—</span>}
              </td>
              <td data-label="Mined height" className="r mono num nowrap">
                {i.mined_height ? n(i.mined_height) : <span className="faint">—</span>}
              </td>
              <td data-label="Shape">
                <ShapeCell inst={i} network={network} client={client} poll={poll} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Nu7Note({ crossing }: { crossing: Nu7Crossing }) {
  if (crossing.kind === 'crossed')
    return (
      <Callout kind="info">
        <span className="small">
          <strong>This mandate crosses NU7</strong> (mainnet height {n(crossing.nu7)}). Installment {crossing.k} is its first installment mined at or after that height, at{' '}
          {n(crossing.minedHeight)}: the first Cadence installment after NU7. The runner broadcasts only a rung whose branch and expiry match its target height (NU6.3 and target +
          40 before NU7, NU7 and target + 120 from it); the Shape column shows what each mined installment carries.
        </span>
      </Callout>
    );
  if (crossing.kind === 'ahead')
    return (
      <Callout kind="plain">
        <span className="small">
          NU7 activates at mainnet height {n(crossing.nu7)}, {n(crossing.blocks)} blocks after the runner's tip ({n(crossing.tip)}); at 75-second blocks that is roughly{' '}
          {formatRelative(crossing.etaSecs)}, an estimate. The first installment of this mandate mined at or after that height will be marked here as the first Cadence installment
          after NU7.
        </span>
      </Callout>
    );
  return null;
}

function NextDue({ sub }: { sub: Subscription }) {
  const next = nextDue(sub);
  if (!next) {
    const why = sub.status === 'completed' ? 'every installment is paid' : sub.status === 'active' ? 'nothing left to release' : 'nothing further pays';
    return <Stat label="Next due" value="—" sub={why} />;
  }
  const value = next.state === 'sealed' ? <Countdown at={next.release_at} /> : next.state === 'due' ? 'opened' : 'in the mempool';
  return <Stat label="Next due" value={value} sub={`installment ${next.k} · ${formatDateTime(next.release_at)}`} />;
}

function SubscriptionForm() {
  const [value, setValue] = useState('');
  const id = value.trim();
  const valid = subscriptionIdFromFragment(`#sub=${encodeURIComponent(id)}`) !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) navigate(`/status#sub=${id}`);
  };
  return (
    <form className="row" style={{ ['--gap' as string]: '8px' }} onSubmit={submit}>
      <label htmlFor="sub-id" className="sr-only">
        Subscription id
      </label>
      <input
        id="sub-id"
        className="input mono"
        style={{ flex: '1 1 320px' }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sub_…"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={value.length > 0 && !valid}
      />
      <button type="submit" className="btn primary" disabled={!valid}>
        <SearchIcon size={15} /> Show
      </button>
    </form>
  );
}

/** The fragment's subscription id. A fragment without one (such as the skip link's #main) keeps the last id. */
function useSubscriptionId(): { id: string | null; malformed: boolean } {
  const { hash } = useLocation();
  const last = useRef<string | null>(null);
  const fromHash = subscriptionIdFromFragment(hash);
  const named = fragmentNamesSubscription(hash);
  if (fromHash) last.current = fromHash;
  else if (named || !hash) last.current = null;
  return { id: last.current, malformed: named && !fromHash };
}

export function Status() {
  useDocumentTitle('Subscription status');
  const { id, malformed } = useSubscriptionId();
  const sub = usePoll((signal) => (id ? fetchSubscription(id, signal) : Promise.resolve(undefined)), id ? POLL_MS : 0, [id]);
  const answered = sub.data?.sub.subscription_id === id ? sub.data : undefined;
  const data = answered?.sub;
  // The network and tip are the answering runner's own: on an app host a mainnet subscription is the mainnet runner's.
  const runner = answered?.runner ?? defaultRunner;
  const status = usePoll(async (signal) => ({ runner, status: await runner.api.status(signal) }), POLL_MS, [runner]);
  const ownStatus = status.data?.runner === runner ? status.data.status : undefined;
  const network = ownStatus?.network;
  const crossing = data ? nu7Crossing(data, network, ownStatus?.tip) : ({ kind: 'none' } as const);
  const missing = sub.error instanceof ApiError && sub.error.status === 404;
  const { paid, total } = data ? paidOf(data) : { paid: 0, total: 0 };

  return (
    <div className="page container">
      <PageHead
        kicker="Demo"
        title="Subscription status"
        lede={`One subscription as ${manyRunners ? 'its' : 'this'} runner reports it, refreshed every 30 seconds. The id is read from the link's fragment (#sub=…); the page keeps nothing in your browser.`}
      >
        {!id && <SubscriptionForm />}
      </PageHead>

      {malformed && <Callout kind="danger">That is not a subscription id: one looks like sub_ followed by letters and digits.</Callout>}

      {id && (
        <div className="stack" style={{ ['--gap' as string]: '20px' }}>
          <section className="card stack" style={{ ['--gap' as string]: '16px' }} aria-labelledby="status-sub">
            <div className="row between">
              <div className="stack" style={{ ['--gap' as string]: '4px', minWidth: 0 }}>
                <span className="kicker plain">Subscription</span>
                <span id="status-sub" className="row mono small break" style={{ ['--gap' as string]: '6px' }}>
                  {id}
                  <CopyButton text={id} label="Copy subscription id" />
                </span>
              </div>
              {data && <StatusBadge status={data.status} lg />}
            </div>
            {data && <p className="small text-2">{subscriptionStatusInfo(data.status).description}</p>}
            {data && manyRunners && <p className="tiny muted">Reported by {runnerName(runner, network)}.</p>}

            {missing ? (
              <Callout kind="warn">{manyRunners ? `No runner this app knows (${runnersText}) has a subscription with that id.` : 'This runner has no subscription with that id.'}</Callout>
            ) : (
              sub.error && <ErrorNote error={sub.error} retry={sub.refresh} />
            )}
            {!data && !sub.error && <Spinner label="Asking the runner…" />}

            {data && (
              <div className="stat-strip">
                <Stat label="Paid" value={`${paid} of ${total}`} sub="installments mined" />
                <NextDue sub={data} />
                <Stat
                  label="Network"
                  value={network ? (network === 'main' ? 'Mainnet' : 'Testnet') : '…'}
                  sub={ownStatus ? `runner tip ${n(ownStatus.tip)}` : status.error ? 'runner status unavailable' : undefined}
                />
              </div>
            )}
          </section>

          {data && <Nu7Note crossing={crossing} />}

          {data && (
            <section className="card stack" style={{ ['--gap' as string]: '12px' }} aria-labelledby="status-installments">
              <h2 id="status-installments" className="h3">
                Installments
              </h2>
              <InstallmentRows sub={data} network={network} crossing={crossing} client={runner.api} poll={sub.data} />
              <p className="tiny muted">
                Each installment is a package time-locked to a drand round: it opens at that round (the drand network's threshold assumption), and the release time is when drand
                publishes it. Missed: {MISSED_NOTE.charAt(0).toLowerCase() + MISSED_NOTE.slice(1)} Txids open in this app's decoder.
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
