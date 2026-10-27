import { useId } from 'react';
import { RUN1, RUN1_RELEASED_INDEX } from '../pages/landing/data';

/**
 * Testnet run 1, drawn still: three ladders at their real rung counts, one rung per
 * block an installment could land in, bases aligned at the signing tip + 1. The rung for
 * the block after the tip is pulled out to the left in Release; the tip is a Graphite
 * hairline. The source of the mark, the OG card and the landing's poster.
 *
 * Colours follow the theme through currentColor and custom properties, so the same
 * drawing works on Vault, on Paper and on a fixed plate:
 *   --ladder-rail (currentColor), --ladder-rung (currentColor, at rungOpacity),
 *   --ladder-release (--accent-graphic), --ladder-tip (--muted), --ladder-label (--muted).
 */
export interface LadderOptions {
  /** Rungs per ladder, left to right. */
  rungs?: readonly number[];
  /** Index above ladder 1's base of the rung that goes out; null draws none pulled. */
  released?: number | null;
  /** Units between rungs: one block. */
  pitch?: number;
  /** Outer width of a ladder, rail edge to rail edge. */
  ladderWidth?: number;
  /** Centre-to-centre distance between ladders. */
  spacing?: number;
  railWidth?: number;
  rungHeight?: number;
  releasedHeight?: number;
  /** How far the released rung slides out to the left. */
  pull?: number;
  /** The chain tip: a hairline at the block before the released rung. */
  tip?: boolean;
  /** Mono rung counts under the ladders. */
  labels?: boolean;
  labelSize?: number;
}

export interface LadderGeometry {
  /** viewBox "0 0 width height", in drawing units. */
  width: number;
  height: number;
  /** y of the ladders' bases. */
  base: number;
  /** x of each ladder's centre. */
  centres: number[];
}

type Resolved = Required<Omit<LadderOptions, 'released'>> & { released: number | null };

/** The OG card's drawing (spec §5): 2.6 units a block, 64-wide ladders 140 apart. */
const DEFAULTS: Resolved = {
  rungs: RUN1.rungs,
  released: RUN1_RELEASED_INDEX,
  pitch: 2.6,
  ladderWidth: 64,
  spacing: 140,
  railWidth: 4,
  rungHeight: 1,
  releasedHeight: 3,
  pull: 24,
  tip: true,
  labels: false,
  labelSize: 13,
};

function resolve(o: LadderOptions): Resolved {
  const r: Resolved = { ...DEFAULTS };
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
  return r;
}

function layout(o: Resolved): LadderGeometry {
  const tallest = Math.max(...o.rungs);
  // The pulled rung's left edge is the drawing's left edge.
  const left = o.released === null ? 0 : Math.max(0, o.pull - o.railWidth);
  const centres = o.rungs.map((_, i) => left + o.ladderWidth / 2 + i * o.spacing);
  const base = tallest * o.pitch;
  return {
    width: centres[centres.length - 1]! + o.ladderWidth / 2,
    height: base + (o.labels ? o.labelSize * 2 : 0),
    base,
    centres,
  };
}

/** Where LadderArt puts things, so a parent drawing (the OG card) can place it exactly. */
export function ladderGeometry(options: LadderOptions = {}): LadderGeometry {
  return layout(resolve(options));
}

const n = (v: number) => Math.round(v * 100) / 100;

export function LadderArt({
  scale = 1,
  snap = false,
  rungOpacity = 0.28,
  title,
  className,
  x,
  y,
  ...options
}: LadderOptions & {
  /** CSS px per drawing unit, for the width and height attributes. */
  scale?: number;
  /** Round rungs to whole units: crisp 1 px rungs when one unit is one pixel. */
  snap?: boolean;
  rungOpacity?: number;
  /** An accessible name; without one the drawing is decorative. */
  title?: string;
  className?: string;
  /** Position when nested inside another <svg>. */
  x?: number;
  y?: number;
}) {
  const titleId = useId();
  const o = resolve(options);
  const g = layout(o);
  const at = (v: number) => (snap ? Math.round(v) : n(v));
  const rungY = (i: number, h: number) => at(g.base - (i + 0.5) * o.pitch - h / 2);
  const inner = o.ladderWidth - 2 * o.railWidth;

  const ladders = o.rungs.map((count, l) => {
    const c = g.centres[l]!;
    const x0 = n(c - o.ladderWidth / 2 + o.railWidth);
    let d = '';
    for (let i = 0; i < count; i++) {
      if (l === 0 && i === o.released) continue; // its slot stays empty: the rung is out
      d += `M${x0} ${rungY(i, o.rungHeight)}h${n(inner)}v${o.rungHeight}h${n(-inner)}z`;
    }
    const top = n(g.base - count * o.pitch);
    return { c, d, top, count };
  });
  const tipY = o.tip && o.released !== null && o.released > 0 ? rungY(o.released - 1, 0) + (snap ? 0.5 : 0) : null;
  const relX = n(g.centres[0]! - o.ladderWidth / 2 + o.railWidth - o.pull);

  return (
    <svg
      className={className ? `ladder-art ${className}` : 'ladder-art'}
      viewBox={`0 0 ${n(g.width)} ${n(g.height)}`}
      width={n(g.width * scale)}
      height={n(g.height * scale)}
      x={x}
      y={y}
      {...(title ? { role: 'img', 'aria-labelledby': titleId } : { 'aria-hidden': true, focusable: 'false' })}
    >
      {title && <title id={titleId}>{title}</title>}
      {ladders.map(({ c, d, top }, l) => (
        <g key={l}>
          <path d={d} fill="var(--ladder-rung, currentColor)" fillOpacity={rungOpacity} />
          <rect x={n(c - o.ladderWidth / 2)} y={top} width={o.railWidth} height={n(g.base - top)} fill="var(--ladder-rail, currentColor)" />
          <rect x={n(c + o.ladderWidth / 2 - o.railWidth)} y={top} width={o.railWidth} height={n(g.base - top)} fill="var(--ladder-rail, currentColor)" />
        </g>
      ))}
      {tipY !== null && (
        <line x1={0} x2={n(g.width)} y1={tipY} y2={tipY} stroke="var(--ladder-tip, var(--muted))" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )}
      {o.released !== null && (
        <rect
          className="ladder-art-released"
          x={relX}
          y={rungY(o.released, o.releasedHeight)}
          width={n(inner)}
          height={o.releasedHeight}
          fill="var(--ladder-release, var(--accent-graphic))"
        />
      )}
      {o.labels &&
        ladders.map(({ c, count }, l) => (
          <text key={l} className="ladder-art-label" x={n(c)} y={n(g.base + o.labelSize * 1.5)} fontSize={o.labelSize} textAnchor="middle" fill="var(--ladder-label, var(--muted))">
            {l === 0 ? `${count} rungs` : count}
          </text>
        ))}
    </svg>
  );
}
