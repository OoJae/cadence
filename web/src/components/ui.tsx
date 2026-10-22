import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { InstallmentState, SubscriptionStatus } from '../api/types';
import { useNow } from '../hooks';
import { shorten } from '../lib/addresses';
import { roundTime } from '../lib/drand';
import { installmentStateInfo, subscriptionStatusInfo, type Tone } from '../lib/states';
import { formatCountdown, formatDateTime, formatRelative } from '../lib/time';
import { Link } from '../router';
import {
  AlertIcon,
  BanIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  CubeIcon,
  InfoIcon,
  LockIcon,
  RadioIcon,
  ShieldCheckIcon,
  XIcon,
} from './Icons';

export function Badge({ tone = 'muted', children, dot, live, lg, title }: { tone?: Tone | 'accent'; children: ReactNode; dot?: boolean; live?: boolean; lg?: boolean; title?: string }) {
  return (
    <span className={`badge tone-${tone}${live ? ' live' : ''}${lg ? ' lg' : ''}`} title={title}>
      {dot && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StateIcon({ state, size = 16 }: { state: InstallmentState; size?: number }) {
  switch (state) {
    case 'sealed':
      return <LockIcon size={size} />;
    case 'due':
      return <ClockIcon size={size} />;
    case 'broadcast':
      return <RadioIcon size={size} />;
    case 'mined':
      return <CubeIcon size={size} />;
    case 'cancelled':
      return <BanIcon size={size} />;
    case 'missed':
      return <AlertIcon size={size} />;
  }
}

export function StateBadge({ state }: { state: InstallmentState }) {
  const info = installmentStateInfo(state);
  return (
    <span className={`badge tone-${info.tone}${state === 'due' || state === 'broadcast' ? ' live' : ''}`} title={info.description}>
      {state === 'due' || state === 'broadcast' ? <span className="dot" aria-hidden="true" /> : <StateIcon state={state} size={12} />}
      {info.label}
    </span>
  );
}

export function StatusBadge({ status, lg }: { status: SubscriptionStatus; lg?: boolean }) {
  const info = subscriptionStatusInfo(status);
  return (
    <Badge tone={info.tone} dot live={status === 'active'} lg={lg} title={info.description}>
      {info.label}
    </Badge>
  );
}

/** Live countdown to a unix time: "in 02:14:07" → "now" → "3 min ago". */
export function Countdown({ at, past = 'relative' }: { at: number; past?: 'relative' | 'hide' }) {
  const now = useNow();
  const d = at - now;
  if (d > 0) {
    return (
      <span className="mono num nowrap" title={formatDateTime(at)}>
        in {formatCountdown(d)}
      </span>
    );
  }
  if (past === 'hide') return null;
  return (
    <span className="mono num nowrap muted" title={formatDateTime(at)}>
      {formatRelative(d)}
    </span>
  );
}

/** "round 33 291 601" with its wall-clock time on hover. */
export function Round({ round, showTime }: { round: number; showTime?: boolean }) {
  const t = roundTime(round);
  return (
    <span className="mono num nowrap" title={`drand quicknet round ${round} · ${formatDateTime(t)}`}>
      {round.toLocaleString('en-US')}
      {showTime && <span className="muted"> · {formatDateTime(t)}</span>}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button
      type="button"
      className={`copy-btn${done ? ' done' : ''}`}
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          clearTimeout(t.current);
          t.current = setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard unavailable: the text is selectable anyway */
        }
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A txid, shortened, copyable, linking to the decoder when it is a full txid. */
export function Txid({ value, link = true, head = 8, tail = 6 }: { value: string; link?: boolean; head?: number; tail?: number }) {
  const full = HEX64.test(value);
  const text = shorten(value, head, tail);
  return (
    <span className="txid">
      {full && link ? (
        <Link to={`/decode/${value}`} title={`Decode ${value}`}>
          {text}
        </Link>
      ) : (
        <span title={value}>{text}</span>
      )}
      {full && <CopyButton text={value} label="Copy txid" />}
    </span>
  );
}

export function Callout({ kind = 'info', children, icon }: { kind?: 'info' | 'warn' | 'danger' | 'ok' | 'plain'; children: ReactNode; icon?: ReactNode }) {
  const ico =
    icon ??
    (kind === 'warn' ? (
      <AlertIcon size={16} />
    ) : kind === 'danger' ? (
      <XIcon size={16} />
    ) : kind === 'ok' ? (
      <ShieldCheckIcon size={16} />
    ) : (
      <InfoIcon size={16} />
    ));
  return (
    <div className={`callout ${kind === 'plain' ? '' : kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      {ico}
      <div>{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function PageHead({ kicker, title, lede, children }: { kicker: string; title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <header className="stack" style={{ ['--gap' as string]: '14px', marginBottom: 32 }}>
      <span className="kicker">{kicker}</span>
      <h1 className="h2">{title}</h1>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </header>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ ['--gap' as string]: '10px' }} role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="small muted">{label}</span>}
    </span>
  );
}

export function ErrorNote({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <Callout kind="danger">
      <div className="row between">
        <span>{error.message}</span>
        {retry && (
          <button type="button" className="btn sm" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    </Callout>
  );
}
