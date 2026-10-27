/**
 * Watches the WebGL stage's frame times while it animates and steps it down when the
 * machine can't keep up: first to a pixel ratio of 1, then camera moves become quick
 * cuts, then the stage hands back to the SVG tier. Idle frames aren't counted (there are
 * none), and neither is the first frame after a pause, whose gap is the pause itself. A
 * run of slow frames carries across tweens, since short tweens alone may never reach it;
 * only a frame on time breaks it.
 */

/** A frame slower than this misses about 40 fps. */
export const SLOW_FRAME_MS = 24;
/** This many slow frames in a row, during a tween, trip the guard. */
export const SLOW_RUN = 20;

export type GuardLevel = 'dpr' | 'cuts' | 'fallback';
const LEVELS: readonly GuardLevel[] = ['dpr', 'cuts', 'fallback'];

export class FrameGuard {
  private last = 0;
  private slow = 0;
  private level = 0;

  constructor(private readonly onStep: (level: GuardLevel) => void) {}

  /**
   * One rendered frame at rAF time `now`. `continued` says the previous frame was part of
   * the same run of frames; `tweening` that something was animating.
   */
  frame(now: number, continued: boolean, tweening: boolean): void {
    const dt = now - this.last;
    this.last = now;
    if (!continued || !tweening) return;
    this.slow = dt > SLOW_FRAME_MS ? this.slow + 1 : 0;
    if (this.slow < SLOW_RUN || this.level >= LEVELS.length) return;
    this.slow = 0;
    this.onStep(LEVELS[this.level++]!);
  }
}
