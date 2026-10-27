/**
 * The SVG tier's StageDriver: the stage's resting state for each beat, and the release.
 * Everything moves through Track (transform and opacity only); colours are CSS, so a
 * theme switch needs nothing from here. Created inside an effect, never at module load.
 */
import { EASE_REVEAL, EASE_TOGGLE, motionOk } from '../motion/tokens';
import { CASCADE_BANDS, HOLLOW_BANDS, PITCH, RELEASED, RUNG_OUT_DX, RUNG_OUT_SCALE, RUNG_POSTER_DX, SHEATH, SPLIT, VIEW } from './geometry';
import { labelAnchor, STAGE_LABELS } from './labels';
import { BEAT_TWEEN, BEATS, releaseStep, SVG_CAMERAS, SVG_CAMERAS_NARROW, type BeatId, type StageDriver, type SvgCamera } from './timeline';
import { opacity, rise, shift, shiftScale, Track } from './tween';

/** Rung opacity once void: the 156 siblings of a sent rung, which can never be valid. */
const VOID = 0.12;
const HOLLOW = 0.08;
/** The sealed-but-next rung glows at 60% until its round arrives. */
const WAITING = 0.6;
const SHEATH_LIFT = -0.06 * SHEATH.h;

type El = Element & ElementCSSInlineStyle;

interface Pose {
  beat: BeatId;
  poster: boolean;
  released: boolean;
  cancel: boolean;
}

export function createSvgDriver(frame: HTMLElement): StageDriver {
  const one = <T extends El>(part: string): T => {
    const el = frame.querySelector<T & Element>(`[data-part="${part}"]`);
    if (!el) throw new Error(`stage part ${part} missing`);
    return el;
  };
  const all = <T extends El>(part: string): T[] => [...frame.querySelectorAll<T & Element>(`[data-part="${part}"]`)];

  // ---------------------------------------------------------------- layout and camera
  let W = 1;
  let H = 1;
  let k = 1;
  let ox = 0;
  let oy = 0;
  // The stylesheet says when the stage stands behind the passages (phones) rather than beside them.
  let narrow = false;
  const measure = () => {
    W = Math.max(1, frame.clientWidth);
    H = Math.max(1, frame.clientHeight);
    narrow = getComputedStyle(frame).getPropertyValue('--stage-layout').trim() === 'narrow';
    // preserveAspectRatio="xMidYMax meet"
    k = Math.min(W / VIEW.w, H / VIEW.h);
    ox = (W - VIEW.w * k) / 2;
    oy = H - VIEW.h * k;
  };
  measure();

  /** [ax, ay, scale, fx, fy] in frame pixels: the focus point (fx, fy) moves to (ax, ay). */
  const camVec = (c: SvgCamera): number[] => [ox + c.at[0] * k, oy + c.at[1] * k, c.scale, ox + c.focus[0] * k, oy + c.focus[1] * k];
  const cameraFor = (b: BeatId): SvgCamera => (narrow ? SVG_CAMERAS_NARROW[b] : undefined) ?? SVG_CAMERAS[b];
  // Written function by function, so the browser interpolates the numbers, not a matrix.
  const camFormat = (v: readonly number[]) =>
    `translate(${v[0]!.toFixed(2)}px, ${v[1]!.toFixed(2)}px) scale(${v[2]!.toFixed(4)}) translate(${(-v[3]!).toFixed(2)}px, ${(-v[4]!).toFixed(2)}px)`;

  /** Where a viewBox point lands in the frame under camera v: the same maths as the CSS transform. */
  const project = (v: readonly number[], x: number, y: number): [number, number] => [
    v[0]! + (ox + x * k - v[3]!) * v[2]!,
    v[1]! + (oy + y * k - v[4]!) * v[2]!,
  ];

  // ---------------------------------------------------------------- tracks
  const camera = new Track(one('camera'), 'transform', camFormat, camVec(cameraFor('hero')));
  const scene = new Track(one('scene'), 'opacity', opacity, [1]);
  const sheaths = all('sheath').map((el) => ({ fade: new Track(el, 'opacity', opacity, [0]), move: new Track(el, 'transform', shiftScale, [0, 0, 1.2]) }));
  const tower = { fade: new Track(one('tower'), 'opacity', opacity, [0]), move: new Track(one('tower'), 'transform', shift, [0, 80]) };
  const tip = { move: new Track(one('tip'), 'transform', shift, [0, 0]), fade: new Track(one('tip'), 'opacity', opacity, [1]) };
  const bands = all('band').map((el) => new Track(el, 'opacity', opacity, [1]));
  const hollow = [2, 3].map((n) => ({
    bands: all(`hband-${n}`).map((el) => new Track(el, 'opacity', opacity, [1])),
    rails: new Track(one(`rails-${n}`), 'opacity', opacity, [1]),
    dashed: new Track(one(`hollow-${n}`), 'opacity', opacity, [0]),
  }));
  const rung = {
    move: new Track(one('rung'), 'transform', shiftScale, [RUNG_POSTER_DX, 0, 1]),
    amber: new Track(one('rung-amber'), 'opacity', opacity, [1]),
    whole: new Track(one('rung-whole'), 'opacity', opacity, [1]),
    split: new Track(one('rung-split'), 'opacity', opacity, [0]),
    a: new Track(one('rung-a'), 'transform', shift, [0, 0]),
    b: new Track(one('rung-b'), 'transform', shift, [0, 0]),
    past: new Track(one('rung-past'), 'opacity', opacity, [0]),
  };
  const labels = STAGE_LABELS.map((def) => {
    const el = frame.querySelector<HTMLElement>(`[data-label="${def.id}"]`)!;
    const inner = el.firstElementChild as HTMLElement;
    return { def, el, fade: new Track(el, 'opacity', opacity, [0]), rise: new Track(inner, 'transform', rise, [0]) };
  });
  if (sheaths.length !== 3 || bands.length !== CASCADE_BANDS || hollow.some((h) => h.bands.length !== HOLLOW_BANDS)) throw new Error('stage markup out of step');

  // ---------------------------------------------------------------- labels follow the camera
  let beat: BeatId = 'hero';
  let played = false;
  let raf = 0;
  const placeLabels = () => {
    const v = camera.current();
    for (const l of labels) {
      const [x, y] = labelAnchor(l.def, beat);
      // Whole pixels keep the mono text crisp.
      const [sx, sy] = project(v, x, y).map(Math.round) as [number, number];
      l.el.style.transform = l.def.vertical
        ? `translate(${sx}px, ${sy}px) rotate(-90deg) translateY(-100%)`
        : `translate(${sx}px, ${sy}px) translate(${l.def.align[0] * 100}%, ${l.def.align[1] * 100}%)`;
    }
  };
  const follow = () => {
    cancelAnimationFrame(raf);
    const step = () => {
      placeLabels();
      raf = camera.running ? requestAnimationFrame(step) : 0;
    };
    raf = requestAnimationFrame(step);
  };

  // ---------------------------------------------------------------- poses
  const poseOf = (b: BeatId): Pose => ({
    beat: b,
    poster: b === 'hero' || b === 'gap',
    released: (played && (b === 'release' || b === 'refusals')) || b === 'cancel',
    cancel: b === 'cancel',
  });

  const labelShown = (id: number, p: Pose) => {
    const d = labels[id]!.def;
    return d.beats.includes(p.beat) || (played && !!d.afterRelease?.includes(p.beat));
  };

  const apply = (b: BeatId, instant: boolean) => {
    const prev = beat;
    beat = b;
    const p = poseOf(b);
    const s = BEATS[b];
    const state = { dur: BEAT_TWEEN.state, instant };
    const quick = { dur: 360, ease: EASE_TOGGLE, instant };

    camera.to(camVec(cameraFor(b)), { dur: BEAT_TWEEN.camera, instant });
    scene.to([Math.max(0, 1 - s.dim * 1.6)], state);

    const closing = s.sheaths > BEATS[prev].sheaths;
    sheaths.forEach((sh, i) => {
      const lift = p.released && !p.cancel && i === 0;
      const opts = closing ? { dur: 800, delay: i * 80, instant } : state;
      sh.fade.to([lift ? 0 : s.sheaths], opts);
      sh.move.to([0, lift ? SHEATH_LIFT : 0, 1.2 - 0.2 * s.sheaths], opts);
    });
    tower.fade.to([s.tower], state);
    tower.move.to([0, (1 - s.tower) * 80], state);

    tip.move.to([0, p.poster || (p.released && !p.cancel) ? -RELEASED * PITCH : 0], state);
    tip.fade.to([p.cancel ? 0 : 1], state);

    rung.move.to(p.released ? [RUNG_OUT_DX, 0, RUNG_OUT_SCALE] : p.poster ? [RUNG_POSTER_DX, 0, 1] : [0, 0, 1], state);
    rung.amber.to([p.cancel ? 0 : p.released || p.poster ? 1 : WAITING], state);
    rung.past.to([p.cancel ? 1 : 0], state);
    const split = p.released && !p.cancel ? 1 : 0;
    rung.whole.to([1 - split], quick);
    rung.split.to([split], quick);
    rung.a.to([0, -SPLIT * split], quick);
    rung.b.to([0, SPLIT * split], quick);

    bands.forEach((t) => t.to([p.released ? VOID : 1], state));
    hollow.forEach((h, j) => {
      h.bands.forEach((t, i) =>
        t.to([p.cancel ? HOLLOW : 1], p.cancel ? { dur: BEAT_TWEEN.state, delay: (i + j * 2) * 60, ease: EASE_REVEAL, instant } : quick),
      );
      h.rails.to([p.cancel ? 0.22 : 1], state);
      h.dashed.to([p.cancel ? 1 : 0], state);
    });

    labels.forEach((l, i) => {
      const show = labelShown(i, p);
      l.fade.to([show ? 1 : 0], show ? { dur: 600, delay: 200, instant } : { dur: 240, ease: EASE_TOGGLE, instant });
      if (show) l.rise.to([0], { dur: 600, delay: 200, instant });
    });

    placeLabels();
    if (camera.running) follow();
  };

  /** The page's one orchestrated moment: stage/timeline.ts RELEASE, 1.4 s, never scrubbed. */
  const moment = () => {
    const at = (id: Parameters<typeof releaseStep>[0]) => releaseStep(id);
    const ease = (s: ReturnType<typeof at>) => (s.ease === 'toggle' ? EASE_TOGGLE : EASE_REVEAL);
    const step = (id: Parameters<typeof releaseStep>[0]) => {
      const s = at(id);
      return { dur: s.dur, delay: s.at, ease: ease(s) };
    };
    const reveal = (id: string, when: Parameters<typeof releaseStep>[0]) => {
      const l = labels.find((x) => x.def.id === id)!;
      l.rise.to([105], { dur: 0, instant: true });
      l.fade.to([1], { dur: 120, delay: at(when).at, ease: EASE_TOGGLE });
      l.rise.to([0], step(when));
    };

    reveal('round', 'label');
    sheaths[0]!.fade.to([0], step('sheath'));
    sheaths[0]!.move.to([0, SHEATH_LIFT, 1], step('sheath'));
    tip.move.to([0, -RELEASED * PITCH], step('tip'));
    reveal('tip', 'tip');
    rung.amber.to([1], step('brighten'));
    rung.move.to([RUNG_OUT_DX, 0, RUNG_OUT_SCALE], step('slide'));
    reveal('rung', 'slide');
    const split = step('split');
    rung.whole.to([0], split);
    rung.split.to([1], split);
    rung.a.to([0, -SPLIT], split);
    rung.b.to([0, SPLIT], split);
    reveal('actions', 'split');
    const cascade = at('cascade');
    bands.forEach((t, i) => t.to([VOID], { dur: cascade.dur, delay: cascade.at + i * (cascade.stagger ?? 0), ease: ease(cascade) }));
  };

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (measure(), apply(beat, true))) : null;
  ro?.observe(frame);
  apply('hero', true);

  return {
    setBeat(b, opts) {
      if (b === beat && !opts?.instant) return;
      apply(b, !!opts?.instant || !motionOk());
    },
    playRelease(opts) {
      const first = !played;
      played = true;
      const here = beat === 'release' || beat === 'refusals';
      if (first && here && !opts?.instant && motionOk()) moment();
      else apply(beat, !!opts?.instant || !motionOk());
    },
    setTheme() {
      // Colours are CSS custom properties on the SVG's classes: nothing to re-read.
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const t of [camera, scene, tower.fade, tower.move, tip.move, tip.fade, ...bands, ...Object.values(rung)]) t.cancel();
      for (const s of sheaths) s.fade.cancel(), s.move.cancel();
      for (const h of hollow) h.bands.forEach((t) => t.cancel()), h.rails.cancel(), h.dashed.cancel();
      for (const l of labels) l.fade.cancel(), l.rise.cancel();
    },
  };
}
