/**
 * Payment reminders as an iCalendar file (RFC 5545): one event per installment still to
 * pay, at its release time in UTC, each with an alarm an hour before. The payer imports
 * it into a calendar of their own, which may sync it to a cloud service, so it holds only
 * what they would write on a paper calendar: the plan's name, the amount and "payment k
 * of n". No subscription id, pocket id, address or runner URL, any of which would let
 * whoever reads the calendar look the subscription up; every UID is random for the same
 * reason.
 */
import type { Subscription } from '../api/types';
import { roundTime } from './drand';
import { formatZec, type NetworkId } from './zat';

export interface ReminderPlan {
  /** The plan's name, as the offer names it. */
  name: string;
  amount_zat: number;
  count: number;
  network: NetworkId;
}

/** An installment still to pay: its number and the drand round it releases at. */
export interface ReminderInstallment {
  k: number;
  release_round: number;
}

/** What the runner reports still to pay: none once the plan has ended, else every installment not yet mined. */
export function unpaidInstallments(sub: Pick<Subscription, 'status' | 'installments'>): ReminderInstallment[] {
  if (sub.status !== 'active') return [];
  return sub.installments.filter((i) => i.state === 'sealed' || i.state === 'due' || i.state === 'broadcast').map(({ k, release_round }) => ({ k, release_round }));
}

export const ICS_TYPE = 'text/calendar';
export const ICS_FILE_NAME = 'cadence-payment-reminders.ics';

const CRLF = '\r\n';
/** RFC 5545 §3.1: a content line is at most 75 octets, excluding the line break. */
const MAX_OCTETS = 75;
/** How long each event lasts in a calendar: a payment is a moment, but a zero-length event shows poorly. */
const EVENT_SECS = 15 * 60;

/** RFC 5545 §3.3.11 TEXT: backslash, semicolon, comma and line breaks escaped; other control characters dropped. */
export function escapeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n');
}

const utf8 = new TextEncoder();

/** Folds a content line at 75 octets (§3.1): CRLF and one space, never inside a UTF-8 character. */
export function foldLine(line: string): string {
  let out = '';
  let width = 0;
  for (const ch of line) {
    const octets = utf8.encode(ch).length;
    if (width + octets > MAX_OCTETS) {
      out += `${CRLF} `;
      width = 1;
    }
    out += ch;
    width += octets;
  }
  return out;
}

/** A UTC DATE-TIME (§3.3.5, form 2): 20261028T143000Z. */
export function icsUtc(unixSecs: number): string {
  return new Date(Math.floor(unixSecs) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** A random version 4 UUID, as RFC 7986 §5.3 recommends for a UID: it says nothing about the plan. */
export function randomUid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The reminders file for `installments`, made at `now` (unix seconds). */
export function remindersIcs(plan: ReminderPlan, installments: ReminderInstallment[], now: number, uid: () => string = randomUid): string {
  const amount = formatZec(plan.amount_zat, plan.network);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cadence//Payment reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const i of [...installments].sort((a, b) => a.k - b.k)) {
    const at = roundTime(i.release_round);
    const what = `payment ${i.k} of ${plan.count}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid()}`,
      `DTSTAMP:${icsUtc(now)}`,
      `DTSTART:${icsUtc(at)}`,
      `DTEND:${icsUtc(at + EVENT_SECS)}`,
      `SUMMARY:${escapeText(`${plan.name}: ${amount}, ${what}`)}`,
      `DESCRIPTION:${escapeText(
        `${amount} for ${plan.name}, ${what}. It is paid from the pocket you prepaid, with nothing to do: this is when it unlocks, and it is mined a little later. To stop paying, cancel with your cancel key before then.`,
      )}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT1H',
      `DESCRIPTION:${escapeText(`${plan.name}: ${what} in an hour`)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
