import type { CadenceClient } from '../api/client';
import type { Offer } from '../api/types';
import { usePoll } from '../hooks';
import { subscribeAgainPath } from '../lib/again';
import { downloadBytes } from '../lib/download';
import { ICS_FILE_NAME, ICS_TYPE, remindersIcs, type ReminderInstallment, type ReminderPlan } from '../lib/ics';
import { validateOffer } from '../lib/offer';
import { nowSecs } from '../lib/time';
import { Link } from '../router';
import { ClockIcon } from './Icons';

/** The offer `offerId`, as that runner serves it, asked once; undefined until it answers, or if its copy does not check. */
export function useRunnerOffer(client: CadenceClient, offerId: string | undefined): Offer | undefined {
  const poll = usePoll((signal) => (offerId ? client.getOffer(offerId, signal) : Promise.resolve(undefined)), 0, [client, offerId]);
  const parsed = poll.data ? validateOffer(poll.data) : null;
  return parsed?.ok && parsed.offer.offer_id === offerId ? parsed.offer : undefined;
}

/**
 * Saves the installments still to pay as calendar events, with an alarm an hour before
 * each: made in this tab and saved with a download, like the cancel key. Nothing is
 * sent anywhere, and the file names no id or address (src/lib/ics.ts).
 */
export function CalendarReminders({ plan, installments }: { plan: ReminderPlan; installments: ReminderInstallment[] }) {
  if (installments.length === 0) return null;
  const save = () => downloadBytes(new TextEncoder().encode(remindersIcs(plan, installments, nowSecs())), ICS_FILE_NAME, ICS_TYPE);
  return (
    <div className="stack" style={{ ['--gap' as string]: '4px' }}>
      <button type="button" className="link-btn small row" style={{ alignSelf: 'flex-start', ['--gap' as string]: '6px' }} onClick={save}>
        <ClockIcon size={14} /> Add payment reminders to your calendar (.ics)
      </button>
      <span className="tiny muted">
        One event per payment still to come, with an alarm an hour before. It holds the plan's name, the amount and "payment k of n", and no subscription id, pocket or address:
        your calendar may sync it to a cloud service.
      </span>
    </div>
  );
}

/** The same plan's share link on this app, once nothing further pays. */
export function SubscribeAgain({ offer }: { offer: Offer | undefined }) {
  if (!offer) return null;
  return (
    <div className="panel stack" style={{ ['--gap' as string]: '8px' }}>
      <span className="small text-2">
        Want {offer.name} again? Subscribing again is a fresh start: a new pocket, a schedule signed from then, and one payment to fund it.
      </span>
      <Link to={subscribeAgainPath(offer)} className="btn sm" style={{ alignSelf: 'flex-start' }}>
        Subscribe again
      </Link>
    </div>
  );
}
