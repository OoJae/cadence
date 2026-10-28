import { CheckIcon, XIcon } from '../../components/Icons';
import { MerchantLearns } from '../../components/MerchantLearns';
import { Lines } from '../../motion/Lines';

const CAN = [
  'Broadcast each installment you signed, once its round has passed.',
  "See this one pocket's balance and its schedule.",
  'Stop early: discard the packages and shred the pocket data.',
];

const CANNOT = [
  'Change an amount or recipient. Your signature covers both.',
  "Open an installment early. Its key is a drand signature that doesn't exist yet.",
  'Spend the pocket any other way. It has no spending key.',
  'Send a paid installment again, or replay one after you cancel. Its note is already spent, so it is a double-spend.',
];

const LIMITS = [
  ['Release time rests on drand.', 'Opening a package early would take a threshold of the League of Entropy’s nodes colluding. That is a strong assumption, not a trustless one.'],
  ['The runner must be online.', 'If it misses an installment’s signed height window, the installment is marked missed, the merchant is notified, and nothing more pays. You can then cancel (or sweep the pocket) and subscribe again.'],
  ['The runner holds this pocket’s full viewing key.', 'Proving needs it. It is scoped to one single-use pocket with no transparent or Sapling part, and deleted at the end.'],
  ['Unscheduled upgrades need a new signature.', 'Each signature commits to the consensus branch. Known upgrades are handled: NU7 is, because each rung is signed for the branch at its own height, and fees follow ZIP 2009 at its switch height. A schedule that runs past an upgrade unknown at signing must be signed again, which is not automatic yet.'],
  ['This web page talks to the runner directly.', 'The runner and its hosting provider see your IP address. Use Tor Browser, or the CLI, which uses Tor, if that matters.'],
  ['Whoever serves this page serves the code that holds your pocket key.', 'The runner software cannot spend your pocket, but a merchant who serves this page could serve other code. A build served from an origin the merchant does not control, with its commit and bundle hash in the footer to check against your own build, or the CLI, avoids that.'],
  ['Timing is public.', 'Installments land on a schedule, like any recurring payment. Your signer moves each one up to a quarter period later at random, at most 6 hours, so they do not fall at exact intervals. Their fields do not link them to each other, but their rough rhythm still can.'],
] as const;

/** What the runner can and cannot do, and the honest limits: set as fine print, in full. */
export function SmallPrint() {
  return (
    <section className="small-print" aria-labelledby="small-print-title">
      <div className="grid-12">
        <div className="sp-head">
          <p className="kicker" data-reveal="rise">
            The small print
          </p>
          <Lines as="h2" id="small-print-title" className="beat-title" lines={['The runner releases.', 'It cannot decide.']} />
          <p className="beat-text" data-reveal="rise">
            It holds sealed packages and a view-only key for one pocket. That is enough to prove and broadcast what you signed, and not enough to do anything else.
          </p>
        </div>

        <div className="sp-lists">
          <div className="sp-pair">
            <div className="sp-block" data-reveal="rise">
              <h3 className="sp-title">The runner can</h3>
              <ul className="sp-list">
                {CAN.map((t) => (
                  <li key={t}>
                    <CheckIcon size={14} />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="sp-block" data-reveal="rise">
              <h3 className="sp-title">The runner cannot</h3>
              <ul className="sp-list">
                {CANNOT.map((t) => (
                  <li key={t}>
                    <XIcon size={14} />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="sp-block" data-reveal="rise">
            <h3 className="sp-title">Honest limits</h3>
            <ul className="sp-list sp-limits">
              {LIMITS.map(([a, b]) => (
                <li key={a}>
                  <span className="note-tag">Note</span>
                  <span>
                    <strong>{a}</strong> {b}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="sp-aside">
          <div className="sp-sticky" data-reveal="rise">
            <MerchantLearns />
          </div>
        </div>
      </div>
    </section>
  );
}
