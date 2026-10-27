import { useCallback, useEffect, useRef, useState } from 'react';
import { RoundRail } from '../brand/RoundRail';
import { ArrowRightIcon } from '../components/Icons';
import { useDocumentTitle } from '../hooks';
import { aheadFor, rungWindow } from '../lib/window';
import { Lines } from '../motion/Lines';
import { scrollToElement, useSmoothScroll } from '../motion/smoothScroll';
import { motionOk } from '../motion/tokens';
import { revealNow, useReveals } from '../motion/useReveal';
import { Link } from '../router';
import { StageHost } from '../stage/StageHost';
import { releaseStep } from '../stage/timeline';
import { CertificateSpecimen } from './landing/CertificateSpecimen';
import { ChainStrip } from './landing/ChainStrip';
import { CompareTable } from './landing/CompareTable';
import { fmt, RUN1, RUN2, S2_TXID, shortTxid } from './landing/data';
import { Refusals } from './landing/Refusals';
import { SmallPrint } from './landing/SmallPrint';

// Rung counts come from the spec's window formula (lib/window.ts, unit-tested), not from copy.
const DUE_IN_A_MINUTE = rungWindow(aheadFor(60)).rungs;
const DUE_IN_30_DAYS = rungWindow(aheadFor(30 * 86_400)).rungs;
const HEADER = 64;

/**
 * The hero's entrance waits for the display face (or 500 ms, whichever is first) so the
 * headline never rises in a fallback face and then swaps. Reduced motion skips it in CSS.
 */
function useEntrance(): 'pending' | 'run' {
  const [state, setState] = useState<'pending' | 'run'>('pending');
  useEffect(() => {
    if (!motionOk()) {
      setState('run');
      return;
    }
    let live = true;
    const go = () => live && setState('run');
    const timer = setTimeout(go, 500);
    void document.fonts?.load('1em "Bodoni Moda Variable"').then(go, go);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return state;
}

export function Landing() {
  useDocumentTitle('');
  const root = useRef<HTMLDivElement>(null);
  const story = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLElement>(null);
  const lenis = useSmoothScroll();
  const enter = useEntrance();
  useReveals(root);

  const onRelease = useCallback((instant: boolean) => {
    revealNow(root.current?.querySelector<HTMLElement>('[data-reveal-on="moment"]') ?? null, instant ? 0 : releaseStep('caption').at);
  }, []);

  const toStory = () => {
    const el = gap.current;
    if (!el) return;
    scrollToElement(el, lenis.current, HEADER);
    el.focus({ preventScroll: true });
  };

  return (
    <div className="landing" ref={root}>
      <div className="story" ref={story} data-enter={enter}>
        <StageHost story={story} onRelease={onRelease} />

        <section className="beat hero" data-beat="hero" aria-labelledby="hero-title">
          <div className="grid-12 hero-grid">
            <div className="hero-text">
              <RoundRail variant="line" />
              <p className="kicker hero-kicker">Shielded standing orders on Zcash Ironwood</p>
              <Lines as="h1" id="hero-title" className="hero-title" reveal={false} lines={['Subscribe once.', <em key="close">Close the tab.</em>]} />
              <p className="hero-lede">
                Pay once from Zodl with a single QR code. Your browser signs every payment before you go, and each one stays sealed until its day, then goes out exactly as you
                signed it. Cancel any time by spending your own note.
              </p>
              <div className="hero-cta">
                <Link to="/sandbox" className="btn primary lg">
                  Try the judge sandbox <ArrowRightIcon className="arrow" size={16} />
                </Link>
                <Link to={`/decode/${S2_TXID}`} className="btn lg">
                  Decode a real payment
                </Link>
              </div>
            </div>
            <div className="hero-foot">
              <p className="fact-strip">Every payment: v6 · 2 Ironwood actions · 0 transparent · 0 zero-OVK outputs</p>
              <button type="button" className="scroll-cue" onClick={toStory}>
                What happens after you leave
                <ArrowRightIcon className="cue-arrow" size={14} />
              </button>
            </div>
          </div>
        </section>

        <section className="beat gap" data-beat="gap" aria-labelledby="gap-title" ref={gap} tabIndex={-1}>
          <div className="grid-12">
            <div className="beat-body">
              <p className="kicker" data-reveal="rise">
                The gap
              </p>
              <Lines as="h2" id="gap-title" className="beat-title" lines={['A shielded payment', 'needs you there', 'to sign it.']} />
              <div className="beat-text prose" data-reveal="rise">
                <p>
                  Every shielded payment needs the payer's wallet online to sign it. Invoice-per-period tools such as CipherPay make subscriptions workable by sending a fresh invoice
                  each period, which you then pay, each time. Miss one and the subscription lapses.
                </p>
                <p>
                  Paying while you're offline has meant handing your funds to someone else first. Cadence closes that gap without custody: you sign the whole schedule up front, and
                  each payment can only be released when it is due, exactly as signed.
                </p>
              </div>
            </div>
            <CompareTable />
          </div>
        </section>

        <section className="beat sign" data-beat="sign" aria-labelledby="sign-title">
          <div className="grid-12">
            <div className="beat-body">
              <p className="kicker" data-reveal="rise">
                Installment 1 · {fmt(RUN1.rungs[0])} rungs
              </p>
              <Lines as="h2" id="sign-title" className="beat-title" lines={['You sign each', 'payment once for', 'every block it', 'could land in.']} />
              <p className="beat-text" data-reveal="rise">
                A shielded payment commits to its expiry height, and an ordinary expiry depends on the block it goes out in. Nobody knows that block in advance, so your browser
                signs a copy, a rung, for every block it could land in. Every copy pays the same amount to the same address.
              </p>
              <figure className="count" data-reveal="rise">
                <span className="count-n">{fmt(DUE_IN_A_MINUTE)}</span>
                <figcaption>rungs for a payment due a minute after signing</figcaption>
              </figure>
            </div>
            <div className="beat-body tower" data-sub="tower">
              <figure className="count" data-reveal="rise">
                <span className="count-n">{fmt(DUE_IN_30_DAYS)}</span>
                <figcaption>rungs for one due in 30 days, at 25-second blocks</figcaption>
              </figure>
              <p className="footnote" data-reveal="rise">
                Counts from the spec's window formula, checked by a unit test.
              </p>
            </div>
          </div>
        </section>

        <section className="beat seal" data-beat="seal" aria-labelledby="seal-title">
          <div className="grid-12">
            <div className="beat-body">
              <p className="kicker" data-reveal="rise">
                Rounds {RUN1.rounds.map(fmt).join(' · ')}
              </p>
              <Lines as="h2" id="seal-title" className="beat-title" lines={['Then each one is', 'locked to a moment', "that hasn't", 'happened yet.']} />
              <p className="beat-text" data-reveal="rise">
                Each payment is sealed to the merchant's runner and time-locked to a drand round. A new round comes every 3 seconds. Until its round arrives, the key that opens a
                payment doesn't exist, for the runner or for anyone. Sealed, every package is the same {RUN1.packageKiB} KiB.
              </p>
              <Lines as="p" className="closing-line" lines={[<em key="close">Now close the tab.</em>]} />
            </div>
          </div>
        </section>

        <section className="beat hold" data-beat="hold" aria-labelledby="hold-title">
          <div className="grid-12">
            <div className="beat-body">
              <Lines as="h2" id="hold-title" className="hold-line" lines={['Nothing of yours needs', 'to keep running.']} />
              <Lines as="p" className="hold-line still" lines={['The only thing still', 'moving is the clock.']} />
            </div>
          </div>
        </section>

        <section className="beat release" data-beat="release" aria-labelledby="release-title">
          <div className="grid-12">
            <div className="beat-body">
              <p className="kicker" data-reveal="rise">
                Round {fmt(RUN1.rounds[0])} · block {fmt(RUN1.mined[0])}
              </p>
              <Lines as="h2" id="release-title" className="beat-title" data-moment="release" lines={['When its round', 'arrives, exactly', 'one rung goes out.']} />
              <p className="beat-text" data-reveal="rise">
                The runner opens that payment, adds a fresh anchor, proves it and broadcasts only the rung for the next block. It holds a view key, never a spending key, so it
                can't change what you signed. The other {fmt(RUN1.rungs[0] - 1)} rungs spend the same note, which is now spent. None of them can ever be used.
              </p>
              <Lines
                as="p"
                className="release-caption"
                data-reveal-on="moment"
                lines={[shortTxid(RUN1.txid1), `mined at block ${fmt(RUN1.mined[0])}`, '2 Ironwood actions']}
              />
              <p className="beat-text" data-reveal="rise">
                The next two followed a period apart, mined at blocks {fmt(RUN1.mined[1])} and {fmt(RUN1.mined[2])}.
              </p>
            </div>
          </div>
        </section>

        <section className="beat refuse" data-beat="refusals" aria-labelledby="refusals-title">
          <div className="grid-12">
            <div className="beat-body">
              <p className="kicker" data-reveal="rise">
                Try to cheat
              </p>
              <Lines as="h2" id="refusals-title" className="beat-title" lines={['Four ways to cheat.', 'Four different', 'refusals.']} />
              <p className="beat-text" data-reveal="rise">
                Nothing here relies on the runner behaving. Pick one to see which layer stops it.
              </p>
              <div data-reveal="rise">
                <Refusals />
              </div>
              <p className="beat-text" data-reveal="rise">
                In the sandbox these aren't animations: the runner really attempts each one and shows you the error that stopped it.
              </p>
              <p data-reveal="rise">
                <Link to="/sandbox" className="btn">
                  Try all four in the sandbox <ArrowRightIcon className="arrow" size={16} />
                </Link>
              </p>
            </div>
          </div>
        </section>

        <section className="beat cancel" data-beat="cancel" aria-labelledby="cancel-title">
          <div className="grid-12">
            <div className="beat-body">
              <p className="kicker" data-reveal="rise">
                Testnet run 2 · cancelled at block {fmt(RUN2.cancelHeight)}
              </p>
              <Lines as="h2" id="cancel-title" className="beat-title" lines={['Cancel without', 'asking anyone.']} />
              <p className="beat-text" data-reveal="rise">
                Open your cancel key and spend your pocket's note back to your own address. Every payment still waiting then spends a note that no longer exists, so no node will
                accept it. You get a certificate anyone can check on chain.
              </p>
              <CertificateSpecimen />
            </div>
          </div>
        </section>
      </div>

      <ChainStrip />
      <SmallPrint />

      <section className="close" aria-labelledby="close-title">
        <div className="grid-12">
          <div className="close-body">
            <Lines as="h2" id="close-title" className="beat-title" lines={['Watch three payments land,', 'then try to cheat.']} />
            <p className="beat-text" data-reveal="rise">
              The sandbox creates a mandate, funds it from a faucet, signs it in your browser, closes the payer's tab and lets you try all four cheats.
            </p>
            <div className="close-cta" data-reveal="rise">
              <Link to="/sandbox" className="btn primary lg">
                Open the sandbox <ArrowRightIcon className="arrow" size={16} />
              </Link>
              <Link to="/merchant" className="btn lg">
                Merchant dashboard
              </Link>
            </div>
            <p data-reveal="rise">
              <Link to="/manage" className="close-manage">
                Already subscribed? Cancel with your key
              </Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
