/**
 * /manage: cancel with a saved cancel key, long after the subscribe tab is gone.
 *
 * The key file is decrypted in a worker (scrypt, a few seconds) and loaded into a
 * fresh signer in this tab's memory only. Leaving or reloading the page zeroises
 * it. The page asks this runner for the pocket's status and, to cancel, a witness;
 * the runner relays the cancel. When the runner cannot help (unreachable, another
 * runner, or it has already deleted the pocket), it shows the CLI command that
 * recovers the funds without any runner.
 */
import { useState } from 'react';
import { ApiError } from '../api/client';
import type { PocketState, Subscription } from '../api/types';
import { Command } from '../components/CancelKey';
import { CancelPanel, CancelReceiptView } from '../components/FlowViews';
import { KeyIcon } from '../components/Icons';
import { Timeline } from '../components/Timeline';
import { Callout, CopyButton, ErrorNote, PageHead, Spinner, StatusBadge } from '../components/ui';
import { createStore, useDocumentTitle, usePoll, useStore } from '../hooks';
import { shorten } from '../lib/addresses';
import { formatDateTime, formatPeriod } from '../lib/time';
import { formatZec, INSTALLMENT_FEE_ZAT } from '../lib/zat';
import { api, createSigner, isMock, runnerUrl } from '../runtime';
import { checkPocketState } from '../signer/cancel';
import { cliCancelCommand, cliSweepCommand, kitTargetProblem, type KitFields, type KitTargetProblem, type OpenedKit } from '../signer/kit';
import type { CancelReceipt, Signer } from '../signer/types';

/** What the page keeps of an opened key: no seed, and no note contents. */
type KitSummary = Omit<KitFields, 'notes'> & { notes: Array<{ k: number; value_zat: number }> };

interface ManageState {
  signer: Signer | null;
  fileName: string | null;
  kit: KitSummary | null;
  problem: KitTargetProblem | null;
  opening: boolean;
  error?: string;
  cancel: CancelReceipt | null;
}

/** In memory only. The signer (and its seed) is destroyed when the page goes away. */
const store = createStore<ManageState>(() => ({ signer: null, fileName: null, kit: null, problem: null, opening: false, cancel: null }));

function forget() {
  store.get().signer?.destroy();
  store.reset();
}

if (typeof window !== 'undefined') {
  // A reload, a closed tab, or a jump to another site: drop the key. A page restored
  // from the back-forward cache starts over too.
  window.addEventListener('pagehide', forget);
  window.addEventListener('pageshow', (e) => e.persisted && forget());
}

function summarize(f: KitFields): KitSummary {
  return { ...f, notes: f.notes.map(({ k, value_zat }) => ({ k, value_zat })) };
}

const MAX_KIT_BYTES = (1 << 20) + 64 * 1024;

async function openKit(file: File, passphrase: string) {
  if (store.get().opening) return;
  store.get().signer?.destroy();
  store.set({ opening: true, error: undefined, problem: null, signer: null, kit: null, cancel: null });
  const signer = createSigner();
  let opened: OpenedKit | null = null;
  try {
    if (file.size > MAX_KIT_BYTES) throw new Error('this file is too large to be a cancel key');
    opened = await signer.openKit(new Uint8Array(await file.arrayBuffer()), passphrase);
    const kit = summarize(opened.fields);
    // The runner's own network; if it cannot be reached, the pocket status says so below.
    const network = await api.status().then((s) => s.network, () => undefined);
    const problem = kitTargetProblem(opened.fields, { runner: runnerUrl, network });
    if (problem) {
      opened.seed.fill(0);
      signer.destroy();
      store.set({ opening: false, fileName: file.name, kit, problem });
      return;
    }
    await signer.restore(opened);
    store.set({ opening: false, fileName: file.name, kit, signer });
  } catch (e) {
    opened?.seed.fill(0);
    signer.destroy();
    store.set({ opening: false, error: (e as Error).message });
  }
}

function LoadKey() {
  const s = useStore(store);
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  return (
    <form
      className="card stack"
      style={{ ['--gap' as string]: '16px' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!file || !pass || s.opening) return;
        void openKit(file, pass).then(() => setPass(''));
      }}
    >
      <div className="row no-wrap top" style={{ ['--gap' as string]: '10px' }}>
        <KeyIcon size={20} className="accent" />
        <div className="stack" style={{ ['--gap' as string]: '4px' }}>
          <h2 className="h3">Load your cancel key</h2>
          <p className="small text-2">
            The <span className="mono">cadence-cancel-key-….age</span> file you saved when you subscribed, and its passphrase. It is decrypted in this tab and never sent anywhere.
          </p>
        </div>
      </div>
      <div className="grid cols-2" style={{ ['--gap' as string]: '12px' }}>
        <div className="field">
          <label htmlFor="kit-file">Cancel key file</label>
          <input
            id="kit-file"
            className="input"
            type="file"
            accept={isMock ? '.mock,application/octet-stream' : '.age,application/octet-stream'}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={s.opening}
          />
        </div>
        <div className="field">
          <label htmlFor="kit-open-pass">Passphrase</label>
          <input id="kit-open-pass" className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={s.opening} />
        </div>
      </div>
      {s.error && <ErrorNote error={new Error(s.error)} />}
      <div className="row">
        <button type="submit" className="btn primary" disabled={!file || !pass || s.opening}>
          {s.opening ? 'Decrypting (a few seconds)…' : 'Open cancel key'}
        </button>
      </div>
    </form>
  );
}

/** The CLI route: works with no runner at all. */
function SweepFallback({ kit, fileName, why, prominent }: { kit: KitSummary; fileName: string; why: string; prominent?: boolean }) {
  const body = (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <span className="small">{why}</span>
      <Command text={cliSweepCommand(fileName)} />
      <span className="tiny muted">
        <code>cadence sweep</code> needs no runner: it rebuilds the pocket's view from the seed in the key, scans the chain from the funding height
        {kit.funding_height ? ` (block ${kit.funding_height.toLocaleString('en-US')})` : ''} through a lightwalletd server over Tor, and sends whatever is left, less the fee, to your
        address. It asks for the key's passphrase. From a Cadence checkout, <code>cargo run --release -p cadence-cli -- sweep …</code> runs the same.
      </span>
    </div>
  );
  return prominent ? <Callout kind="warn">{body}</Callout> : <div className="panel">{body}</div>;
}

function Restored({ kit, signer, fileName }: { kit: KitSummary; signer: Signer; fileName: string }) {
  const s = useStore(store);
  // The mock runner has no pocket endpoints; its subscription status stands in.
  const pocket = usePoll<PocketState | undefined>((signal) => (isMock ? Promise.resolve(undefined) : api.getPocket(kit.pocket_id, signal).then(checkPocketState)), 15_000, [kit.pocket_id]);
  const sub = usePoll<Subscription | undefined>((signal) => (kit.subscription_id ? api.getSubscription(kit.subscription_id, signal) : Promise.resolve(undefined)), 10_000, [kit.subscription_id]);
  const data = sub.data;
  // A stalled subscription (a missed or invalid installment) can still be cancelled.
  const settled = data && (data.status === 'completed' || data.status === 'cancelled' || data.status === 'stopped');
  const left = pocket.data?.notes.reduce((a, n) => a + n.value_zat, 0);
  // Change left after the final installment: only when the pocket was funded with more than the schedule needs.
  const afterLast = kit.notes.find((n) => n.k === kit.count)?.value_zat ?? 0;

  const pocketGone = pocket.error instanceof ApiError && pocket.error.status === 404;
  const unreachable = (pocket.error instanceof ApiError && pocket.error.status === 0) || (sub.error instanceof ApiError && sub.error.status === 0);
  // While installments are still to come, an empty list is the runner catching up
  // with the latest one (or with a cancel), not an empty pocket.
  const pending = data && (data.status === 'active' || data.status === 'stalled') && data.installments.some((i) => i.state !== 'mined');
  const empty = !isMock && pocket.data && pocket.data.notes.length === 0 && !pocket.data.syncing && !pending;

  let fallback: { why: string; prominent: boolean } | null = null;
  if (unreachable) fallback = { why: 'The runner cannot be reached right now. Your funds do not depend on it: the CLI can return what is left in the pocket on its own.', prominent: true };
  else if (pocketGone) fallback = { why: 'This runner does not know this pocket (it may have been reset). If the pocket still holds funds, sweep it with the CLI.', prominent: true };
  else if (empty && data?.status === 'stopped') fallback = { why: 'The merchant stopped this subscription and the runner deleted the pocket. What is left in it is yours: sweep it with the CLI.', prominent: true };
  else if (empty && afterLast > INSTALLMENT_FEE_ZAT) fallback = { why: `The runner no longer tracks this pocket, but about ${formatZec(afterLast, kit.network)} was left after the last installment (the pocket was funded with more than the schedule needs). Sweep it with the CLI.`, prominent: true };
  else if (empty) fallback = { why: 'The runner lists no unspent note for this pocket, so there is nothing to cancel. If you expected funds back and do not see them, the CLI checks the chain itself:', prominent: false };

  return (
    <div className="stack" style={{ ['--gap' as string]: '20px' }}>
      <section className="card stack" style={{ ['--gap' as string]: '16px' }}>
        <div className="row between">
          <div className="stack" style={{ ['--gap' as string]: '2px' }}>
            <span className="h3">{kit.label || kit.offer_id}</span>
            <span className="mono tiny muted">{kit.subscription_id ?? 'no subscription id in this key'}</span>
          </div>
          {data && <StatusBadge status={data.status} lg />}
        </div>
        <dl className="kv">
          <dt>Schedule</dt>
          <dd>
            {kit.count} × {formatZec(kit.amount_zat, kit.network)} {formatPeriod(kit.period_secs)}, from {formatDateTime(kit.first_release_at)}
          </dd>
          <dt>Pays to</dt>
          <dd className="row" style={{ ['--gap' as string]: '6px' }}>
            <span className="mono small">{shorten(kit.merchant_ua, 14, 8)}</span>
            <CopyButton text={kit.merchant_ua} label="Copy merchant address" />
          </dd>
          <dt>Pocket</dt>
          <dd className="row" style={{ ['--gap' as string]: '6px' }}>
            <span className="mono small">
              {kit.pocket_id} · {shorten(kit.pocket_ua, 12, 6)}
            </span>
            <CopyButton text={kit.pocket_ua} label="Copy pocket address" />
          </dd>
          <dt>Left in the pocket</dt>
          <dd>
            {isMock ? (
              <span className="small muted">the mock runner does not report it</span>
            ) : pocket.data ? (
              <span className="mono">{formatZec(left ?? 0, kit.network)}</span>
            ) : pocket.error ? (
              <span className="small muted">unknown</span>
            ) : (
              <Spinner />
            )}
            {pocket.data && pocket.data.notes.length > 0 && <span className="small muted"> · as of block {pocket.data.tip.toLocaleString('en-US')}</span>}
          </dd>
          <dt>Key file</dt>
          <dd className="mono small">{fileName}</dd>
        </dl>
        {sub.error && !unreachable && <ErrorNote error={sub.error} retry={sub.refresh} />}
        {pocket.error && !unreachable && !pocketGone && <ErrorNote error={pocket.error} retry={pocket.refresh} />}
        {data ? <Timeline installments={data.installments} network={kit.network} /> : kit.subscription_id && !sub.error && <Spinner label="Asking the runner…" />}
      </section>

      <section className="card stack" style={{ ['--gap' as string]: '12px' }} aria-labelledby="manage-cancel">
        <h2 id="manage-cancel" className="h3">
          Cancel
        </h2>
        {s.cancel ? (
          <CancelReceiptView receipt={s.cancel} network={kit.network} />
        ) : fallback ? (
          <SweepFallback kit={kit} fileName={fileName} {...fallback} />
        ) : (
          <CancelPanel
            signer={signer}
            network={kit.network}
            showDemo={isMock}
            disabled={settled ? `This subscription is ${data!.status}; there is nothing left to cancel.` : undefined}
            onCancelled={(r) => store.set({ cancel: r })}
          />
        )}
      </section>

      {!fallback?.prominent && (
        <details className="disclosure">
          <summary>Without this runner</summary>
          <div className="stack" style={{ ['--gap' as string]: '10px', marginTop: 10 }}>
            <span className="small text-2">The same key works with the CLI, which cancels through this runner:</span>
            <Command text={cliCancelCommand(fileName)} />
            <SweepFallback kit={kit} fileName={fileName} why="Or, with no runner at all, return everything left in the pocket:" />
          </div>
        </details>
      )}

      <div className="row">
        <button type="button" className="btn ghost sm" onClick={forget}>
          Forget this key
        </button>
      </div>
    </div>
  );
}

function WrongPlace({ kit, fileName, problem }: { kit: KitSummary; fileName: string; problem: KitTargetProblem }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      <Callout kind="warn">
        <div className="stack" style={{ ['--gap' as string]: '8px' }}>
          <strong>{problem.message}</strong>
          <span className="small">This page forgot the key again. With the CLI, cancel through the key's own runner:</span>
          <Command text={cliCancelCommand(fileName)} />
        </div>
      </Callout>
      <SweepFallback kit={kit} fileName={fileName} why="Or return everything left in the pocket with no runner at all:" />
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={forget}>
          Load another key
        </button>
      </div>
    </div>
  );
}

export function Manage() {
  useDocumentTitle('Manage');
  // Leaving for another page of this app keeps the key, as Subscribe does; a reload never does.
  const s = useStore(store);
  return (
    <div className="page container narrow">
      <PageHead
        kicker="Manage"
        title="Cancel with your cancel key"
        lede="Load the cancel key you saved when you subscribed. Cancelling returns what is left in the pocket, less the network fee, to an address of your own, and no later installment can be valid."
      />
      {s.kit && s.fileName && s.problem ? (
        <WrongPlace kit={s.kit} fileName={s.fileName} problem={s.problem} />
      ) : s.kit && s.fileName && s.signer ? (
        <Restored kit={s.kit} signer={s.signer} fileName={s.fileName} />
      ) : (
        <LoadKey />
      )}
      <p className="tiny muted" style={{ marginTop: 20 }}>
        The key stays in this tab's memory and is forgotten when you leave or reload the page. This page talks only to {isMock ? 'the in-page mock runner' : runnerUrl}: it asks it for
        the pocket's status and a witness to prove the cancel, and the runner relays the cancel. The merchant learns that you cancelled; it cannot see where the refund goes.
      </p>
    </div>
  );
}
