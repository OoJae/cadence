/**
 * The SVG stage's drawing, in viewBox units: testnet run 1's three ladders at their real
 * rung counts, one unit tall per rung line on a pitch of three. Pure numbers, no DOM, so
 * the stage, its labels and the WebGL tier can share them.
 */
import { RUN1, RUN1_RELEASED_INDEX, TOWER_RUNGS } from '../pages/landing/data';

export const VIEW = { w: 640, h: 900 } as const;

/** The block after the signing tip: every ladder starts here, so the bases align. */
export const BASE_Y = 770;
export const PITCH = 3;
export const LADDER_W = 56;
export const RAIL_W = 3;
/** Ladder centres, installments 1 to 3. */
export const LADDER_X = [268, 388, 508] as const;
export const TOWER_X = 128;

export const RUNGS = RUN1.rungs;
export const RELEASED = RUN1_RELEASED_INDEX;

export const ladderLeft = (k: number): number => LADDER_X[k]! - LADDER_W / 2;
export const ladderTop = (rungs: number): number => BASE_Y - rungs * PITCH;
/** Centre of rung i's line, i = 0 at the base. On half units so it is crisp at 1:1. */
export const rungY = (i: number): number => BASE_Y - i * PITCH - 1.5;

/** The tip line sits under the rung for tip + 1. Before the release it is the signing tip. */
export const TIP_SIGNING_Y = BASE_Y;
export const TIP_RELEASE_Y = BASE_Y - RELEASED * PITCH;
export const TIP_X: readonly [number, number] = [84, 572];

/** In run 1 every package was the same 64 KiB, so every sheath is the same size: the tallest ladder's. */
export const SHEATH = {
  w: LADDER_W + 28,
  h: Math.max(...RUNGS) * PITCH + 34,
  y: ladderTop(Math.max(...RUNGS)) - 22,
} as const;

/** The released rung: a 3-unit bar the inner width of a ladder, sitting on the tip line. */
export const RUNG = {
  x: ladderLeft(0) + RAIL_W,
  y: TIP_RELEASE_Y - PITCH,
  w: LADDER_W - 2 * RAIL_W,
  h: PITCH,
} as const;
/** Where the rung is pulled to: clear of the ladder for the poster, further out once sent. */
export const RUNG_POSTER_DX = -(LADDER_W + 16);
export const RUNG_OUT_DX = -(LADDER_W + 46);
export const RUNG_OUT_SCALE = 1.12;
/** Half the gap between the two bars it splits into (the two Ironwood actions). */
export const SPLIT = 1.9;

export const TOWER = { rungs: TOWER_RUNGS, top: ladderTop(TOWER_RUNGS) } as const;
/** The tower fades out into the fog between these heights. */
export const TOWER_FADE: readonly [number, number] = [BASE_Y - 420, BASE_Y - 1900];

/** Rung path data for ladder k: one "M x y h w" segment per rung. */
export function rungPath(k: number, indices: Iterable<number>): string {
  const x = ladderLeft(k) + RAIL_W;
  const w = LADDER_W - 2 * RAIL_W;
  let d = '';
  for (const i of indices) d += `M${x} ${rungY(i)}h${w}`;
  return d;
}

/** Ladder 1's rungs in eight bands by distance from the released one: the cascade's order. */
export const CASCADE_BANDS = 8;
export function cascadeBands(): number[][] {
  const n = RUNGS[0];
  const far = Math.max(RELEASED, n - 1 - RELEASED);
  const per = Math.ceil(far / CASCADE_BANDS);
  const bands: number[][] = Array.from({ length: CASCADE_BANDS }, () => []);
  for (let i = 0; i < n; i++) {
    if (i === RELEASED) continue;
    bands[Math.min(CASCADE_BANDS - 1, Math.floor((Math.abs(i - RELEASED) - 1) / per))]!.push(i);
  }
  return bands;
}

/** Ladders 2 and 3 in bands from the top down: the order they hollow out on cancel. */
export const HOLLOW_BANDS = 6;
export function hollowBands(k: number): number[][] {
  const n = RUNGS[k]!;
  const per = Math.ceil(n / HOLLOW_BANDS);
  const bands: number[][] = Array.from({ length: HOLLOW_BANDS }, () => []);
  for (let i = 0; i < n; i++) bands[Math.min(HOLLOW_BANDS - 1, Math.floor((n - 1 - i) / per))]!.push(i);
  return bands;
}
