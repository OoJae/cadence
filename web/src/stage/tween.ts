/**
 * One animated property of one element, as numbers. A new target starts from wherever the
 * running animation has got to, so fast scrolling retargets and never queues. Only
 * transform and opacity, through the Web Animations API; the resting value is written to
 * the element's style (CSSOM, which the CSP allows) so nothing depends on fill modes.
 */
import { EASE_REVEAL } from '../motion/tokens';

type Prop = 'transform' | 'opacity';
type Values = readonly number[];

export interface TweenOptions {
  dur: number;
  delay?: number;
  ease?: string;
  instant?: boolean;
}

export class Track {
  private anim: Animation | null = null;
  private from: number[];
  private target: number[];

  constructor(
    private readonly el: Element & ElementCSSInlineStyle,
    private readonly prop: Prop,
    private readonly format: (v: Values) => string,
    initial: Values,
  ) {
    this.from = [...initial];
    this.target = [...initial];
    el.style[prop] = format(initial);
  }

  /** The value on screen now, mid-animation included. */
  current(): number[] {
    const a = this.anim;
    if (!a || (a.playState !== 'running' && a.playState !== 'paused')) return this.target;
    // The iteration progress is the eased one, so this is exactly what is drawn.
    const p = a.effect?.getComputedTiming().progress ?? 0;
    return this.from.map((f, i) => f + (this.target[i]! - f) * p);
  }

  get running(): boolean {
    return !!this.anim && this.anim.playState === 'running';
  }

  /** Resolves when the current animation ends or is replaced. */
  get finished(): Promise<unknown> {
    return this.anim ? this.anim.finished.catch(() => undefined) : Promise.resolve();
  }

  to(target: Values, { dur, delay = 0, ease = EASE_REVEAL, instant = false }: TweenOptions): void {
    const from = this.current();
    this.anim?.cancel();
    this.anim = null;
    this.target = [...target];
    this.el.style[this.prop] = this.format(target);
    if (instant || dur <= 0 || from.every((v, i) => Math.abs(v - target[i]!) < 1e-4)) {
      this.from = this.target;
      return;
    }
    this.from = from;
    const a = this.el.animate([{ [this.prop]: this.format(from) }, { [this.prop]: this.format(target) }], { duration: dur, delay, easing: ease, fill: 'backwards' });
    this.anim = a;
    a.onfinish = () => {
      if (this.anim === a) this.anim = null;
    };
  }

  cancel(): void {
    this.anim?.cancel();
    this.anim = null;
    this.from = this.target;
  }
}

export const opacity = (v: Values): string => `${+v[0]!.toFixed(4)}`;
export const shift = (v: Values): string => `translate(${+v[0]!.toFixed(3)}px, ${+v[1]!.toFixed(3)}px)`;
export const shiftScale = (v: Values): string => `translate(${+v[0]!.toFixed(3)}px, ${+v[1]!.toFixed(3)}px) scale(${+v[2]!.toFixed(4)})`;
/** For masked labels: the inner line's offset as a percentage of its own height. */
export const rise = (v: Values): string => `translateY(${+v[0]!.toFixed(2)}%)`;
