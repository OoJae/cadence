/**
 * The stage's DOM labels: mono values pinned to points of the drawing. The driver moves
 * them with the camera (transform only), so the text stays crisp at any zoom.
 */
import { fmt, RUN1, RUN2, TOWER_RUNGS } from '../pages/landing/data';
import { BASE_Y, LADDER_W, LADDER_X, RUNG, RUNG_OUT_DX, RUNGS, SHEATH, TIP_RELEASE_Y, TIP_X, TOWER_X } from './geometry';
import type { BeatId } from './timeline';

type Point = readonly [number, number];

export interface StageLabel {
  id: string;
  /** Line breaks are kept. */
  text: string;
  /** Anchor, in viewBox units. */
  at: Point;
  /** Anchors for particular beats, where the camera frames the point differently. */
  atIn?: Partial<Record<BeatId, Point>>;
  /** Where the label box sits against its anchor, as fractions of its own size. */
  align: Point;
  /** A quarter turn, reading upwards, set against a sheath's left edge. */
  vertical?: boolean;
  /** A sentence about the whole drawing rather than a value on it. */
  caption?: boolean;
  beats: readonly BeatId[];
  /** Shown in these beats only once the release has played. */
  afterRelease?: readonly BeatId[];
}

const below = BASE_Y + 14;
const centre = (LADDER_X[0] + LADDER_X[2]) / 2;
const RELEASED: readonly BeatId[] = ['release', 'refusals'];
const sheathLeft = (k: number) => LADDER_X[k]! - SHEATH.w / 2;
const besideRung = 128;

export const STAGE_LABELS: readonly StageLabel[] = [
  { id: 'count-1', text: `${fmt(RUNGS[0])} rungs`, at: [LADDER_X[0], below], align: [-0.5, 0], beats: ['hero', 'seal'] },
  { id: 'count-2', text: fmt(RUNGS[1]), at: [LADDER_X[1], below], align: [-0.5, 0], beats: ['hero', 'seal'] },
  { id: 'count-3', text: fmt(RUNGS[2]), at: [LADDER_X[2], below], align: [-0.5, 0], beats: ['hero', 'seal'] },
  {
    id: 'run-1',
    text: `Testnet run 1 · ${RUN1.date} · three payments, two minutes apart`,
    at: [centre, BASE_Y + 42],
    align: [-0.5, 0],
    caption: true,
    beats: ['hero', 'seal'],
  },
  { id: 'installment', text: `installment 1 · ${fmt(RUNGS[0])} rungs`, at: [LADDER_X[0] - LADDER_W / 2 - 14, BASE_Y - 60], align: [-1, -0.5], beats: ['sign'] },
  { id: 'tower', text: `${fmt(TOWER_RUNGS)} rungs · due in 30 days`, at: [TOWER_X + LADDER_W / 2 + 14, BASE_Y - 1100], align: [0, -0.5], beats: ['tower'] },
  { id: 'tip', text: `tip ${fmt(RUN1.mined[0] - 1)}`, at: [TIP_X[0], TIP_RELEASE_Y + 6], align: [0, 0], beats: ['hero'], afterRelease: RELEASED },
  { id: 'round', text: `round ${fmt(RUN1.rounds[0])}`, at: [besideRung, RUNG.y - 18], align: [0, -1], beats: [], afterRelease: RELEASED },
  { id: 'rung', text: `rung for ${fmt(RUN1.mined[0])}`, at: [besideRung, RUNG.y - 7], align: [0, -1], beats: [], afterRelease: RELEASED },
  // Right of the two bars once they are out, short of ladder 1's rail, and under the tip
  // line (which runs through the rung's middle after the release): above it, 'rung for …'
  // would crowd it in a narrow frame.
  { id: 'actions', text: '2 actions', at: [RUNG.x + RUNG.w + RUNG_OUT_DX + 10, RUNG.y + RUNG.h / 2 + 5], align: [0, 0], beats: [], afterRelease: RELEASED },
  ...RUN1.rounds.map(
    (round, k): StageLabel => ({
      id: `sheath-${k + 1}`,
      text: `${RUN1.packageKiB} KiB · not before round ${fmt(round)}`,
      at: [sheathLeft(k) - 5, SHEATH.y + SHEATH.h],
      align: [0, 0],
      vertical: true,
      beats: ['seal'],
    }),
  ),
  { id: 'mined', text: `installment 1\nmined at ${fmt(RUN2.installment1Mined)}`, at: [LADDER_X[0], below], align: [-0.5, 0], beats: ['cancel'] },
  { id: 'never', text: '2 and 3\ncan never be valid', at: [(LADDER_X[1] + LADDER_X[2]) / 2, below], align: [-0.5, 0], beats: ['cancel'] },
  {
    id: 'run-2',
    text: "Testnet run 2 · a separate mandate. Its rung counts weren't recorded, so these ladders aren't to scale.",
    at: [centre, BASE_Y + 58],
    align: [-0.5, 0],
    caption: true,
    beats: ['cancel'],
  },
];

export const labelAnchor = (l: StageLabel, beat: BeatId): Point => l.atIn?.[beat] ?? l.at;
