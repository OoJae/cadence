import { useState } from 'react';
import { QUICKNET } from '../lib/drand';
import { fmt } from '../pages/landing/data';
import { useDrandRound } from './useDrandRound';

/**
 * A number whose changed digits roll and whose others hold still: ch-wide tabular slots,
 * so nothing reflows. Decorative; the caller supplies the readable number.
 */
function Odometer({ value }: { value: number }) {
  const [pair, setPair] = useState({ now: value, was: value });
  // Remember the previous value while rendering the new one (React's derived-state pattern).
  if (pair.now !== value) setPair({ now: value, was: pair.now });
  const now = fmt(pair.now);
  const was = fmt(pair.was).padStart(now.length, ' ');
  return (
    <span className="odometer" aria-hidden="true">
      {[...now].map((c, i) => {
        const before = was[i];
        return (
          <span className="odo-slot" key={i}>
            {before !== c && before !== undefined && pair.now !== pair.was ? (
              <>
                <span className="odo-char out" key={`o${pair.now}`}>
                  {before}
                </span>
                <span className="odo-char in" key={`i${pair.now}`}>
                  {c}
                </span>
              </>
            ) : (
              <span className="odo-char">{c}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * drand quicknet's live round, counted on this device. The rail stands in the landing's
 * right margin from 1280 px; below that the line sits above the hero's kicker. Only one
 * of the two is ever exposed to assistive technology, and neither is a live region.
 */
export function RoundRail({ variant }: { variant: 'rail' | 'line' }) {
  const round = useDrandRound();
  return (
    <div className={`round-rail ${variant}`} aria-hidden={variant === 'rail' ? true : undefined}>
      <span className="rail-head">
        <span className="rail-label">drand round</span>{' '}
        <span className="rail-round">
          <span className="sr-only">{fmt(round)}</span>
          <Odometer value={round} />
        </span>
        <span className="rail-sub"> · a new round every {QUICKNET.period} s</span>
      </span>
      <span className="rail-foot">Counted from your device's clock. This page never contacts drand.</span>
    </div>
  );
}
