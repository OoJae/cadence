import { describe, expect, it } from 'vitest';
import { FrameGuard, SLOW_FRAME_MS, SLOW_RUN, type GuardLevel } from './frameGuard';

/** Feeds `n` frames `dt` ms apart, all in one run of a tween. */
function run(guard: FrameGuard, n: number, dt: number, from = 0): number {
  let t = from;
  guard.frame(t, false, true);
  for (let i = 0; i < n; i++) guard.frame((t += dt), true, true);
  return t;
}

describe('frame guard', () => {
  it('steps down once per run of slow frames: pixel ratio, cuts, then the SVG', () => {
    const steps: GuardLevel[] = [];
    const guard = new FrameGuard((l) => steps.push(l));
    let t = run(guard, SLOW_RUN, SLOW_FRAME_MS + 6);
    expect(steps).toEqual(['dpr']);
    t = run(guard, SLOW_RUN, SLOW_FRAME_MS + 6, t + 1000);
    t = run(guard, SLOW_RUN, SLOW_FRAME_MS + 6, t + 1000);
    expect(steps).toEqual(['dpr', 'cuts', 'fallback']);
    run(guard, SLOW_RUN * 3, SLOW_FRAME_MS + 6, t + 1000);
    expect(steps).toHaveLength(3);
  });

  it('needs the slow frames in a row', () => {
    const steps: GuardLevel[] = [];
    const guard = new FrameGuard((l) => steps.push(l));
    let t = 0;
    guard.frame(t, false, true);
    for (let i = 0; i < SLOW_RUN * 4; i++) guard.frame((t += i % 10 === 9 ? 16 : SLOW_FRAME_MS + 6), true, true);
    expect(steps).toEqual([]);
  });

  it('carries a slow run across short tweens', () => {
    const steps: GuardLevel[] = [];
    const guard = new FrameGuard((l) => steps.push(l));
    let t = 0;
    for (let k = 0; k < 4; k++) t = run(guard, SLOW_RUN / 4 + 1, SLOW_FRAME_MS + 6, t + 2000);
    expect(steps).toEqual(['dpr']);
  });

  it('ignores the gap after a pause and frames outside a tween', () => {
    const steps: GuardLevel[] = [];
    const guard = new FrameGuard((l) => steps.push(l));
    let t = 0;
    for (let i = 0; i < SLOW_RUN * 2; i++) guard.frame((t += 500), false, true);
    for (let i = 0; i < SLOW_RUN * 2; i++) guard.frame((t += 100), true, false);
    expect(steps).toEqual([]);
  });
});
