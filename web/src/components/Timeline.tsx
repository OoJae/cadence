import { useEffect, useRef, useState } from 'react';
import type { Installment, InstallmentState, NetworkId } from '../api/types';
import { installmentStateInfo } from '../lib/states';
import { formatDateTime } from '../lib/time';
import { formatZec } from '../lib/zat';
import { Countdown, StateBadge, StateIcon, Txid } from './ui';

/** Vertical list of installments that flashes when one changes state. */
export function Timeline({ installments, network = 'test', onDecode }: { installments: Installment[]; network?: NetworkId; onDecode?: (txid: string) => void }) {
  const prev = useRef(new Map<number, InstallmentState>());
  const [flash, setFlash] = useState<Set<number>>(new Set());

  useEffect(() => {
    const changed = new Set<number>();
    for (const i of installments) {
      const p = prev.current.get(i.k);
      if (p && p !== i.state) changed.add(i.k);
      prev.current.set(i.k, i.state);
    }
    if (changed.size) {
      setFlash(changed);
      const t = setTimeout(() => setFlash(new Set()), 1300);
      return () => clearTimeout(t);
    }
  }, [installments]);

  return (
    <ol className="timeline-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {installments.map((i) => (
        <li key={i.k} className={`tl-item${flash.has(i.k) ? ' flash' : ''}`} data-state={i.state}>
          <span className="ico" aria-hidden="true">
            <StateIcon state={i.state} size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="title">
              Installment {i.k} <span className="muted" style={{ fontWeight: 400 }}>· {formatZec(i.amount_zat, network)}</span>
            </div>
            <div className="meta">
              {i.state === 'sealed' && (
                <>
                  opens at drand round {i.release_round.toLocaleString('en-US')} · <Countdown at={i.release_at} />
                </>
              )}
              {i.state === 'due' && <>round passed · runner is waiting for anchor depth</>}
              {i.state === 'broadcast' && i.txid && (
                <>
                  target {i.target_height} · <Txid value={i.txid} link={false} />
                </>
              )}
              {i.state === 'mined' && i.txid && (
                <>
                  mined at {i.mined_height} · <Txid value={i.txid} />
                </>
              )}
              {(i.state === 'cancelled' || i.state === 'missed' || i.state === 'invalid') && (
                <>
                  {installmentStateInfo(i.state).description} <span className="faint">· was due {formatDateTime(i.release_at)}</span>
                </>
              )}
            </div>
          </div>
          <div className="row" style={{ ['--gap' as string]: '8px', justifyContent: 'flex-end' }}>
            <StateBadge state={i.state} />
            {onDecode && i.txid && i.state === 'mined' && (
              <button type="button" className="btn sm" onClick={() => onDecode(i.txid!)}>
                Decode
              </button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
