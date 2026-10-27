import { LOCKUP, MARK, WORDMARK } from './wordmarkPaths';

/**
 * The wordmark and lockup as drawn (outlined from Bodoni Moda by
 * scripts/brand/outline-wordmark.mjs), for places that want the exact shape. The header
 * keeps live text. Ink is currentColor; the rung is --accent-graphic.
 */
interface ArtProps {
  /** The type size it matches, in CSS px: <Wordmark size={26}/> sits on 26 px live text. */
  size?: number;
  /** An accessible name; without one the drawing is decorative. */
  label?: string;
  className?: string;
  /** Position when nested inside another <svg>. */
  x?: number;
  y?: number;
}

const a11y = (label?: string) => (label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true, focusable: 'false' as const });
const px = (v: number) => Math.round(v * 100) / 100;

export function Wordmark({ size = 26, label, className, x, y }: ArtProps) {
  const k = size / WORDMARK.em;
  return (
    <svg
      className={className ? `wordmark-art ${className}` : 'wordmark-art'}
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      width={px(WORDMARK.width * k)}
      height={px(WORDMARK.height * k)}
      x={x}
      y={y}
      fill="currentColor"
      {...a11y(label)}
    >
      <path d={WORDMARK.d} />
    </svg>
  );
}

/** The mark as tall as the d's ascender, its bars on the baseline, then the wordmark. */
export function Lockup({ size = 26, label, className, x, y }: ArtProps) {
  const k = size / WORDMARK.em;
  const m = LOCKUP.mark;
  return (
    <svg
      className={className ? `lockup-art ${className}` : 'lockup-art'}
      viewBox={`0 0 ${LOCKUP.width} ${LOCKUP.height}`}
      width={px(LOCKUP.width * k)}
      height={px(LOCKUP.height * k)}
      x={x}
      y={y}
      fill="currentColor"
      {...a11y(label)}
    >
      <g transform={`translate(${m.x} ${m.y}) scale(${m.scale})`}>
        <path d={MARK.bars} />
        <rect {...MARK.rung} fill="var(--accent-graphic)" />
      </g>
      <path transform={`translate(${LOCKUP.wordX} 0)`} d={WORDMARK.d} />
    </svg>
  );
}

/** Where a lockup drawn at `size` puts its baseline, measured from its top. */
export const lockupBaseline = (size: number): number => (LOCKUP.baseline * size) / WORDMARK.em;
