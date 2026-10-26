import { useState, type ReactNode } from 'react';
import { downloadBytes } from '../lib/download';
import { Link } from '../router';
import { runnerUrl } from '../runtime';
import { cliCancelCommand, cliSweepCommand, MAX_KIT_BYTES, MIN_PASSPHRASE_CHARS, passphraseProblem, type KitCheck, type SealedKit } from '../signer/kit';
import type { Signer } from '../signer/types';
import { KeyIcon, ShieldCheckIcon } from './Icons';
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

/** Where the payer is with the cancel key. The page keeps it in memory only, so a reload starts over. */
export type CancelKeyState =
  | { step: 'none' }
  /** Downloaded, but not yet shown to open this pocket. */
  | { step: 'downloaded'; kit: SealedKit }
  /** Picked again and opened with its passphrase in this tab: it is this pocket's key. */
  | { step: 'verified'; kit: SealedKit }
  /** The payer chose to go on without a checked key; `kit` is one downloaded but not checked. */
  | { step: 'skipped'; kit: SealedKit | null };

export const NO_CANCEL_KEY: CancelKeyState = { step: 'none' };

/** Whether the page may say the tab can be closed: the key is shown to work, or the payer chose to go without one. */
export const cancelKeySettled = (key: CancelKeyState): boolean => key.step === 'verified' || key.step === 'skipped';

/** What losing the key costs. */
const LOST =
  'you cannot cancel, and you cannot get back what is left in the pocket after the merchant stops the plan, an installment is missed, or you paid in more than the plan needs';

/**
 * The "save your cancel key" card, shown once the schedule is uploaded. The signer
 * encrypts the kit to the passphrase in a worker; this component only ever holds
 * the ciphertext, and saves it with a download. The payer then picks the saved file
 * again and retypes the passphrase, and the signer opens it in a worker to show it is
 * this pocket's key. Nothing goes to the runner, and nothing is stored in the browser.
 *
 * `skip` is how going without a key is offered: 'quick' (the sandbox, one click) or
 * 'confirm' (a real pocket: the cost is spelled out first). Either way it is the
 * payer's choice, and the page never says a key is saved unless it was checked.
 */
export function SaveCancelKey({
  signer,
  subscriptionId,
  state,
  onChange,
  skip,
}: {
  signer: Signer;
  subscriptionId: string | null;
  state: CancelKeyState;
  onChange: (next: CancelKeyState) => void;
  skip: 'quick' | 'confirm';
}) {
  switch (state.step) {
    case 'verified':
      return <VerifiedKey kit={state.kit} />;
    case 'skipped':
      return <SkippedKey kit={state.kit} onChange={onChange} />;
    case 'downloaded':
      return <CheckKey signer={signer} kit={state.kit} onChange={onChange} skip={skip} />;
    case 'none':
      return <MakeKey signer={signer} subscriptionId={subscriptionId} onChange={onChange} skip={skip} />;
  }
}

function VerifiedKey({ kit }: { kit: SealedKit }) {
  return (
    <Callout kind="ok" icon={<ShieldCheckIcon size={16} />}>
      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <strong>Verified: this key opens your pocket.</strong>
        <span className="small">
          {kit.fileName} opened with its passphrase in this tab, and it is this pocket's key. Keep the file and its passphrase. To cancel later, open it on{' '}
          <Link to="/manage">Manage</Link> on this runner, or with the CLI:
        </span>
        <Command text={cliCancelCommand(kit.fileName)} />
        <span className="small">If the merchant stops the plan, an installment is missed, or the pocket holds more than the plan spends, the same key gets the rest back:</span>
        <Command text={cliSweepCommand(kit.fileName)} />
        <button type="button" className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => downloadBytes(kit.bytes, kit.fileName)}>
          Download it again
        </button>
      </div>
    </Callout>
  );
}

function SkippedKey({ kit, onChange }: { kit: SealedKit | null; onChange: (next: CancelKeyState) => void }) {
  return (
    <Callout kind="warn" icon={<KeyIcon size={16} />}>
      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <strong>{kit ? 'Cancel key not checked.' : 'No cancel key.'}</strong>
        <span className="small">
          {kit
            ? `${kit.fileName} was downloaded but not shown to open this pocket. If it does not open, then once this tab closes, ${LOST}.`
            : `Payments continue. Once this tab closes, ${LOST}.`}
        </span>
        <button type="button" className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(kit ? { step: 'downloaded', kit } : NO_CANCEL_KEY)}>
          {kit ? 'Check it now' : 'Save a cancel key after all'}
        </button>
      </div>
    </Callout>
  );
}

/** The skip link; with 'confirm', a second step that says what skipping costs, on its own line of the row. */
function Skip({ mode, label, cost, onSkip, disabled }: { mode: 'quick' | 'confirm'; label: string; cost: string; onSkip: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (mode === 'quick' || !asking) {
    return (
      <button type="button" className="link-btn small" onClick={mode === 'quick' ? onSkip : () => setAsking(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  return (
    <div style={{ flexBasis: '100%' }}>
      <Callout kind="warn">
        <div className="stack" style={{ ['--gap' as string]: '10px' }}>
          <span className="small">{cost} Payments continue either way.</span>
          <div className="row" style={{ ['--gap' as string]: '12px' }}>
            <button type="button" className="btn sm" onClick={onSkip}>
              {label}
            </button>
            <button type="button" className="link-btn small" onClick={() => setAsking(false)}>
              Back
            </button>
          </div>
        </div>
      </Callout>
    </div>
  );
}

function KeyCardHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="row no-wrap top" style={{ ['--gap' as string]: '10px' }}>
      <KeyIcon size={20} className="accent" />
      <div className="stack" style={{ ['--gap' as string]: '4px' }}>
        <h2 id="cancel-key-title" className="h3">
          {title}
        </h2>
        <p className="small text-2">{children}</p>
      </div>
    </div>
  );
}

function MakeKey({ signer, subscriptionId, onChange, skip }: { signer: Signer; subscriptionId: string | null; onChange: (next: CancelKeyState) => void; skip: 'quick' | 'confirm' }) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const weak = pass ? passphraseProblem(pass) : null;
  const mismatch = again.length > 0 && again !== pass;
  const ready = !passphraseProblem(pass) && again === pass;

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const kit = await signer.sealKit(pass, { runner: runnerUrl, subscriptionId });
      downloadBytes(kit.bytes, kit.fileName);
      setPass('');
      setAgain('');
      onChange({ step: 'downloaded', kit });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card key-card stack" style={{ ['--gap' as string]: '14px' }} aria-labelledby="cancel-key-title">
      <KeyCardHead title="Save your cancel key before you close this tab">
        The pocket's key exists only in this tab. Payments continue without it, but without a cancel key {LOST}: the CLI's <code>cadence sweep</code> needs this key
        too. Download it now as a file encrypted to a passphrase, then check that it opens.
      </KeyCardHead>
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
          <Skip
            mode={skip}
            label={skip === 'quick' ? "Skip: I won't need to cancel" : 'Go without a cancel key'}
            cost={`Without a cancel key, closing this tab gives up the pocket's key for good: ${LOST}.`}
            onSkip={() => onChange({ step: 'skipped', kit: null })}
            disabled={busy}
          />
        </div>
        <span className="tiny muted">
          It holds the pocket's seed, the schedule and the pocket's notes, as the CLI's subscription file (age, scrypt). It works with <code>cadence cancel</code> and{' '}
          <code>cadence sweep</code> too.
        </span>
      </form>
    </section>
  );
}

function CheckKey({ signer, kit, onChange, skip }: { signer: Signer; kit: SealedKit; onChange: (next: CancelKeyState) => void; skip: 'quick' | 'confirm' }) {
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Extract<KitCheck, { ok: false }>>();
  const [error, setError] = useState<Error>();

  const check = async (picked: File) => {
    setBusy(true);
    setFailed(undefined);
    setError(undefined);
    try {
      // Read here, in memory only. A file this large is not a cancel key; the check says so without reading it.
      const bytes = picked.size <= MAX_KIT_BYTES ? new Uint8Array(await picked.arrayBuffer()) : new Uint8Array(0);
      const result = await signer.verifyKit(bytes, pass);
      if (result.ok) {
        setPass('');
        onChange({ step: 'verified', kit });
      } else {
        setFailed(result);
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const ext = kit.fileName.slice(kit.fileName.lastIndexOf('.'));
  return (
    <section className="card key-card stack" style={{ ['--gap' as string]: '14px' }} aria-labelledby="cancel-key-title">
      <KeyCardHead title="Check that your cancel key opens">
        Your browser was asked to save <span className="mono">{kit.fileName}</span>. Pick that file again and type its passphrase: this tab opens it the way Manage would and checks
        that it is this pocket's key. The file is read here and not sent anywhere.
      </KeyCardHead>
      <form
        className="stack"
        style={{ ['--gap' as string]: '12px' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (file && pass && !busy) void check(file);
        }}
      >
        <div className="grid cols-2" style={{ ['--gap' as string]: '12px' }}>
          <div className="field">
            <label htmlFor="kit-check-file">The file you downloaded</label>
            <input
              id="kit-check-file"
              className="input"
              type="file"
              accept={`${ext},application/octet-stream`}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setFailed(undefined);
              }}
              aria-invalid={failed?.reason === 'file' || failed?.reason === 'pocket' ? true : undefined}
              disabled={busy}
            />
            <span className="hint">{kit.fileName}, usually in your downloads</span>
          </div>
          <div className="field">
            <label htmlFor="kit-check-pass">Its passphrase</label>
            <input
              id="kit-check-pass"
              className="input"
              type="password"
              autoComplete="current-password"
              value={pass}
              onChange={(e) => {
                setPass(e.target.value);
                if (failed?.reason === 'passphrase') setFailed(undefined);
              }}
              aria-invalid={failed?.reason === 'passphrase' ? true : undefined}
              disabled={busy}
            />
          </div>
        </div>
        {failed && (
          <Callout kind="danger">
            <span className="small">{failed.message}</span>
          </Callout>
        )}
        {error && <ErrorNote error={error} />}
        <div className="row" style={{ ['--gap' as string]: '12px' }}>
          <button type="submit" className="btn primary" disabled={!file || !pass || busy}>
            <ShieldCheckIcon size={15} /> {busy ? 'Opening (a few seconds)…' : 'Check the key'}
          </button>
          <button type="button" className="link-btn small" onClick={() => downloadBytes(kit.bytes, kit.fileName)} disabled={busy}>
            Download it again
          </button>
          <button type="button" className="link-btn small" onClick={() => onChange(NO_CANCEL_KEY)} disabled={busy}>
            Choose a different passphrase
          </button>
          <Skip
            mode={skip}
            label="Skip the check"
            cost="An unchecked key may not open when you need it (a mistyped passphrase, a download that did not finish), and then you cannot cancel or recover what is left in the pocket."
            onSkip={() => onChange({ step: 'skipped', kit })}
            disabled={busy}
          />
        </div>
      </form>
    </section>
  );
}
