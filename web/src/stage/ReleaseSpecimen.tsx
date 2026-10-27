import { useEffect, useRef, useState } from 'react';
import { createSvgDriver } from './driver';
import { SvgStage } from './SvgStage';

/**
 * The stage held at its release beat, with a button that plays the moment again: for /brand.
 * Each replay draws a fresh stage, so the moment runs exactly as on the landing.
 */
export function ReleaseSpecimen({ className }: { className?: string }) {
  const [take, setTake] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const driver = createSvgDriver(frame);
    driver.setBeat('release', { instant: true });
    // The first look shows where the moment ends; a replay plays it.
    driver.playRelease({ instant: take === 0 });
    return () => driver.dispose();
  }, [take]);

  return (
    <figure className={`release-specimen${className ? ` ${className}` : ''}`}>
      <div className="stage-frame" ref={frameRef} aria-hidden="true" key={take}>
        <SvgStage />
      </div>
      <figcaption className="row between">
        <span className="small muted">Installment 1 of testnet run 1 goes out: one rung, split into its two Ironwood actions.</span>
        <button type="button" className="btn sm" onClick={() => setTake((t) => t + 1)}>
          Replay the release
        </button>
      </figcaption>
    </figure>
  );
}
