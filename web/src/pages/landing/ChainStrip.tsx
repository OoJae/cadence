import { ArrowRightIcon } from '../../components/Icons';
import { Lines } from '../../motion/Lines';
import { Link } from '../../router';
import { fmt, MAINNET_LIVE, MAINNET_SAMPLE, S2_TXID } from './data';

const PITCH = 2;
const lines = (from: number, to: number) => {
  let d = '';
  for (let i = from; i < to; i++) d += `M${i * PITCH + 0.5} 0V100`;
  return d;
};

/**
 * On chain, a payment is the commonest shape there is. One hairline per transaction in
 * the mainnet sample, grouped: the same-shape ones, then the rest. A grouped bar, not an
 * order of arrival.
 */
export function ChainStrip() {
  const { sameShape, total, fromHeight, toHeight } = MAINNET_SAMPLE;
  const blocks = toHeight - fromHeight + 1;
  return (
    <section className="chain" aria-labelledby="chain-title">
      <div className="grid-12">
        <div className="chain-head">
          <p className="kicker" data-reveal="rise">
            Mainnet blocks {fmt(fromHeight)} to {fmt(toHeight)}
          </p>
          <Lines as="h2" id="chain-title" className="beat-title" lines={['On chain, it looks', 'like everyone else.']} />
          <p className="beat-text" data-reveal="rise">
            Each payment is an ordinary two-action shielded send with the standard fee. In {fmt(blocks)} mainnet blocks, {fmt(sameShape)} of the {fmt(total)} transactions using the
            Orchard-family pools had exactly that shape, more than any other.
          </p>
        </div>
        <figure className="chain-figure" data-reveal="draw">
          <p className="chain-count">
            {fmt(sameShape)}
            <span className="chain-of"> / {fmt(total)}</span>
          </p>
          <svg className="chain-strip" viewBox={`0 0 ${total * PITCH} 100`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path className="same" d={lines(0, sameShape)} />
            <path className="rest" d={lines(sameShape, total)} />
          </svg>
          <figcaption className="chain-legend">
            <span>{fmt(sameShape)} shaped like a Cadence payment</span>
            <span>{fmt(total)} in all</span>
          </figcaption>
        </figure>
        <div className="chain-foot">
          <p className="beat-text" data-reveal="rise">
            Timing is public, and a regular rhythm can link payments. The small print below says so.
          </p>
          {MAINNET_LIVE && (
            <p className="beat-text" data-reveal="rise">
              Also running on mainnet: one real standing order, released by a runner we've stopped changing.
            </p>
          )}
          <p data-reveal="rise">
            <Link to={`/decode/${S2_TXID}`} className="btn">
              Decode a real payment <ArrowRightIcon className="arrow" size={16} />
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
