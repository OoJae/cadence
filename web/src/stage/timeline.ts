/**
 * The stage's choreography, defined once and played by both tiers: the 2.5D SVG stage
 * (always shipped) and the WebGL stage (desktop enhancement). Times are milliseconds.
 *
 * The ladders are testnet run 1 at their real rung counts (pages/landing/data.ts). A
 * beat is a resting state the stage eases to when its passage crosses mid-viewport; the
 * release is the page's one orchestrated moment, played once per page view.
 */
import { DUR } from '../motion/tokens';

export type BeatId = 'hero' | 'gap' | 'sign' | 'tower' | 'seal' | 'hold' | 'release' | 'refusals' | 'cancel';

export const BEAT_ORDER: readonly BeatId[] = ['hero', 'gap', 'sign', 'tower', 'seal', 'hold', 'release', 'refusals', 'cancel'];

/** A perspective camera in stage units: ladders 1-3 stand at x = -1.1, 0, 1.1 on y = 0. */
export interface Camera3D {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov: number;
}

export interface BeatState {
  camera: Camera3D;
  /** 0: ladders at full tone; 1: receded into the fog. */
  dim: number;
  /** 0: no sheaths; 1: every ladder sealed in its identical 64 KiB sheath. */
  sheaths: number;
  /** 0-1: the 5,844-rung "due in 30 days" tower. */
  tower: number;
  /** 0-1: the run-2 configuration (installment 1 mined, 2 and 3 hollow: can never be valid). */
  cancel: number;
}

export const BEATS: Record<BeatId, BeatState> = {
  hero: { camera: { position: [3.4, 1.2, 9.5], target: [0.2, 2.6, 0], fov: 26 }, dim: 0, sheaths: 0, tower: 0, cancel: 0 },
  gap: { camera: { position: [4.6, 2.4, 14], target: [0, 3, 0], fov: 26 }, dim: 0.2, sheaths: 0, tower: 0, cancel: 0 },
  sign: { camera: { position: [-0.6, 0.6, 2.6], target: [-1.1, 0.9, 0], fov: 26 }, dim: 0, sheaths: 0, tower: 0, cancel: 0 },
  tower: { camera: { position: [-0.6, 6, 3.2], target: [-2.4, 14, 0], fov: 26 }, dim: 0, sheaths: 0, tower: 1, cancel: 0 },
  seal: { camera: { position: [3.0, 1.6, 10.5], target: [0, 3.1, 0], fov: 26 }, dim: 0, sheaths: 1, tower: 0, cancel: 0 },
  hold: { camera: { position: [3.0, 1.6, 10.5], target: [0, 3.1, 0], fov: 26 }, dim: 0.12, sheaths: 0.15, tower: 0, cancel: 0 },
  release: { camera: { position: [-0.2, 0.5, 4.2], target: [-1.1, 0.25, 0], fov: 26 }, dim: 0, sheaths: 1, tower: 0, cancel: 0 },
  refusals: { camera: { position: [-0.2, 0.5, 4.2], target: [-1.1, 0.25, 0], fov: 26 }, dim: 0.3, sheaths: 1, tower: 0, cancel: 0 },
  cancel: { camera: { position: [2.2, 1.4, 8.0], target: [0, 2.4, 0], fov: 26 }, dim: 0, sheaths: 0, tower: 0, cancel: 1 },
};

/**
 * The SVG tier's camera, framing the same facts as the 3D cameras above: a 2D transform
 * (translate and scale) on the stage's wrapper. Not perspective: a 3D transform makes the
 * compositor resample the one-unit rungs, which beats into moiré and splits the rails at
 * tile seams; a flat camera is painted as vectors at rest, crisp at every zoom. Depth comes
 * from scale, from the DOM labels moving over the drawing, and from the rung coming forward.
 * Points are viewBox units of stage/geometry.ts.
 */
export interface SvgCamera {
  /** The stage point the camera centres on. */
  focus: readonly [number, number];
  /** Where that point lands, in the unmoved stage's units. */
  at: readonly [number, number];
  /**
   * Or where it lands as fractions of the frame's width and height. On phones the drawing
   * is anchored to the frame's foot, so a point in its units drifts with the screen's
   * shape; a fraction stays put.
   */
  frame?: readonly [number, number];
  scale: number;
}

const BASE: readonly [number, number] = [388, 770];
const ON_RUNG: SvgCamera = { focus: [200, 752], at: [320, 520], scale: 2.6 };

export const SVG_CAMERAS: Record<BeatId, SvgCamera> = {
  hero: { focus: BASE, at: [388, 620], scale: 1 },
  gap: { focus: BASE, at: [388, 650], scale: 0.86 },
  sign: { focus: [268, 700], at: [300, 480], scale: 2.3 },
  tower: { focus: [200, 770], at: [300, 820], scale: 0.42 },
  seal: { focus: BASE, at: [388, 640], scale: 0.98 },
  hold: { focus: BASE, at: [388, 650], scale: 0.94 },
  release: ON_RUNG,
  refusals: ON_RUNG,
  cancel: { focus: BASE, at: [388, 640], scale: 1 },
};

/**
 * A portrait stage (phones) sits behind the passages, which cover its middle: the ladders
 * stand lower, so the amber rung shows under the hero's text. The release is framed high,
 * at a quarter of the screen whatever its shape, so the moment plays above its passage's
 * plate (whose top is near a third of the screen when the moment fires), not behind it.
 */
export const SVG_CAMERAS_NARROW: Partial<Record<BeatId, SvgCamera>> = {
  hero: { focus: BASE, at: [388, 850], scale: 1 },
  gap: { focus: BASE, at: [388, 850], scale: 0.9 },
  seal: { focus: BASE, at: [388, 830], scale: 0.98 },
  hold: { focus: BASE, at: [388, 830], scale: 0.94 },
  release: { focus: [200, 752], at: [350, 200], frame: [0.55, 0.26], scale: 2.8 },
  refusals: { focus: [200, 752], at: [350, 200], frame: [0.55, 0.26], scale: 2.8 },
  cancel: { focus: BASE, at: [388, 830], scale: 1 },
};

/** Moving between beats: the camera, then dims and states. Retargets from current values. */
export const BEAT_TWEEN = { camera: DUR.camera, state: 600 } as const;

export type ReleaseStepId = 'label' | 'sheath' | 'tip' | 'brighten' | 'slide' | 'split' | 'cascade' | 'caption';

export interface ReleaseStep {
  id: ReleaseStepId;
  at: number;
  dur: number;
  ease: 'reveal' | 'toggle';
  /** Cascades only: bands fading outward from the pulled rung, each `stagger` ms apart. */
  bands?: number;
  stagger?: number;
}

/**
 * The release, 1.4 s, never scrubbed. The rung for the block after the tip is pulled out
 * in amber and splits into two bars (the two Ironwood actions); its 156 siblings, which
 * spend the same note, fade to void.
 */
export const RELEASE: readonly ReleaseStep[] = [
  { id: 'label', at: 0, dur: 360, ease: 'toggle' },
  { id: 'sheath', at: 120, dur: 600, ease: 'reveal' },
  { id: 'tip', at: 300, dur: 360, ease: 'toggle' },
  { id: 'brighten', at: 500, dur: 240, ease: 'toggle' },
  { id: 'slide', at: 620, dur: 800, ease: 'reveal' },
  { id: 'split', at: 900, dur: 360, ease: 'toggle' },
  { id: 'cascade', at: 700, dur: 360, ease: 'toggle', bands: 8, stagger: 50 },
  { id: 'caption', at: 1000, dur: 600, ease: 'reveal', stagger: 80 },
];

export const releaseStep = (id: ReleaseStepId): ReleaseStep => RELEASE.find((s) => s.id === id)!;

/** When the stage part of the moment is still: the caption reveals on past it. */
export const RELEASE_STAGE_END = Math.max(
  ...RELEASE.filter((s) => s.id !== 'caption').map((s) => s.at + s.dur + ((s.bands ?? 1) - 1) * (s.stagger ?? 0)),
);

/** What each stage tier implements. Created inside effects, never at module load. */
export interface StageDriver {
  setBeat(beat: BeatId, opts?: { instant?: boolean }): void;
  /** Plays the release once; later calls (or instant) jump to its end state. */
  playRelease(opts?: { instant?: boolean }): void;
  /** Re-reads the CSS custom properties after a theme change. */
  setTheme(): void;
  dispose(): void;
}
