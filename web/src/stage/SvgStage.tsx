import { memo, useId } from 'react';
import {
  BASE_Y,
  cascadeBands,
  hollowBands,
  LADDER_W,
  LADDER_X,
  ladderLeft,
  ladderTop,
  PITCH,
  RAIL_W,
  rungPath,
  RUNG,
  RUNGS,
  SHEATH,
  SPLIT,
  TIP_SIGNING_Y,
  TIP_X,
  TOWER,
  TOWER_FADE,
  TOWER_X,
  VIEW,
} from './geometry';
import { STAGE_LABELS } from './labels';

const CASCADE = cascadeBands();
const HOLLOW = [hollowBands(1), hollowBands(2)] as const;

function Rails({ k, part }: { k: number; part?: string }) {
  const x = ladderLeft(k);
  const top = ladderTop(RUNGS[k]!);
  const h = BASE_Y - top;
  return (
    <g className="rails" data-part={part}>
      <rect x={x} y={top} width={RAIL_W} height={h} />
      <rect x={x + LADDER_W - RAIL_W} y={top} width={RAIL_W} height={h} />
    </g>
  );
}

/**
 * Testnet run 1 as a drawing: three ladders at their real rung counts, the tip line, the
 * one amber rung, the identical sheaths and the 30-day tower. Static markup; the driver
 * animates it by data-part. Colours come from CSS classes, so a theme switch is instant.
 */
export const SvgStage = memo(function SvgStage() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const towerRungs = `tower-rungs-${id}`;
  const towerFade = `tower-fade-${id}`;
  const towerMask = `tower-mask-${id}`;
  const towerX = TOWER_X - LADDER_W / 2;
  return (
    <>
      <div className="stage-camera" data-part="camera">
        <svg className="stage-svg" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} preserveAspectRatio="xMidYMax meet" overflow="visible" focusable="false">
          <defs>
            <pattern id={towerRungs} x={towerX + RAIL_W} y={BASE_Y} width={LADDER_W - 2 * RAIL_W} height={PITCH} patternUnits="userSpaceOnUse">
              <rect className="tower-rung" y={1} width={LADDER_W - 2 * RAIL_W} height={1} />
            </pattern>
            <linearGradient id={towerFade} gradientUnits="userSpaceOnUse" x1={0} y1={TOWER_FADE[0]} x2={0} y2={TOWER_FADE[1]}>
              <stop offset={0} stopColor="#fff" />
              <stop offset={1} stopColor="#fff" stopOpacity={0} />
            </linearGradient>
            <mask id={towerMask} maskUnits="userSpaceOnUse" x={towerX - 4} y={TOWER.top} width={LADDER_W + 8} height={BASE_Y - TOWER.top}>
              <rect x={towerX - 4} y={TOWER.top} width={LADDER_W + 8} height={BASE_Y - TOWER.top} fill={`url(#${towerFade})`} />
            </mask>
          </defs>

          <g className="scene" data-part="scene">
            <g className="tower" data-part="tower" mask={`url(#${towerMask})`}>
              <rect className="tower-rail" x={towerX} y={TOWER.top} width={RAIL_W} height={BASE_Y - TOWER.top} />
              <rect className="tower-rail" x={towerX + LADDER_W - RAIL_W} y={TOWER.top} width={RAIL_W} height={BASE_Y - TOWER.top} />
              <rect x={towerX + RAIL_W} y={TOWER.top} width={LADDER_W - 2 * RAIL_W} height={BASE_Y - TOWER.top} fill={`url(#${towerRungs})`} />
            </g>

            <g className="sheaths">
              {LADDER_X.map((x, k) => (
                <rect key={k} className="sheath" data-part="sheath" x={x - SHEATH.w / 2} y={SHEATH.y} width={SHEATH.w} height={SHEATH.h} />
              ))}
            </g>

            <line className="tip-line" data-part="tip" x1={TIP_X[0]} x2={TIP_X[1]} y1={TIP_SIGNING_Y} y2={TIP_SIGNING_Y} />

            <g className="ladder">
              <Rails k={0} />
              {CASCADE.map((band, b) => (
                <path key={b} className="rungs" data-part="band" d={rungPath(0, band)} />
              ))}
            </g>
            {HOLLOW.map((bands, j) => {
              // Ladders 2 and 3, named by installment.
              const k = j + 1;
              const n = k + 1;
              const x = ladderLeft(k);
              const top = ladderTop(RUNGS[k]!);
              return (
                <g key={k} className="ladder">
                  <Rails k={k} part={`rails-${n}`} />
                  <g className="hollow-rails" data-part={`hollow-${n}`}>
                    <line x1={x + RAIL_W / 2} x2={x + RAIL_W / 2} y1={top} y2={BASE_Y} />
                    <line x1={x + LADDER_W - RAIL_W / 2} x2={x + LADDER_W - RAIL_W / 2} y1={top} y2={BASE_Y} />
                  </g>
                  {bands.map((band, b) => (
                    <path key={b} className="rungs" data-part={`hband-${n}`} d={rungPath(k, band)} />
                  ))}
                </g>
              );
            })}

            <g className="rung" data-part="rung">
              <g className="rung-amber" data-part="rung-amber">
                <rect data-part="rung-whole" x={RUNG.x} y={RUNG.y} width={RUNG.w} height={RUNG.h} />
                <g data-part="rung-split">
                  <rect data-part="rung-a" x={RUNG.x} y={RUNG.y + RUNG.h / 2 - 0.6} width={RUNG.w} height={1.2} />
                  <rect data-part="rung-b" x={RUNG.x} y={RUNG.y + RUNG.h / 2 - 0.6} width={RUNG.w} height={1.2} />
                </g>
              </g>
              {/* The same two bars once they are history: nothing past is amber. */}
              <g className="rung-past" data-part="rung-past">
                <rect x={RUNG.x} y={RUNG.y + RUNG.h / 2 - 0.6 - SPLIT} width={RUNG.w} height={1.2} />
                <rect x={RUNG.x} y={RUNG.y + RUNG.h / 2 - 0.6 + SPLIT} width={RUNG.w} height={1.2} />
              </g>
            </g>
          </g>
        </svg>
      </div>

      <div className="stage-labels">
        {STAGE_LABELS.map((l) => (
          <span key={l.id} className={`stage-label${l.vertical ? ' vertical' : ''}${l.caption ? ' caption' : ''}`} data-label={l.id}>
            <span className="label-inner">{l.text}</span>
          </span>
        ))}
      </div>
    </>
  );
});
