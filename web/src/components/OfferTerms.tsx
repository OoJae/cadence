import type { Offer } from '../api/types';
import { useNow } from '../hooks';
import { formatMoney, quoteMismatch, quoteNote, quoteText, trialText } from '../lib/terms';
import { formatZec } from '../lib/zat';
import { ClockIcon } from './Icons';
import { Callout } from './ui';

/**
 * An offer's optional terms, as the payer sees them: the free trial before the first payment,
 * and the merchant's fiat label next to the ZEC amount that is actually signed. Renders nothing
 * for an offer without them, so an older runner's offers look exactly as before.
 */
export function OfferTerms({ offer }: { offer: Offer }) {
  const now = useNow();
  const trial = offer.trial_secs ?? 0;
  const quote = offer.quote;
  if (!trial && !quote) return null;
  const off = quote ? quoteMismatch(quote, offer.amount_zat) : null;
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      {trial > 0 && (
        <span className="row small" style={{ ['--gap' as string]: '6px' }}>
          <ClockIcon size={15} /> {trialText(trial)}
        </span>
      )}
      {quote && (
        <div className="stack" style={{ ['--gap' as string]: '4px' }}>
          <span className="small text-2">{quoteText(quote, offer.amount_zat, offer.network, now)}</span>
          <span className="tiny muted">{quoteNote(quote, offer.amount_zat, offer.network)}</span>
        </div>
      )}
      {quote && off !== null && (
        <Callout kind="warn">
          <span className="small">
            At the merchant's own rate, {formatMoney(quote.amount_minor, quote.currency)} comes to {formatZec(off, offer.network)}, not the{' '}
            {formatZec(offer.amount_zat, offer.network)} this plan bills. You would sign {formatZec(offer.amount_zat, offer.network)}: ask the merchant before you subscribe.
          </span>
        </Callout>
      )}
    </div>
  );
}
