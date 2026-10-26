import { useMemo, useState, type FormEvent } from 'react';
import type { NetworkId, Shape } from '../api/types';
import { CheckIcon, SearchIcon, XIcon } from '../components/Icons';
import { ObserverSummary, ShapeTable } from '../components/ShapeTable';
import { Badge, Callout, CopyButton, ErrorNote, PageHead, Spinner } from '../components/ui';
import { S2_RUN, findS2Shape } from '../data/s2';
import { STOCK_SEND_REFERENCE, type ShapeProfile } from '../data/stockReference';
import { useDocumentTitle, usePoll } from '../hooks';
import { cadenceChecks, impliedTarget, stockShapeAt } from '../lib/shape';
import { Link, navigate, useLocation } from '../router';
import { api, isMock } from '../runtime';

const HEX64 = /^[0-9a-f]{64}$/;

function TxidForm({ initial, compare }: { initial: string; compare: string | null }) {
  const [value, setValue] = useState(initial);
  const clean = value.trim().toLowerCase();
  const valid = HEX64.test(clean);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) navigate(`/decode/${clean}${compare ? `?compare=${compare}` : ''}`);
  };
  return (
    <form className="row" style={{ ['--gap' as string]: '8px' }} onSubmit={submit} role="search">
      <label htmlFor="txid" className="sr-only">
        Transaction id
      </label>
      <input
        id="txid"
        className="input mono"
        style={{ flex: '1 1 420px' }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste any txid (64 hex characters)"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={value.length > 0 && !valid}
      />
      <button type="submit" className="btn primary" disabled={!valid}>
        <SearchIcon size={15} /> Decode
      </button>
    </form>
  );
}

function CompareForm({ txid, compare }: { txid: string; compare: string | null }) {
  const [value, setValue] = useState(compare ?? '');
  const clean = value.trim().toLowerCase();
  return (
    <form
      className="row"
      style={{ ['--gap' as string]: '8px' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (HEX64.test(clean)) navigate(`/decode/${txid}?compare=${clean}`);
      }}
    >
      <div className="segmented" role="group" aria-label="Compare against">
        <button type="button" aria-pressed={!compare} onClick={() => navigate(`/decode/${txid}`)}>
          Stock send (reference)
        </button>
        <button type="button" aria-pressed={!!compare} onClick={() => document.getElementById('compare-txid')?.focus()}>
          Another txid
        </button>
      </div>
      <label htmlFor="compare-txid" className="sr-only">
        Compare with txid
      </label>
      <input id="compare-txid" className="input mono" style={{ flex: '1 1 260px', height: 36 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder="txid of a stock wallet send" spellCheck={false} />
      <button type="submit" className="btn sm" disabled={!HEX64.test(clean)}>
        Compare
      </button>
    </form>
  );
}

function Examples() {
  return (
    <div className="stack" style={{ ['--gap' as string]: '10px' }}>
      <span className="small muted">Real installments from the S2 run on NU7 testnet:</span>
      <div className="grid cols-3" style={{ ['--gap' as string]: '10px' }}>
        {S2_RUN.installments.map((i) => (
          <Link key={i.txid} to={`/decode/${i.txid}`} className="card tight flat" style={{ textDecoration: 'none' }}>
            <div className="row between">
              <span className="h4">Installment {i.k}</span>
              <Badge tone="green">mined {i.mined_height.toLocaleString('en-US')}</Badge>
            </div>
            <div className="mono tiny muted" style={{ marginTop: 6 }}>
              {i.txid.slice(0, 20)}…
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** A runner on another network cannot find the S2 testnet txids; their decodes ship with the app. */
function decodeOrEvidence(txid: string, signal: AbortSignal): Promise<Shape> {
  return api.decode(txid, signal).catch((e: unknown) => {
    const s2 = findS2Shape(txid);
    if (s2 && !signal.aborted) return s2;
    throw e;
  });
}

export function Decode({ txid }: { txid: string | null }) {
  const { search } = useLocation();
  const compareTxid = search.get('compare');
  const valid = txid !== null && HEX64.test(txid);
  useDocumentTitle(txid ? `Decode ${txid.slice(0, 8)}…` : 'Decoder');

  const shape = usePoll((signal) => (valid ? decodeOrEvidence(txid!, signal) : Promise.reject(new Error('not a txid'))), 0, [txid]);
  const compare = usePoll(
    (signal) => (compareTxid && HEX64.test(compareTxid) ? api.decode(compareTxid, signal) : Promise.resolve(null)),
    0,
    [compareTxid],
  );
  // The runner decodes through its own lightwalletd, so its network is the transaction's: the
  // fee rule and the stock reference depend on it.
  const status = usePoll((signal) => api.status(signal), 0);
  const evidence = valid && !!findS2Shape(txid!);
  const network: NetworkId | undefined = evidence ? 'test' : status.data?.network;

  const profile: ShapeProfile | null = useMemo(() => {
    if (!compareTxid) {
      // The reference moved to this transaction's target height, with that height's branch, expiry delta and fee.
      const target = shape.data ? impliedTarget(shape.data) : null;
      if (!network || target === null) return STOCK_SEND_REFERENCE;
      return { ...STOCK_SEND_REFERENCE, shape: stockShapeAt(STOCK_SEND_REFERENCE.shape, network, target) };
    }
    if (!compare.data) return null;
    return { shape: compare.data, title: `Transaction ${compareTxid.slice(0, 10)}…`, source: 'decoded', note: `Decoded by the runner from ${compareTxid}` };
  }, [compareTxid, compare.data, shape.data, network]);

  const checks = shape.data && network ? cadenceChecks(shape.data, network) : [];
  const passing = checks.filter((c) => c.pass).length;

  return (
    <div className="page container">
      <PageHead
        kicker="Evidence"
        title="What the chain sees"
        lede="The public shape of any transaction, read through the runner's lightwalletd: the same fields cadence-decode prints. Compare an installment with a stock wallet send, on every measured field."
      >
        <TxidForm initial={txid ?? ''} compare={compareTxid} />
      </PageHead>

      {!txid && <Examples />}
      {txid && !valid && <Callout kind="danger">That is not a txid: a txid is 64 hexadecimal characters.</Callout>}

      {valid && (
        <div className="stack" style={{ ['--gap' as string]: '24px' }}>
          <div className="card">
            <div className="card-head">
              <div className="stack" style={{ ['--gap' as string]: '6px', minWidth: 0 }}>
                <span className="kicker plain">Transaction</span>
                <span className="row mono small break" style={{ ['--gap' as string]: '6px' }}>
                  {txid}
                  <CopyButton text={txid!} label="Copy txid" />
                </span>
                <span className="tiny muted">
                  {evidence
                    ? 'Real decode from evidence/S2-testnet.md (cadence-decode against NU7 testnet).'
                    : isMock
                      ? 'Synthesised by the mock runner with the same rules as the S2 evidence.'
                      : "Decoded by the runner from its lightwalletd's copy of the transaction."}
                </span>
              </div>
              {shape.data && network && (
                <Badge tone={passing === checks.length ? 'green' : 'red'} lg dot>
                  {passing} / {checks.length} Cadence invariants hold
                </Badge>
              )}
            </div>

            {(shape.loading || (shape.data && !network && !status.error)) && <Spinner label="Decoding…" />}
            {shape.error && <ErrorNote error={shape.error} retry={shape.refresh} />}
            {shape.data && !network && status.error && <ErrorNote error={new Error(`Could not ask the runner which network it is on: ${status.error.message}`)} retry={status.refresh} />}

            {shape.data && network && (
              <div className="stack" style={{ ['--gap' as string]: '20px' }}>
                <div className="row" style={{ ['--gap' as string]: '6px' }}>
                  {checks.map((c) => (
                    <span key={c.id} className={`badge ${c.pass ? 'tone-green' : 'tone-red'}`} title={c.detail}>
                      {c.pass ? <CheckIcon size={11} /> : <XIcon size={11} />} {c.label}
                    </span>
                  ))}
                </div>
                <CompareForm key={compareTxid ?? ''} txid={txid!} compare={compareTxid} />
                {compare.error && <ErrorNote error={compare.error} />}
                {profile && (
                  <p className="tiny muted" style={{ marginTop: -8 }}>
                    {profile.note}
                  </p>
                )}
                <ShapeTable shape={shape.data} compare={profile} network={network} />
                {shape.data.ironwood_nullifiers && <Nullifiers revealed={shape.data.ironwood_nullifiers} expected={search.get('nf')} />}
                <details className="disclosure">
                  <summary>Raw shape JSON</summary>
                  <div className="body">
                    <pre className="code-block">{JSON.stringify(shape.data, null, 2)}</pre>
                  </div>
                </details>
              </div>
            )}
          </div>

          <div className="stack" style={{ ['--gap' as string]: '14px' }}>
            <div className="stack" style={{ ['--gap' as string]: '6px' }}>
              <span className="kicker">Chain observer</span>
              <h2 className="h3">What anyone watching the chain can and cannot tell</h2>
            </div>
            <ObserverSummary fee={shape.data?.ironwood_value_balance} />
          </div>

          {!evidence && <Examples />}
        </div>
      )}
    </div>
  );
}

/** The nullifiers the transaction reveals; with ?nf=, whether a cancellation certificate's note is among them. */
function Nullifiers({ revealed, expected }: { revealed: string[]; expected: string | null }) {
  const want = expected?.toLowerCase() ?? null;
  const found = want !== null && revealed.includes(want);
  return (
    <div className="stack" style={{ ['--gap' as string]: '6px' }}>
      <span className="h4">Nullifiers this transaction reveals</span>
      {want !== null && (
        <Callout kind={found ? 'ok' : 'danger'}>
          {found
            ? 'It reveals the nullifier from your cancellation certificate: that pocket note is spent, so no installment that spends it can ever be valid.'
            : 'It does not reveal the nullifier in your link. This is not the transaction that spent that note.'}
        </Callout>
      )}
      <ul className="stack mono tiny" style={{ ['--gap' as string]: '2px', listStyle: 'none', padding: 0, margin: 0 }}>
        {revealed.map((nf) => (
          <li key={nf} className={nf === want ? 'nf-match' : 'muted'}>
            {nf}
          </li>
        ))}
      </ul>
      <span className="tiny muted">Every Ironwood action reveals one nullifier; a note can be spent only once, so a nullifier can appear on chain only once.</span>
    </div>
  );
}

