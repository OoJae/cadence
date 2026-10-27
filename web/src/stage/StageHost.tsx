import { useEffect, useRef, type RefObject } from 'react';
import { RoundRail } from '../brand/RoundRail';
import { observeBeats } from '../motion/useBeats';
import { motionOk } from '../motion/tokens';
import { createSvgDriver } from './driver';
import { loadGlTier } from './probe';
import { SvgStage } from './SvgStage';
import { BEAT_ORDER, type BeatId, type StageDriver } from './timeline';

/**
 * The seam between the story and whichever tier draws it. The SVG tier is seated first and
 * stays as the fallback; another tier (WebGL) is adopted once it has drawn its first frame,
 * brought to the current beat without a replay, and handed back with restore() if it fails.
 */
export interface StageSeat {
  frame: HTMLElement;
  adopt(next: StageDriver): void;
  restore(): void;
}

const past = (b: BeatId, than: BeatId) => BEAT_ORDER.indexOf(b) > BEAT_ORDER.indexOf(than);

/**
 * The landing's sticky stage. It owns the observers (beats, the release moment, the
 * story's visibility, the theme) and calls the seated driver; drivers never observe.
 */
export function StageHost({ story, onRelease, onSeat }: { story: RefObject<HTMLElement | null>; onRelease?: (instant: boolean) => void; onSeat?: (seat: StageSeat) => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onRelease, onSeat });
  useEffect(() => {
    callbacks.current = { onRelease, onSeat };
  });

  useEffect(() => {
    const frame = frameRef.current;
    const root = story.current;
    if (!frame || !root || typeof IntersectionObserver !== 'function') return;
    let svg: StageDriver;
    try {
      svg = createSvgDriver(frame);
    } catch {
      // The drawing still stands as a still poster; the story reads without it.
      return;
    }
    let active: StageDriver = svg;
    let beat: BeatId = 'hero';
    let played = false;
    // Offscreen, nothing animates: state changes land instantly and schedule no frames.
    let visible = true;
    const instant = () => !visible || !motionOk();
    const narrow = () => getComputedStyle(frame).getPropertyValue('--stage-layout').trim() === 'narrow';
    const titleAbove = () => {
      const title = root.querySelector('[data-moment="release"]');
      return !!title && title.getBoundingClientRect().bottom <= innerHeight / 2;
    };

    const release = (now: boolean) => {
      if (played) return;
      played = true;
      active.playRelease({ instant: now });
      callbacks.current.onRelease?.(now);
    };

    const stop = observeBeats(root, {
      beat(b) {
        beat = b;
        active.setBeat(b, { instant: instant() });
        if (played) return;
        // Scrolled past the moment without it crossing the line: show where it ended.
        if (past(b, 'release')) release(true);
        // On phones the passage's plate rises over the stage's middle, so the moment plays as
        // the passage arrives, while the plate is still low. Anywhere, if the title is already
        // past the line (a jump, find in page, a dragged scrollbar), it plays now.
        else if (b === 'release' && (narrow() || titleAbove())) release(instant());
      },
      moment(name, passed) {
        if (name === 'release') release(passed || instant());
      },
    });

    const seen = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    seen.observe(root);
    const theme = new MutationObserver(() => active.setTheme());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const bring = (d: StageDriver) => {
      // A tier that read its colours before a theme switch (the GL one compiles first) catches up.
      d.setTheme();
      d.setBeat(beat, { instant: true });
      if (played) d.playRelease({ instant: true });
    };
    const seat: StageSeat = {
      frame,
      adopt(next) {
        bring(next);
        if (active !== svg) active.dispose();
        active = next;
      },
      restore() {
        if (active === svg) return;
        bring(svg);
        active.dispose();
        active = svg;
      },
    };
    callbacks.current.onSeat?.(seat);
    // The tier switch: desktops with a real GPU get the WebGL stage once the page is idle.
    const stopGl = loadGlTier(seat);

    return () => {
      stopGl();
      stop();
      seen.disconnect();
      theme.disconnect();
      if (active !== svg) active.dispose();
      svg.dispose();
    };
  }, [story]);

  // The track spans the story; the layer sticks inside it and leaves with the story's end.
  return (
    <div className="stage-track">
      <div className="stage-layer">
        <div className="stage-frame" ref={frameRef} aria-hidden="true">
          <SvgStage />
        </div>
        <RoundRail variant="rail" />
      </div>
    </div>
  );
}
