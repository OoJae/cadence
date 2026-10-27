/**
 * The stage's WebGL tier: testnet run 1's ladders in depth, with fog and a key light,
 * played from the same beats and release timeline as the SVG tier (stage/timeline.ts).
 * three.js core only, built imperatively from procedural geometry: no models, loaders,
 * textures or workers. It renders on demand, so the GPU does nothing while the page is
 * still, and it steps itself down (frameGuard.ts) or hands back to the SVG when it can't
 * keep up. Loaded only by probe.ts, as its own chunk.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material } from 'three';
import { EASE_REVEAL, EASE_TOGGLE, motionOk } from '../motion/tokens';
import { RUN1, RUN1_RELEASED_INDEX, TOWER_RUNGS } from '../pages/landing/data';
import { FrameGuard } from './frameGuard';
import { STAGE_LABELS } from './labels';
import type { GlContext } from './probe';
import { GRAIN_FRAG, GRAIN_VERT, LINE_FRAG, LINE_VERT, RUNG_FRAG, RUNG_VERT, RUNGS_FRAG, RUNGS_VERT, SOLID_FRAG, SOLID_VERT, TIP_FRAG } from './shaders';
import { BEAT_TWEEN, BEATS, releaseStep, type BeatId, type Camera3D, type ReleaseStepId, type StageDriver } from './timeline';
import { opacity, rise, Track } from './tween';

// ------------------------------------------------------------------ the drawing, in stage units

/** One block of height per rung. */
const P = 0.036;
const LADDER_X = [-1.1, 0, 1.1] as const;
const RUNGS = RUN1.rungs;
const RUNG_W = 0.42;
const RAIL = 0.035;
const RAIL_X = RUNG_W / 2 + RAIL / 2;
const TOWER_X = -2.4;
/** The rung for the block after the tip, on installment 1's ladder. */
const RELEASED = RUN1_RELEASED_INDEX;
const RUNG_Y = (RELEASED + 0.5) * P;
/** In run 1 every package was the same 64 KiB, so every sheath is the same box. */
const SHEATH = { w: 0.62, h: 6.5, d: 0.2, y: 6.5 / 2 - 0.1 } as const;
const TIP = { x: -0.5, w: 4.2, h: 0.1, thickness: 0.006 } as const;
/**
 * The pulled rung: clear of its ladder for the poster, further out and towards the viewer
 * once sent. Seen from above the tip line, coming forward would also drop it below the
 * line; the small lift keeps it sitting on the line as it comes.
 */
const RUNG_POSTER = [-0.56, 0, 0] as const;
const RUNG_OUT = [-0.95, 0.11, 1.5] as const;
const SHEATH_LIFT = 0.4;
const BEAD = { r: 0.03, at: [(LADDER_X[1] + LADDER_X[2]) / 2, 0.05, 0.12] as const, forward: 1.8 };

/** Rung tones: sealed, the next one waiting for its round. */
const SEALED = 0.62;
const WAITING = 0.6;
const SHEATH_ALPHA = 0.35;
const TOWER_TONE = 0.5;

/**
 * The timeline's cameras, framed for this canvas. The beats keep their angle and target;
 * the lens stands further back on the same line (so every ladder fits the stage's height,
 * labels included) and the fog moves back with it. The view is shifted so the ladders
 * hold the stage's columns rather than its centre, and raised (as a fraction of the
 * height) where the whole drawing is in view, so the ladders' feet and labels clear the
 * fold the way the SVG stage's do.
 */
const LENS = { dolly: 2.1, near: 0.1, far: 600, shift: 0.06 } as const;
const FRAME_Y: Record<BeatId, number> = { hero: 0.1, gap: 0.1, sign: 0, tower: 0, seal: 0.1, hold: 0.1, release: 0, refusals: 0, cancel: 0.1 };
/**
 * Behind the passages (the phones' layout, which this tier gets from 768 to 959 px), the
 * text plates cover the stage's middle: the ladders stand low, under the hero's text,
 * and the release is framed high, above its passage, so the moment isn't played behind
 * a plate.
 */
const FRAME_Y_NARROW: Record<BeatId, number> = { hero: -0.1, gap: -0.1, sign: -0.2, tower: -0.2, seal: -0.1, hold: -0.1, release: 0.28, refusals: 0.28, cancel: -0.1 };
/** Looking up the tower from further back, its rungs foreshorten below a pixel: there the lens stays at the timeline's distance. */
const DOLLY: Partial<Record<BeatId, number>> = { tower: 1 };
const FOG = { near: 8 * LENS.dolly, far: 34 * LENS.dolly } as const;
/**
 * The frame the framings were drawn for (columns 7 to 12 at 1440 × 900). A narrower frame
 * (960 to 1279 px, or a tall screen) widens the view to keep the same width in shot, so
 * the pulled rung and its labels never fall off the frame's edge.
 */
const FRAMED_ASPECT = 0.78;
const fovFor = (aspect: number): number => {
  const base = BEATS.hero.camera.fov;
  if (aspect >= FRAMED_ASPECT) return base;
  return (2 * Math.atan((Math.tan((base * Math.PI) / 360) * FRAMED_ASPECT) / aspect) * 180) / Math.PI;
};
const MAX_DPR = 1.75;

const CASCADE_BANDS = 8;
const CASCADE_PER = Math.ceil(Math.max(RELEASED, RUNGS[0] - 1 - RELEASED) / CASCADE_BANDS);

// ------------------------------------------------------------------ easing and tweens

type Ease = (t: number) => number;

/** CSS cubic-bezier(), solved for x by Newton's method with a bisection fallback. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** The motion tokens, read from their CSS strings so there is one source. */
const fromToken = (css: string): Ease => {
  const [a, b, c, d] = (css.match(/-?[\d.]+/g) ?? []).map(Number);
  return cubicBezier(a!, b!, c!, d!);
};
const REVEAL = fromToken(EASE_REVEAL);
const TOGGLE = fromToken(EASE_TOGGLE);

interface To {
  dur: number;
  delay?: number;
  ease?: Ease;
  instant?: boolean;
}

/** Numbers that ease to a target. A new target starts from the value on screen now. */
class Channel {
  v: number[];
  private from: number[];
  private target: number[];
  private t0 = 0;
  private dur = 0;
  private ease: Ease = REVEAL;
  active = false;

  constructor(initial: readonly number[]) {
    this.v = [...initial];
    this.from = [...initial];
    this.target = [...initial];
  }

  to(target: readonly number[], { dur, delay = 0, ease = REVEAL, instant = false }: To): void {
    const now = performance.now();
    this.sample(now);
    this.target = [...target];
    if (instant || dur <= 0 || this.v.every((x, i) => Math.abs(x - target[i]!) < 1e-5)) {
      this.v = [...target];
      this.active = false;
      return;
    }
    this.from = [...this.v];
    this.t0 = now + delay;
    this.dur = dur;
    this.ease = ease;
    this.active = true;
  }

  /** Brings v to time `now`; true while still moving. */
  sample(now: number): boolean {
    if (!this.active) return false;
    const t = (now - this.t0) / this.dur;
    if (t >= 1) {
      this.v = [...this.target];
      this.active = false;
      return false;
    }
    const e = t <= 0 ? 0 : this.ease(t);
    for (let i = 0; i < this.v.length; i++) this.v[i] = this.from[i]! + (this.target[i]! - this.from[i]!) * e;
    return true;
  }

  get x(): number {
    return this.v[0]!;
  }
}

// ------------------------------------------------------------------ colours from the page

type Rgb = [number, number, number];

/** A CSS colour as sRGB 0-1, through a probe element so any syntax resolves. */
function readColour(probe: HTMLElement, cssVar: string): Rgb {
  probe.style.color = `var(${cssVar})`;
  const c = getComputedStyle(probe).color;
  const n = (c.match(/-?[\d.]+/g) ?? []).map(Number);
  // rgb(r g b) is 0-255; color(srgb r g b) is 0-1.
  const scale = c.startsWith('color(') ? 1 : 1 / 255;
  return [(n[0] ?? 0) * scale, (n[1] ?? 0) * scale, (n[2] ?? 0) * scale];
}

// ------------------------------------------------------------------ geometry helpers

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  group: number;
}

/** Boxes merged into one geometry, each tagged with a group the shader can fade. */
function mergedBoxes(boxes: readonly Box[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const grp: number[] = [];
  const idx: number[] = [];
  for (const b of boxes) {
    const g = new BoxGeometry(b.w, b.h, b.d);
    g.translate(b.x, b.y, b.z);
    const base = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    for (let i = 0; i < g.getAttribute('position').count; i++) grp.push(b.group);
    for (const i of g.getIndex()!.array) idx.push(base + i);
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('aGroup', new BufferAttribute(new Float32Array(grp), 1));
  out.setIndex(idx);
  return out;
}

const railsOf = (x: number, n: number, group: number): Box[] =>
  [-1, 1].map((s) => ({ x: x + s * RAIL_X, y: (n * P) / 2, z: 0, w: RAIL, h: n * P, d: RAIL, group }));

// ------------------------------------------------------------------ labels

type V3 = readonly [number, number, number];

interface Anchor {
  at: V3;
  /** A nudge in CSS pixels. */
  px?: readonly [number, number];
  /** Overrides the label's own alignment (stage/labels.ts). */
  align?: readonly [number, number];
  /** Elsewhere in particular beats. */
  in?: Partial<Record<BeatId, Anchor>>;
}

const RUNG_OUT_LEFT = LADDER_X[0] + RUNG_OUT[0] - RUNG_W / 2;

/** Where each stage label (stage/labels.ts) is pinned in 3D. */
const ANCHORS: Record<string, Anchor> = {
  'count-1': { at: [LADDER_X[0], 0, 0], px: [0, 14] },
  'count-2': { at: [LADDER_X[1], 0, 0], px: [0, 14] },
  'count-3': { at: [LADDER_X[2], 0, 0], px: [0, 14] },
  'run-1': { at: [0, 0, 0], px: [0, 44] },
  installment: { at: [LADDER_X[0] - RAIL_X - 0.06, 0.9, 0] },
  // Left of the tower: its right runs into the drand rail's margin.
  tower: { at: [TOWER_X - RAIL_X - 0.08, 13.2, 0], align: [-1, -0.5] },
  tip: {
    at: [TIP.x - TIP.w / 2, RELEASED * P, 0],
    px: [0, 6],
    // Close on the sent rung, the line's end is under it: the label moves past ladder 1.
    in: {
      release: { at: [LADDER_X[0] + RAIL_X + 0.06, RELEASED * P, 0], px: [0, -6], align: [0, -1] },
      refusals: { at: [LADDER_X[0] + RAIL_X + 0.06, RELEASED * P, 0], px: [0, -6], align: [0, -1] },
    },
  },
  round: { at: [RUNG_OUT_LEFT, RUNG_Y + RUNG_OUT[1] + P, RUNG_OUT[2]], px: [0, -26] },
  rung: { at: [RUNG_OUT_LEFT, RUNG_Y + RUNG_OUT[1] + P, RUNG_OUT[2]], px: [0, -8] },
  actions: { at: [LADDER_X[0] + RUNG_OUT[0] + RUNG_W / 2 + 0.03, RUNG_Y + RUNG_OUT[1], RUNG_OUT[2]], px: [6, 0], align: [0, -0.5] },
  'sheath-1': { at: [LADDER_X[0] - SHEATH.w / 2, SHEATH.y - SHEATH.h / 2, SHEATH.d / 2], px: [-6, 0] },
  'sheath-2': { at: [LADDER_X[1] - SHEATH.w / 2, SHEATH.y - SHEATH.h / 2, SHEATH.d / 2], px: [-6, 0] },
  'sheath-3': { at: [LADDER_X[2] - SHEATH.w / 2, SHEATH.y - SHEATH.h / 2, SHEATH.d / 2], px: [-6, 0] },
  mined: { at: [LADDER_X[0], 0, 0], px: [0, 14] },
  never: { at: [(LADDER_X[1] + LADDER_X[2]) / 2, 0, 0], px: [0, 14] },
  'run-2': { at: [0, 0, 0], px: [0, 60] },
};

// ------------------------------------------------------------------ the driver

export interface GlHooks {
  /** The stage can't go on (too slow, or its context was lost): hand back to the SVG. */
  fail(): void;
}

interface Pose {
  beat: BeatId;
  poster: boolean;
  released: boolean;
  cancel: boolean;
}

/**
 * Builds the WebGL stage inside the stage frame, hidden, and resolves once its shaders are
 * compiled. It fades in over the SVG on its first frame; the SVG then stays, hidden, as
 * the fallback. Created inside an effect, never at module load.
 */
export async function createGlStage(frame: HTMLElement, ctx: GlContext, hooks: GlHooks): Promise<StageDriver> {
  const { canvas, gl } = ctx;
  const svgParts = [frame.querySelector<HTMLElement>('.stage-camera'), frame.querySelector<HTMLElement>('.stage-labels')].filter((el): el is HTMLElement => !!el);

  // The canvas and its labels, positioned through the CSSOM (the CSP allows no style attributes).
  const layer = document.createElement('div');
  layer.className = 'stage-gl';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { position: 'absolute', inset: '0', zIndex: '1', opacity: '0', pointerEvents: 'none' });
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  const labelLayer = document.createElement('div');
  labelLayer.className = 'stage-labels';
  const colourProbe = document.createElement('span');
  colourProbe.hidden = true;
  layer.append(canvas, labelLayer, colourProbe);
  frame.append(layer);

  const renderer = new WebGLRenderer({ canvas, context: gl });
  // Shader logs need a synchronous round trip to the GPU; only development wants them.
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  let dprCap = MAX_DPR;
  renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <T extends BufferGeometry>(g: T): T => (geometries.push(g), g);
  const scene = new Scene();
  const camera = new PerspectiveCamera(BEATS.hero.camera.fov, 1, LENS.near, LENS.far);

  // ---------------------------------------------------------------- materials
  const shared = {
    uBg: { value: new Vector3() },
    uFogNear: { value: FOG.near },
    uFogFar: { value: FOG.far },
    uDim: { value: 0 },
  };
  const ink = { value: new Vector3() };
  const muted = { value: new Vector3() };
  const amber = { value: new Vector3() };
  const grain = { uGrain: { value: 0.045 }, uPixelRatio: { value: 1 }, uBelow: { value: 0 } };

  const material = (m: ShaderMaterial): ShaderMaterial => (materials.push(m), m);
  const solid = (alphas: number[]) =>
    material(new ShaderMaterial({ vertexShader: SOLID_VERT, fragmentShader: SOLID_FRAG, uniforms: { ...shared, uInk: ink, uGroupAlpha: { value: alphas } } }));
  const rungsOf = (n: number, released: number, tone: number) =>
    material(
      new ShaderMaterial({
        vertexShader: RUNGS_VERT,
        fragmentShader: RUNGS_FRAG,
        uniforms: {
          ...shared,
          uInk: ink,
          uN: { value: n },
          uTone: { value: tone },
          uAlpha: { value: 1 },
          uReleased: { value: released },
          uPer: { value: CASCADE_PER },
          uBands: { value: new Array<number>(CASCADE_BANDS).fill(0) },
          uHollow: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
      }),
    );
  const line = (alpha: number) =>
    material(new ShaderMaterial({ vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms: { ...shared, uInk: ink, uAlpha: { value: alpha } }, transparent: true, depthWrite: false }));

  // ---------------------------------------------------------------- the scene
  const railsMat = solid([1, 1, 1]);
  const rails = new Mesh(keep(mergedBoxes(LADDER_X.flatMap((x, k) => railsOf(x, RUNGS[k]!, k)))), railsMat);

  const ladderMats = LADDER_X.map((_, k) => rungsOf(RUNGS[k]!, k === 0 ? RELEASED : -1, SEALED));
  const ladders = LADDER_X.map((x, k) => {
    const h = RUNGS[k]! * P;
    const m = new Mesh(keep(new PlaneGeometry(RUNG_W, h)), ladderMats[k]);
    m.position.set(x, h / 2, 0);
    return m;
  });

  // The 30-day tower: a fourth ladder at its true count, which the fog swallows.
  const towerH = TOWER_RUNGS * P;
  const towerRailMat = solid([0, 0, 0]);
  const towerMat = rungsOf(TOWER_RUNGS, -1, TOWER_TONE);
  const tower = new Group();
  const towerPlane = new Mesh(keep(new PlaneGeometry(RUNG_W, towerH)), towerMat);
  towerPlane.position.set(TOWER_X, towerH / 2, 0);
  tower.add(new Mesh(keep(mergedBoxes(railsOf(TOWER_X, TOWER_RUNGS, 0))), towerRailMat), towerPlane);

  const sheathEdges = keep(new EdgesGeometry(keep(new BoxGeometry(SHEATH.w, SHEATH.h, SHEATH.d))));
  const sheathMats = LADDER_X.map(() => line(0));
  const sheaths = LADDER_X.map((x, k) => {
    const s = new LineSegments(sheathEdges, sheathMats[k]);
    s.position.set(x, SHEATH.y, 0);
    return s;
  });

  // The pulled rung: two unit boxes, one per Ironwood action, placed and sized in the vertex shader.
  const rungGeo = keep(mergedBoxes([0, 1].map((group) => ({ x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, group }))));
  const sides = rungGeo.getAttribute('aGroup').array as Float32Array;
  rungGeo.setAttribute('aSide', new BufferAttribute(Float32Array.from(sides, (g) => (g === 0 ? 1 : -1)), 1));
  const rungMat = material(
    new ShaderMaterial({
      vertexShader: RUNG_VERT,
      fragmentShader: RUNG_FRAG,
      uniforms: {
        ...shared,
        uAmber: amber,
        uInk: ink,
        uSplit: { value: 0 },
        uSize: { value: new Vector3(RUNG_W, P, 0.012) },
        uLevel: { value: 1 },
        uPast: { value: 0 },
        uAlpha: { value: 1 },
      },
    }),
  );
  const rung = new Mesh(rungGeo, rungMat);

  const tipMat = material(
    new ShaderMaterial({
      vertexShader: RUNGS_VERT,
      fragmentShader: TIP_FRAG,
      uniforms: { ...shared, uInk: muted, uAlpha: { value: 1 }, uHeight: { value: TIP.h }, uThickness: { value: TIP.thickness } },
      transparent: true,
      depthWrite: false,
    }),
  );
  const tip = new Mesh(keep(new PlaneGeometry(TIP.w, TIP.h)), tipMat);

  const beadGeo = keep(new SphereGeometry(BEAD.r, 16, 12));
  beadGeo.setAttribute('aGroup', new BufferAttribute(new Float32Array(beadGeo.getAttribute('position').count), 1));
  const beadMat = solid([0, 0, 0]);
  const bead = new Mesh(beadGeo, beadMat);

  const grainGeo = keep(new BufferGeometry());
  grainGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const grainMesh = new Mesh(
    grainGeo,
    material(new ShaderMaterial({ vertexShader: GRAIN_VERT, fragmentShader: GRAIN_FRAG, uniforms: grain, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false })),
  );
  grainMesh.frustumCulled = false;
  grainMesh.renderOrder = 10;

  scene.add(rails, ...ladders, tower, ...sheaths, rung, tip, bead, grainMesh);

  // ---------------------------------------------------------------- theme
  const setColours = () => {
    const bg = readColour(colourProbe, '--bg');
    shared.uBg.value.set(...bg);
    ink.value.set(...readColour(colourProbe, '--text'));
    muted.value.set(...readColour(colourProbe, '--muted'));
    amber.value.set(...readColour(colourProbe, '--accent-graphic'));
    const g = parseFloat(getComputedStyle(colourProbe).getPropertyValue('--grain'));
    grain.uGrain.value = Number.isFinite(g) ? g : 0.045;
    // The clear colour is converted from three's working space back to sRGB on output.
    renderer.setClearColor(new Color().setRGB(bg[0], bg[1], bg[2], SRGBColorSpace));
  };
  setColours();

  // ---------------------------------------------------------------- channels
  /** Position, target, and the view's vertical framing. */
  const lens = (b: BeatId): number[] => {
    const c: Camera3D = BEATS[b].camera;
    const [tx, ty, tz] = c.target;
    const [px, py, pz] = c.position;
    const d = DOLLY[b] ?? LENS.dolly;
    return [tx + (px - tx) * d, ty + (py - ty) * d, tz + (pz - tz) * d, tx, ty, tz, FRAME_Y[b], FRAME_Y_NARROW[b]];
  };
  const ch = {
    camera: new Channel(lens('hero')),
    dim: new Channel([0]),
    sheathAlpha: LADDER_X.map(() => new Channel([0])),
    sheathScale: LADDER_X.map(() => new Channel([1.2])),
    sheathLift: LADDER_X.map(() => new Channel([0])),
    tower: new Channel([0]),
    tipY: new Channel([RELEASED]),
    tipAlpha: new Channel([1]),
    rungAt: new Channel([...RUNG_POSTER]),
    rungLevel: new Channel([1]),
    rungPast: new Channel([0]),
    split: new Channel([0]),
    bands: Array.from({ length: CASCADE_BANDS }, () => new Channel([0])),
    hollow: [new Channel([0]), new Channel([0])],
    railAlpha: [new Channel([1]), new Channel([1])],
    bead: new Channel([0]),
  };
  const all: Channel[] = Object.values(ch).flatMap((c) => (Array.isArray(c) ? c : [c]));

  const target = new Vector3();
  const writeScene = () => {
    const c = ch.camera.v;
    camera.position.set(c[0]!, c[1]!, c[2]!);
    camera.lookAt(target.set(c[3]!, c[4]!, c[5]!));
    frameView();
    shared.uDim.value = ch.dim.x;
    sheaths.forEach((s, k) => {
      const a = ch.sheathAlpha[k]!.x;
      s.visible = a > 0.002;
      sheathMats[k]!.uniforms.uAlpha!.value = a * SHEATH_ALPHA;
      s.scale.setScalar(ch.sheathScale[k]!.x);
      s.position.y = SHEATH.y + ch.sheathLift[k]!.x;
    });
    const t = ch.tower.x;
    tower.visible = t > 0.002;
    tower.position.y = -(1 - t) * 2.4;
    towerMat.uniforms.uAlpha!.value = t;
    (towerRailMat.uniforms.uGroupAlpha!.value as number[])[0] = t;
    tip.position.set(TIP.x, ch.tipY.x * P, 0);
    tipMat.uniforms.uAlpha!.value = ch.tipAlpha.x;
    tip.visible = ch.tipAlpha.x > 0.002;
    const r = ch.rungAt.v;
    rung.position.set(LADDER_X[0] + r[0]!, RUNG_Y + r[1]!, r[2]!);
    rungMat.uniforms.uLevel!.value = ch.rungLevel.x;
    rungMat.uniforms.uPast!.value = ch.rungPast.x;
    rungMat.uniforms.uSplit!.value = ch.split.x;
    const bands = ladderMats[0]!.uniforms.uBands!.value as number[];
    ch.bands.forEach((b, i) => (bands[i] = b.x));
    ch.hollow.forEach((h, j) => (ladderMats[j + 1]!.uniforms.uHollow!.value = h.x));
    const railAlpha = railsMat.uniforms.uGroupAlpha!.value as number[];
    ch.railAlpha.forEach((a, j) => (railAlpha[j + 1] = a.x));
    const b = ch.bead.x;
    bead.visible = b > 0.002;
    (beadMat.uniforms.uGroupAlpha!.value as number[])[0] = b;
    bead.position.set(BEAD.at[0], BEAD.at[1], BEAD.at[2] + b * BEAD.forward);
  };

  // ---------------------------------------------------------------- labels
  const projected = new Vector3();
  let W = 1;
  let H = 1;
  const labels = STAGE_LABELS.map((def) => {
    const el = document.createElement('span');
    el.className = `stage-label${def.vertical ? ' vertical' : ''}${def.caption ? ' caption' : ''}`;
    el.dataset.label = def.id;
    const inner = document.createElement('span');
    inner.className = 'label-inner';
    inner.textContent = def.text;
    el.append(inner);
    labelLayer.append(el);
    const anchor = ANCHORS[def.id] ?? { at: [0, 0, 0] as V3 };
    return { def, el, anchor, fade: new Track(el, 'opacity', opacity, [0]), rise: new Track(inner, 'transform', rise, [0]) };
  });
  const placeLabels = () => {
    for (const l of labels) {
      const a = l.anchor.in?.[beat] ?? l.anchor;
      const align = a.align ?? l.def.align;
      projected.set(...a.at).project(camera);
      // Whole pixels keep the mono text crisp.
      const sx = Math.round(((projected.x + 1) / 2) * W + (a.px?.[0] ?? 0));
      const sy = Math.round(((1 - projected.y) / 2) * H + (a.px?.[1] ?? 0));
      l.el.style.visibility = projected.z > 1 ? 'hidden' : '';
      l.el.style.transform = l.def.vertical
        ? `translate(${sx}px, ${sy}px) rotate(-90deg) translateY(-100%)`
        : `translate(${sx}px, ${sy}px) translate(${align[0] * 100}%, ${align[1] * 100}%)`;
    }
  };

  // ---------------------------------------------------------------- size and framing
  let narrow = false;
  let viewY = NaN;
  /** The view offset: shifted right of centre, raised or lowered by the beat's framing. */
  const frameView = () => {
    const at = ch.camera.v[narrow ? 7 : 6]!;
    if (at === viewY) return;
    viewY = at;
    camera.setViewOffset(W, H, -LENS.shift * W, at * H, W, H);
  };
  const resize = () => {
    W = Math.max(1, frame.clientWidth);
    H = Math.max(1, frame.clientHeight);
    narrow = getComputedStyle(frame).getPropertyValue('--stage-layout').trim() === 'narrow';
    const dpr = Math.min(devicePixelRatio, dprCap);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    grain.uPixelRatio.value = dpr;
    camera.aspect = W / H;
    // The phones' layout (768 to 959 px here) has its own framing; leave it as drawn.
    camera.fov = narrow ? BEATS.hero.camera.fov : fovFor(camera.aspect);
    viewY = NaN;
    frameView();
  };

  // ---------------------------------------------------------------- frames
  let raf = 0;
  let continued = false;
  let drawn = false;
  let dead = false;
  let failing = false;
  let cameraDur: number = BEAT_TWEEN.camera;
  let cameraEase = REVEAL;

  /** CSS pixels of the canvas below the viewport: at the top of the page, before the stage sticks. */
  const belowFold = () => Math.max(0, Math.round(canvas.getBoundingClientRect().bottom - innerHeight));
  let below = 0;

  const draw = (now: number): boolean => {
    let moving = false;
    for (const c of all) moving = c.sample(now) || moving;
    writeScene();
    below = belowFold();
    grain.uBelow.value = below * grain.uPixelRatio.value;
    renderer.render(scene, camera);
    placeLabels();
    return moving;
  };

  const tick = (now: number) => {
    raf = 0;
    if (dead) return;
    const moving = draw(now);
    guard.frame(now, continued, moving);
    continued = moving;
    if (!drawn) {
      drawn = true;
      reveal();
    }
    if (moving) raf = requestAnimationFrame(tick);
  };
  const requestRender = () => {
    if (!raf && !dead) raf = requestAnimationFrame(tick);
  };

  const guard = new FrameGuard((level) => {
    if (level === 'dpr') {
      dprCap = 1;
      resize();
    } else if (level === 'cuts') {
      cameraDur = 360;
      cameraEase = TOGGLE;
    } else fail();
  });

  /** Fades in over the SVG, then hides it; it stays underneath as the fallback. */
  const reveal = () => {
    layer.style.opacity = '1';
    if (!motionOk()) {
      for (const el of svgParts) el.style.visibility = 'hidden';
      return;
    }
    const fade = { duration: 600, easing: EASE_TOGGLE };
    labelsOut = svgParts[1]?.animate([{ opacity: 1 }, { opacity: 0 }], { ...fade, fill: 'forwards' });
    layer.animate([{ opacity: 0 }, { opacity: 1 }], fade).finished.then(
      () => {
        labelsOut?.cancel();
        if (dead) return;
        for (const el of svgParts) el.style.visibility = 'hidden';
      },
      () => labelsOut?.cancel(),
    );
  };
  // The SVG labels' fade-out while the layer comes in: cancelled however the reveal ends, so
  // a failure mid-fade hands back labels that show.
  let labelsOut: Animation | undefined;

  const ro = new ResizeObserver(() => {
    resize();
    requestRender();
  });
  // The grain stops where the viewport does; that edge only moves until the stage sticks,
  // so scrolling draws a handful of frames at the top of the page and none after.
  const onScroll = () => {
    if (belowFold() !== below) requestRender();
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    fail();
  };
  const fail = () => {
    if (failing || dead) return;
    failing = true;
    hooks.fail();
    // If it was never adopted, nobody else will dispose it.
    dispose();
  };

  function dispose() {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    raf = 0;
    ro.disconnect();
    removeEventListener('scroll', onScroll);
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const l of labels) l.fade.cancel(), l.rise.cancel();
    labelsOut?.cancel();
    for (const el of svgParts) el.style.visibility = '';
    const teardown = () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      // dispose() first: it unhooks three's own context-loss listener, which would log.
      renderer.dispose();
      // An already lost context has no extension left to lose it with (three warns).
      if (!gl.isContextLost()) renderer.forceContextLoss();
      layer.remove();
    };
    if (!failing) return teardown();
    // Handing back mid-page: the SVG is already drawn underneath, so fade out over it.
    svgParts[1]?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: EASE_TOGGLE });
    layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: EASE_TOGGLE, fill: 'forwards' }).finished.then(teardown, teardown);
  }

  // ---------------------------------------------------------------- beats
  let beat: BeatId = 'hero';
  let played = false;
  const poseOf = (b: BeatId): Pose => ({
    beat: b,
    poster: b === 'hero' || b === 'gap',
    released: (played && (b === 'release' || b === 'refusals')) || b === 'cancel',
    cancel: b === 'cancel',
  });
  const labelShown = (i: number, p: Pose) => {
    const d = labels[i]!.def;
    return d.beats.includes(p.beat) || (played && !!d.afterRelease?.includes(p.beat));
  };

  const apply = (b: BeatId, instant: boolean) => {
    const prev = beat;
    beat = b;
    const p = poseOf(b);
    const s = BEATS[b];
    const state: To = { dur: BEAT_TWEEN.state, instant };
    const quick: To = { dur: 360, ease: TOGGLE, instant };

    ch.camera.to(lens(b), { dur: cameraDur, ease: cameraEase, instant });
    ch.dim.to([s.dim], state);

    const closing = s.sheaths > BEATS[prev].sheaths;
    LADDER_X.forEach((_, i) => {
      const lift = p.released && !p.cancel && i === 0;
      const opts: To = closing ? { dur: 800, delay: i * 80, instant } : state;
      ch.sheathAlpha[i]!.to([lift ? 0 : s.sheaths], opts);
      ch.sheathScale[i]!.to([1.2 - 0.2 * s.sheaths], opts);
      ch.sheathLift[i]!.to([lift ? SHEATH_LIFT : 0], opts);
    });
    ch.tower.to([s.tower], state);
    ch.tipY.to([p.poster || (p.released && !p.cancel) ? RELEASED : 0], state);
    ch.tipAlpha.to([p.cancel ? 0 : 1], state);

    ch.rungAt.to(p.released ? RUNG_OUT : p.poster ? RUNG_POSTER : [0, 0, 0], state);
    ch.rungLevel.to([p.released || p.poster || p.cancel ? 1 : WAITING], state);
    ch.rungPast.to([p.cancel ? 1 : 0], state);
    ch.split.to([p.released ? 1 : 0], quick);

    ch.bands.forEach((c) => c.to([p.released ? 1 : 0], state));
    ch.hollow.forEach((c, j) => c.to([p.cancel ? 1 : 0], p.cancel ? { dur: BEAT_TWEEN.state, delay: j * 120, ease: REVEAL, instant } : quick));
    ch.railAlpha.forEach((c) => c.to([p.cancel ? 0.22 : 1], state));
    ch.bead.to([p.cancel ? 1 : 0], p.cancel ? { dur: 1000, instant } : quick);

    labels.forEach((l, i) => {
      const show = labelShown(i, p);
      l.fade.to([show ? 1 : 0], show ? { dur: 600, delay: 200, instant } : { dur: 240, ease: EASE_TOGGLE, instant });
      if (show) l.rise.to([0], { dur: 600, delay: 200, instant });
    });
    requestRender();
  };

  /** The page's one orchestrated moment: stage/timeline.ts RELEASE, 1.4 s, never scrubbed. */
  const moment = () => {
    const step = (id: ReleaseStepId): To => {
      const s = releaseStep(id);
      return { dur: s.dur, delay: s.at, ease: s.ease === 'toggle' ? TOGGLE : REVEAL };
    };
    const reveal = (id: string, when: ReleaseStepId) => {
      const l = labels.find((x) => x.def.id === id)!;
      const s = releaseStep(when);
      l.rise.to([105], { dur: 0, instant: true });
      l.fade.to([1], { dur: 120, delay: s.at, ease: EASE_TOGGLE });
      l.rise.to([0], { dur: s.dur, delay: s.at, ease: s.ease === 'toggle' ? EASE_TOGGLE : EASE_REVEAL });
    };

    reveal('round', 'label');
    ch.sheathAlpha[0]!.to([0], step('sheath'));
    ch.sheathLift[0]!.to([SHEATH_LIFT], step('sheath'));
    ch.tipY.to([RELEASED], step('tip'));
    reveal('tip', 'tip');
    ch.rungLevel.to([1], step('brighten'));
    ch.rungAt.to(RUNG_OUT, step('slide'));
    reveal('rung', 'slide');
    ch.split.to([1], step('split'));
    reveal('actions', 'split');
    const cascade = releaseStep('cascade');
    ch.bands.forEach((c, i) => c.to([1], { dur: cascade.dur, delay: cascade.at + i * (cascade.stagger ?? 0), ease: TOGGLE }));
    requestRender();
  };

  // ---------------------------------------------------------------- ready
  canvas.addEventListener('webglcontextlost', onLost);
  resize();
  writeScene();
  try {
    // Off the main thread where the browser can. has() asks quietly; compileAsync without
    // the extension logs a three.js warning (Firefox has none).
    if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, camera);
  } catch {
    // compileAsync is an optimisation; the first render compiles anyway.
  }
  if (dead || gl.isContextLost()) {
    dispose();
    throw new Error('WebGL stage lost its context before its first frame');
  }
  ro.observe(frame);
  addEventListener('scroll', onScroll, { passive: true });

  return {
    setBeat(b, opts) {
      if (failing || dead) return;
      if (b === beat && !opts?.instant) return;
      apply(b, !!opts?.instant || !motionOk());
    },
    playRelease(opts) {
      if (failing || dead) return;
      const first = !played;
      played = true;
      const here = beat === 'release' || beat === 'refusals';
      if (first && here && !opts?.instant && motionOk()) moment();
      else apply(beat, !!opts?.instant || !motionOk());
    },
    setTheme() {
      if (dead) return;
      setColours();
      // Drawn now, not on the next frame, so the canvas switches with the page.
      if (drawn) draw(performance.now());
      else requestRender();
    },
    dispose,
  };
}
