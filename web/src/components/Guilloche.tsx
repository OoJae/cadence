import { useMemo } from 'react';
import { guilloche } from '../lib/guilloche';

/** A certificate's engraving, drawn from its own transaction id or nullifier. Decorative. */
export function Guilloche({ seed, className, size }: { seed: string; className?: string; size?: number }) {
  const rosettes = useMemo(() => guilloche(seed), [seed]);
  return (
    <svg className={`guilloche${className ? ` ${className}` : ''}`} viewBox="-100 -100 200 200" width={size} height={size} aria-hidden="true" focusable="false">
      {rosettes.map((r) => (
        <path key={r.band} d={r.d} fill="none" stroke="currentColor" strokeWidth={0.6} vectorEffect="non-scaling-stroke" opacity={1 - r.band * 0.16} />
      ))}
    </svg>
  );
}
