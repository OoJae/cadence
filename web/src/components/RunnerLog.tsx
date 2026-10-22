import { useEffect, useRef, useState } from 'react';
import type { InstallmentState, Subscription } from '../api/types';
import { transitionLines, type LogLine } from '../lib/runnerLog';
import { formatTime, nowSecs } from '../lib/time';

/** Accumulates runner-style log lines as installment states change between polls. */
export function useRunnerLog(sub: Subscription | undefined, extra: LogLine[] = []): LogLine[] {
  const seen = useRef(new Map<number, InstallmentState>());
  const [lines, setLines] = useState<LogLine[]>([]);
  const subId = sub?.subscription_id;

  useEffect(() => {
    seen.current = new Map();
    setLines([]);
  }, [subId]);

  useEffect(() => {
    if (!sub) return;
    const add: LogLine[] = [];
    const at = nowSecs();
    for (const inst of sub.installments) {
      const prev = seen.current.get(inst.k);
      for (const l of transitionLines(prev, inst, sub)) add.push({ ...l, at });
      seen.current.set(inst.k, inst.state);
    }
    if (add.length) setLines((ls) => [...ls, ...add].slice(-200));
  }, [sub]);

  return [...lines, ...extra].sort((a, b) => a.at - b.at);
}

export function LogView({ lines, empty = 'Nothing yet.', label }: { lines: LogLine[]; empty?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div className="log" ref={ref} role="log" aria-label={label} aria-live="polite">
      {lines.length === 0 ? (
        <div className="empty">{empty}</div>
      ) : (
        lines.map((l, i) => (
          <div className={`line${l.tone ? ` ${l.tone}` : ''}`} key={`${l.at}-${i}`}>
            <span className="ts">{formatTime(l.at)}</span>
            <span className="msg">{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
