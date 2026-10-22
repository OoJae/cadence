import { EyeIcon, EyeOffIcon } from './Icons';

/**
 * Exactly what the merchant (and its runner) learns from a Cadence subscription, and
 * what it does not. Kept deliberately narrow: every line here is a claim we can defend.
 */
export function MerchantLearns({ compact }: { compact?: boolean }) {
  return (
    <section className={compact ? 'learn' : 'card learn'} aria-labelledby="learn-title">
      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <span className="kicker">Disclosure</span>
        <h2 id="learn-title" className="h3">
          What the merchant learns
        </h2>
      </div>

      <div>
        <div className="group-label">Learns</div>
        <ul>
          <li className="yes">
            <EyeIcon size={15} />
            <span>
              <strong>The prepaid balance</strong> of this one pocket: the funding amount, which is every installment plus its fee.
            </span>
          </li>
          <li className="yes">
            <EyeIcon size={15} />
            <span>
              <strong>The schedule</strong>: amount, period, count and each release round, and when each installment lands.
            </span>
          </li>
          <li className="yes">
            <EyeIcon size={15} />
            <span>
              <strong>That you cancelled</strong>, and roughly when: the pocket note is spent by a transaction its runner did not send.
            </span>
          </li>
        </ul>
      </div>

      <div>
        <div className="group-label">Does not learn</div>
        <ul>
          <li className="no">
            <EyeOffIcon size={15} />
            <span>
              <strong>Your main wallet</strong>: its addresses, balance or history. Shielded notes carry no sender, and the pocket has a fresh seed of its own.
            </span>
          </li>
          <li className="no">
            <EyeOffIcon size={15} />
            <span>
              <strong>Your other subscriptions.</strong> Each one gets its own single-use pocket, so they cannot be linked through keys.
            </span>
          </li>
          <li className="no">
            <EyeOffIcon size={15} />
            <span>
              <strong>Where cancelled funds went.</strong> The refund goes to an address of yours with no outgoing-viewing record (OvkPolicy::Discard), so even the pocket key the runner holds cannot decrypt it.
            </span>
          </li>
          <li className="no">
            <EyeOffIcon size={15} />
            <span>
              <strong>Your IP address</strong>, in the Tor builds (CLI and desktop). This web page connects to the runner directly unless you open it in Tor Browser.
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}
