/**
 * "Get an access pass": a token the runner signs to say this subscription is paid up
 * until a time, for the payer to show a merchant's site. Offered only by a runner whose
 * status lists `pass`. The request is signed with the pocket's payer auth key, which
 * stays in the signer; the pass names the subscription, never the payer.
 */
import { useState } from 'react';
import { ApiError, hasFeature, type CadenceClient } from '../api/client';
import type { PassResponse } from '../api/types';
import { usePoll } from '../hooks';
import { formatDateTime } from '../lib/time';
import { Link } from '../router';
import type { Signer } from '../signer/types';
import { Callout, CopyButton, Countdown } from './ui';

/** The runner's refusals, in plain words. */
export function passRefusal(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) {
    return "The runner could not confirm that you are this subscription's payer. It holds no payer key for a subscription made before it issued passes, and it refuses a request from a device whose clock is more than 5 minutes off.";
  }
  if (e instanceof ApiError && e.status === 409) {
    return 'This subscription is not paying right now: it was cancelled or stopped, an installment was missed, or its paid time has run out. The runner issues no pass for it.';
  }
  return (e as Error).message;
}

export function AccessPass({ client, signer, subscriptionId }: { client: CadenceClient; signer: Signer; subscriptionId: string }) {
  const status = usePoll((signal) => client.status(signal), 0, [client]);
  const [busy, setBusy] = useState(false);
  const [pass, setPass] = useState<PassResponse>();
  const [error, setError] = useState<string>();
  if (!hasFeature(status.data, 'pass')) return null;

  const get = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setPass(await client.getPass(subscriptionId, await signer.payerAuth()));
    } catch (e) {
      setError(passRefusal(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack" style={{ ['--gap' as string]: '10px' }}>
      <div className="stack" style={{ ['--gap' as string]: '4px' }}>
        <span className="h4">Access pass</span>
        <span className="small text-2">Show it to the merchant's site to unlock access; it proves the subscription is paid without naming you.</span>
      </div>
      {pass && (
        <>
          <div className="row no-wrap top" style={{ ['--gap' as string]: '6px' }}>
            <code className="code-block" style={{ flex: 1 }}>
              {pass.pass}
            </code>
            <CopyButton text={pass.pass} label="Copy access pass" />
          </div>
          <span className="small text-2">
            Valid until {formatDateTime(pass.valid_until)} (<Countdown at={pass.valid_until} />). Get a fresh one once the next installment is paid.
          </span>
          <span className="tiny muted">
            Anyone can check a pass with the runner's public key, at <Link to="/pass">/pass</Link> or on their own server.
          </span>
        </>
      )}
      {error && <Callout kind="warn">{error}</Callout>}
      <div className="row">
        <button type="button" className="btn sm" onClick={() => void get()} disabled={busy}>
          {busy ? 'Asking the runner…' : pass ? 'Get a fresh pass' : 'Get an access pass'}
        </button>
      </div>
    </div>
  );
}
