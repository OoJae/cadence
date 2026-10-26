import { useState } from 'react';
import { downloadBytes } from '../lib/download';
import { Link } from '../router';
import { runnerUrl } from '../runtime';
import { cliCancelCommand, MIN_PASSPHRASE_CHARS, passphraseProblem, type SealedKit } from '../signer/kit';
import type { Signer } from '../signer/types';
import { KeyIcon } from './Icons';
import { Callout, CopyButton, ErrorNote } from './ui';

/** A copyable shell command. */
export function Command({ text }: { text: string }) {
  return (
    <div className="row no-wrap top" style={{ ['--gap' as string]: '6px' }}>
      <code className="code-block" style={{ flex: 1 }}>
        {text}
      </code>
      <CopyButton text={text} label="Copy command" />
    </div>
  );
}

/**
 * The "save your cancel key" card, shown once the schedule is uploaded. The signer
 * encrypts the kit to the passphrase in a worker; this component only ever holds
 * the ciphertext, and saves it with a download. Nothing goes to the runner.
 */
export function SaveCancelKey({
  signer,
  subscriptionId,
  runner = runnerUrl,
  saved,
  onSaved,
  onSkip,
}: {
  signer: Signer;
  subscriptionId: string | null;
  /** The runner that holds the subscription, as the key records it (default: the build's default runner). */
  runner?: string;
  saved: SealedKit | null;
  onSaved: (kit: SealedKit) => void;
  /** Offered in the sandbox only: payments continue either way. */
  onSkip?: () => void;
}) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const weak = pass ? passphraseProblem(pass) : null;
  const mismatch = again.length > 0 && again !== pass;
  const ready = !passphraseProblem(pass) && again === pass;

  if (saved) {
    return (
      <Callout kind="ok" icon={<KeyIcon size={16} />}>
        <div className="stack" style={{ ['--gap' as string]: '6px' }}>
          <strong>Cancel key saved as {saved.fileName}.</strong>
          <span className="small">
            Keep it with its passphrase. To cancel later, open it on <Link to="/manage">Manage</Link> on this runner, or with the CLI:
          </span>
          <Command text={cliCancelCommand(saved.fileName)} />
          <button type="button" className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => downloadBytes(saved.bytes, saved.fileName)}>
            Download it again
          </button>
        </div>
      </Callout>
    );
  }

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const kit = await signer.sealKit(pass, { runner, subscriptionId });
      downloadBytes(kit.bytes, kit.fileName);
      setPass('');
      setAgain('');
      onSaved(kit);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card key-card stack" style={{ ['--gap' as string]: '14px' }} aria-labelledby="cancel-key-title">
      <div className="row no-wrap top" style={{ ['--gap' as string]: '10px' }}>
        <KeyIcon size={20} className="accent" />
        <div className="stack" style={{ ['--gap' as string]: '4px' }}>
          <h2 id="cancel-key-title" className="h3">
            Save your cancel key before you close this tab
          </h2>
          <p className="small text-2">
            The pocket's key exists only in this tab. Payments continue without it, but to cancel later, or to get back what is left in the pocket, you need it. Download it now as a
            file encrypted to a passphrase.
          </p>
        </div>
      </div>
      <Callout kind="warn">
        <span className="small">
          Anyone with this file <strong>and</strong> its passphrase can cancel and take the remaining balance. Cadence never sees either: the file is encrypted in this tab and saved
          straight to your device. Keep it like a key.
        </span>
      </Callout>
      <form
        className="stack"
        style={{ ['--gap' as string]: '12px' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void go();
        }}
      >
        <div className="grid cols-2" style={{ ['--gap' as string]: '12px' }}>
          <div className="field">
            <label htmlFor="kit-pass">Passphrase</label>
            <input
              id="kit-pass"
              className="input"
              type="password"
              autoComplete="new-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              aria-invalid={weak ? true : undefined}
              disabled={busy}
            />
            <span className={weak ? 'error-text' : 'hint'}>{weak ?? `At least ${MIN_PASSPHRASE_CHARS} characters. A few random words is better.`}</span>
          </div>
          <div className="field">
            <label htmlFor="kit-pass-2">Passphrase again</label>
            <input
              id="kit-pass-2"
              className="input"
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              aria-invalid={mismatch ? true : undefined}
              disabled={busy}
            />
            {mismatch && <span className="error-text">The passphrases differ.</span>}
          </div>
        </div>
        {error && <ErrorNote error={error} />}
        <div className="row" style={{ ['--gap' as string]: '12px' }}>
          <button type="submit" className="btn primary" disabled={!ready || busy}>
            <KeyIcon size={15} /> {busy ? 'Encrypting (a few seconds)…' : 'Download cancel key'}
          </button>
          {onSkip && (
            <button type="button" className="link-btn small" onClick={onSkip} disabled={busy}>
              Skip: I won't need to cancel
            </button>
          )}
        </div>
        <span className="tiny muted">
          It holds the pocket's seed, the schedule and the pocket's notes, as the CLI's subscription file (age, scrypt). It works with <code>cadence cancel</code> and{' '}
          <code>cadence sweep</code> too.
        </span>
      </form>
    </section>
  );
}
