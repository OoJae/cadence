/**
 * The WebGL tier's gate. The stage always starts as SVG; on a desktop with motion allowed
 * and a GPU that doesn't need a software fallback, the WebGL stage is fetched while the
 * page is idle and adopted once it has drawn. Anything short of that keeps the SVG,
 * silently: phones, reduced motion, headless browsers (software GL fails the probe) and
 * every page but the landing never fetch the three.js chunk.
 */
import { motionOk } from '../motion/tokens';
import type { StageSeat } from './StageHost';

/** The one switch for the WebGL tier: false leaves the SVG stage everywhere. */
export const GL_TIER = true;

/** A WebGL2 context made by the probe, handed to three.js so it never makes its own. */
export interface GlContext {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  antialias: boolean;
}

/** A context worth drawing the stage with, or null. Never throws, never logs. */
export function probeGl(): GlContext | null {
  if (!motionOk() || typeof matchMedia !== 'function' || !matchMedia('(min-width: 768px) and (pointer: fine)').matches) return null;
  try {
    const canvas = document.createElement('canvas');
    // Above 1.5x the pixels are small enough that the shaders' own antialiasing covers it.
    const antialias = devicePixelRatio < 1.5;
    const gl = canvas.getContext('webgl2', {
      failIfMajorPerformanceCaveat: true,
      antialias,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'low-power',
    });
    return gl ? { canvas, gl, antialias } : null;
  } catch {
    return null;
  }
}

/** Gives a probed context back to the browser when it won't be used. */
export function releaseGl(ctx: GlContext): void {
  try {
    ctx.gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // Nothing to give back.
  }
}

/**
 * Starts the WebGL tier for a seated stage, when the page is next idle. Returns a function
 * that stops it from arriving (the stage host disposes it once adopted).
 */
export function loadGlTier(seat: StageSeat): () => void {
  if (!GL_TIER) return () => {};
  let live = true;
  const start = async () => {
    if (!live) return;
    const ctx = probeGl();
    if (!ctx) return;
    try {
      const { createGlStage } = await import('./GlStage');
      if (!live) return releaseGl(ctx);
      const gl = await createGlStage(seat.frame, ctx, { fail: () => seat.restore() });
      if (live) seat.adopt(gl);
      else gl.dispose();
    } catch {
      // The SVG stage simply stays.
      releaseGl(ctx);
    }
  };
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(start, { timeout: 4000 });
    return () => {
      live = false;
      cancelIdleCallback(id);
    };
  }
  const id = setTimeout(start, 1200);
  return () => {
    live = false;
    clearTimeout(id);
  };
}
