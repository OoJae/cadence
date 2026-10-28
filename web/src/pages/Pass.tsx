/**
 * /pass: check an access pass. The page decodes the pass, finds the
 * runner that signed it among the runners this build knows (by the network the pass
 * names), verifies the Ed25519 signature in this tab against that runner's pass key,
 * and asks the runner's own verify endpoint as a second opinion. It also shows a
 * merchant how to make the same check on their own server.
 */
import { useRef, useState, type FormEvent } from 'react';
import { hasFeature } from '../api/client';
import type { NetworkId, Offer, PassKey, PassVerifyResponse, RunnerStatus } from '../api/types';
import { Badge, Callout, CopyButton, Countdown, ErrorNote, PageHead, Spinner } from '../components/ui';
import { useDocumentTitle, useNow, usePoll } from '../hooks';
import { shorten } from '../lib/addresses';
import { findPassIssuer, MERCHANT_CHECK_EXAMPLE, parsePass, passNetworkName, type ParsedPass, type PassIssuer } from '../lib/pass';
import { formatDateTime, formatPeriod } from '../lib/time';
import { formatZec } from '../lib/zat';
import { isMock, runnerName, runners, type Runner } from '../runtime';

interface Support {
  runner: Runner;
  status?: RunnerStatus;
  key?: PassKey;
}

/** Each known runner's network and whether it issues passes, with its pass key if so. */
function askSupport(signal: AbortSignal): Promise<Support[]> {
  return Promise.all(
    runners.map(async (runner) => {
      const status = await runner.api.status(signal).catch(() => undefined);
      const key = hasFeature(status, 'pass') ? await runner.api.passKey(signal).catch(() => undefined) : undefined;
      return { runner, status, key };
    }),
  );
}

interface Checked {
  parsed: ParsedPass;
  issuer?: PassIssuer<Runner>;
  /** The offer the pass names, from the runner that signed it (null if it would not say). */
  offer?: Offer | null;
  /** The runner's own verdict, or why it could not be asked. */
  second?: PassVerifyResponse | Error;
}

async function checkPass(text: string, signal?: AbortSignal): Promise<Checked> {
  const parsed = parsePass(text);
  if (!parsed.ok) return { parsed };
  // The default runner first, then the others; the one on the pass's network whose key verifies it.
  const issuer = await findPassIssuer(parsed, runners, signal);
  if (issuer.kind !== 'signed' && issuer.kind !== 'bad-signature') return { parsed, issuer };
  const api = issuer.runner.api;
  const [offer, second] = await Promise.all([
    issuer.kind === 'signed' ? api.getOffer(parsed.payload.offer_id, signal).catch(() => null) : Promise.resolve(null),
    api.verifyPass(text, signal).catch((e: Error) => e),
  ]);
  return { parsed, issuer, offer, second };
}

const nameOf = (runner: Runner, network: NetworkId | undefined) => (isMock ? 'the in-page mock runner' : runnerName(runner, network));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function SupportNote({ support }: { support: Support[] }) {
  const answered = support.filter((s) => s.status);
  const issuing = answered.filter((s) => hasFeature(s.status, 'pass'));
  const older = answered.filter((s) => !hasFeature(s.status, 'pass'));
  if (!answered.length) return null;
  const olderNames = capital(older.map((s) => nameOf(s.runner, s.status?.network)).join(' and '));
  if (!issuing.length) {
    return (
      <Callout kind="info">
        {olderNames} {older.length > 1 ? "don't" : "doesn't"} issue access passes: {older.length > 1 ? 'their statuses list' : 'its status lists'} no <code>pass</code> feature,
        so {older.length > 1 ? 'they run' : 'it runs'} a Cadence build from before them. This page still reads a pass, and the steps below check one from any runner that issues
        them.
      </Callout>
    );
  }
  return (
    <div className="stack small text-2" style={{ ['--gap' as string]: '6px' }}>
      {issuing.map((s) => (
        <span key={s.runner.url} className="row" style={{ ['--gap' as string]: '6px' }}>
          <span>
            {capital(nameOf(s.runner, s.status?.network))} issues passes{s.key ? ', signed with the key' : '.'}
          </span>
          {s.key && (
            <>
              <span className="mono" title={s.key.public_key}>
                {shorten(s.key.public_key, 10, 6)}
              </span>
              <CopyButton text={s.key.public_key} label="Copy pass key" />
            </>
          )}
        </span>
      ))}
      {older.length > 0 && (
        <span className="tiny muted">
          {olderNames} {older.length > 1 ? "don't" : "doesn't"} issue passes: {older.length > 1 ? 'they run' : 'it runs'} a Cadence build from before them.
        </span>
      )}
    </div>
  );
}

function Verdict({ checked }: { checked: Checked }) {
  const now = useNow();
  if (!checked.parsed.ok) return <Callout kind="danger">{checked.parsed.problem}</Callout>;
  const p = checked.parsed.payload;
  const issuer = checked.issuer!;
  const net = passNetworkName(p.iss);
  if (issuer.kind === 'no-runner') {
    return (
      <Callout kind="warn">
        This pass says a {net} runner issued it, and this app talks to no {net} runner, so it cannot check the signature here. Check it with that runner's pass key, as below.
      </Callout>
    );
  }
  if (issuer.kind === 'no-pass') {
    return (
      <Callout kind="warn">
        {capital(issuer.runners.map((r) => nameOf(r, p.iss)).join(' and '))} {issuer.runners.length > 1 ? "don't" : "doesn't"} issue access passes: no <code>pass</code> feature
        in {issuer.runners.length > 1 ? 'their statuses' : 'its status'}. This pass did not come from {issuer.runners.length > 1 ? 'them' : 'it'}.
      </Callout>
    );
  }
  const signed = issuer.kind === 'signed';
  const expired = now > p.valid_until;
  const valid = signed && !expired;
  const offer = checked.offer;
  const second = checked.second;
  const disagree = second && !(second instanceof Error) && second.valid !== valid;
  return (
    <div className="card stack" style={{ ['--gap' as string]: '16px' }} aria-live="polite">
      <div className="row between">
        <div className="stack" style={{ ['--gap' as string]: '2px' }}>
          <span className="h3">{offer?.name ?? 'Access pass'}</span>
          <span className="mono tiny muted">{p.sub}</span>
        </div>
        <Badge tone={valid ? 'green' : signed ? 'amber' : 'red'} lg dot>
          {valid ? 'Valid' : signed ? 'Expired' : 'Signature does not verify'}
        </Badge>
      </div>
      {!signed && (
        <Callout kind="danger">
          The signature does not verify with the pass key of {nameOf(issuer.runner, p.iss)}, so nothing in this pass can be trusted. It was altered, or another runner signed it.
        </Callout>
      )}
      <dl className="kv">
        <dt>Offer</dt>
        <dd>
          {offer ? (
            <>
              {offer.count} × {formatZec(offer.amount_zat, offer.network)} {formatPeriod(offer.period_secs)} · <span className="mono small">{p.offer_id}</span>
            </>
          ) : (
            <span className="mono small">{p.offer_id}</span>
          )}
        </dd>
        <dt>Payments made</dt>
        <dd>{offer ? `${p.paid} of ${offer.count}` : p.paid}</dd>
        <dt>Valid until</dt>
        <dd>
          {formatDateTime(p.valid_until)} · <Countdown at={p.valid_until} />
        </dd>
        <dt>Issued</dt>
        <dd>{formatDateTime(p.iat)}</dd>
        <dt>Signed by</dt>
        <dd className="row" style={{ ['--gap' as string]: '6px' }}>
          <span className="small">{nameOf(issuer.runner, p.iss)}</span>
          <span className="mono small" title={issuer.publicKey}>
            {shorten(issuer.publicKey, 10, 6)}
          </span>
          <CopyButton text={issuer.publicKey} label="Copy pass key" />
        </dd>
        <dt>The runner's check</dt>
        <dd>
          {second instanceof Error ? (
            <span className="small muted">could not ask it: {second.message}</span>
          ) : second?.valid ? (
            <span className="small">valid</span>
          ) : (
            <span className="small">not valid{second?.reason ? `: ${second.reason}` : ''}</span>
          )}
        </dd>
      </dl>
      {disagree && (
        <Callout kind="warn">
          The runner and this page disagree. Near the end of a pass that is only the two clocks differing; otherwise trust neither and check the pass on your own server.
        </Callout>
      )}
      <p className="tiny muted">
        This page checked the signature in this tab, with the runner's public key, then asked the runner. The pass names the offer and the subscription, never the payer.
      </p>
    </div>
  );
}

function MerchantCheck() {
  return (
    <section className="card flat stack" style={{ ['--gap' as string]: '12px' }} aria-labelledby="pass-merchant">
      <span className="kicker">For merchants</span>
      <h2 id="pass-merchant" className="h3">
        Check a pass on your own server
      </h2>
      <p className="small text-2">
        A pass is <code>base64url(payload)</code>, a dot, and <code>base64url(signature)</code>. The signature is Ed25519 over the payload bytes exactly as they arrive, with your
        runner's pass key. Fetch that key once from <code>GET /api/passes/key</code> and keep it in your config. For each pass, verify the signature over the payload bytes, then check
        that <code>valid_until</code> is still ahead and that <code>offer_id</code> is your offer. In Node.js:
      </p>
      <div className="row no-wrap top" style={{ ['--gap' as string]: '6px' }}>
        {/* Code keeps its lines: it scrolls sideways in its box rather than breaking mid-word. */}
        <pre className="code-block" style={{ flex: 1, minWidth: 0, margin: 0, whiteSpace: 'pre', wordBreak: 'normal', overflowWrap: 'normal', overflowX: 'auto' }}>
          {MERCHANT_CHECK_EXAMPLE}
        </pre>
        <CopyButton text={MERCHANT_CHECK_EXAMPLE} label="Copy example" />
      </div>
      <p className="small text-2">
        Or let the runner check it: <code>POST /api/passes/verify</code> with <code>{'{"pass": "…"}'}</code> answers <code>valid</code> and a <code>reason</code>.
      </p>
      <p className="tiny muted">
        A pass names the offer and the subscription, which you already know, and never the payer. It is a bearer token: whoever holds it can show it until it lapses, so tie it to a
        session of your own if sharing matters.
      </p>
    </section>
  );
}

export function Pass() {
  useDocumentTitle('Access pass');
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ busy: boolean; result?: Checked; error?: Error } | null>(null);
  const seq = useRef(0);
  const support = usePoll(askSupport, 0);
  const run = async (pass: string) => {
    // Only the latest check lands, if the pass is checked again before the first answers.
    const n = ++seq.current;
    setCheck({ busy: true });
    try {
      const result = await checkPass(pass);
      if (n === seq.current) setCheck({ busy: false, result });
    } catch (e) {
      if (n === seq.current) setCheck({ busy: false, error: e as Error });
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) void run(text.trim());
  };
  return (
    <div className="page container narrow">
      <PageHead
        kicker="Access pass"
        title="Check an access pass"
        lede="A runner signs an access pass for a subscriber whose subscription is paid up. Paste one to check its signature in this tab and see what it says: the offer, the payments made, and until when it holds. It never names the payer."
      />
      <div className="stack" style={{ ['--gap' as string]: '20px' }}>
        {support.data ? <SupportNote support={support.data} /> : <Spinner label="Asking the runner whether it issues passes…" />}
        <form className="card stack" style={{ ['--gap' as string]: '12px' }} onSubmit={submit}>
          <div className="field">
            <label htmlFor="pass-input">Access pass</label>
            <textarea
              id="pass-input"
              className="input mono"
              style={{ height: 'auto', padding: '10px 12px', resize: 'vertical' }}
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="eyJ2IjoxLCJpc3MiOi….…"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="row">
            <button type="submit" className="btn primary" disabled={!text.trim() || check?.busy}>
              Check pass
            </button>
          </div>
        </form>
        {check?.busy && <Spinner label="Checking the signature…" />}
        {check?.error && <ErrorNote error={new Error(`Could not check the pass: ${check.error.message}`)} retry={() => void run(text.trim())} />}
        {check?.result && <Verdict checked={check.result} />}
        <MerchantCheck />
      </div>
    </div>
  );
}
