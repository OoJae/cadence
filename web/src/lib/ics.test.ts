import { describe, expect, it } from 'vitest';
import type { Installment, Subscription } from '../api/types';
import { roundTime } from './drand';
import { escapeText, foldLine, icsUtc, randomUid, remindersIcs, unpaidInstallments } from './ics';

const plan = { name: 'Pro plan', amount_zat: 25_000_000, count: 3, network: 'main' as const };
// 2026-10-28T12:00:00Z and the rounds of three installments a day apart.
const NOW = 1_793_188_800;
const round = (k: number) => 33_000_000 + k * 28_800;
let n = 0;
const uid = () => `uid-${++n}`;

/** The unfolded content lines, as a reader sees them. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

describe('calendar reminders (RFC 5545)', () => {
  it('writes one event per installment, at its release time in UTC, with an alarm an hour before', () => {
    const ics = remindersIcs(plan, [{ k: 3, release_round: round(3) }, { k: 2, release_round: round(2) }], NOW, uid);
    const lines = unfold(ics);
    expect(lines.slice(0, 5)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cadence//Payment reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(lines.filter((l) => l === 'TRIGGER:-PT1H')).toHaveLength(2);
    expect(lines.filter((l) => l === 'ACTION:DISPLAY')).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('DTSTART:'))).toEqual([`DTSTART:${icsUtc(roundTime(round(2)))}`, `DTSTART:${icsUtc(roundTime(round(3)))}`]);
    expect(lines).toContain(`DTSTAMP:${icsUtc(NOW)}`);
    expect(lines).toContain('SUMMARY:Pro plan: 0.25 ZEC\\, payment 2 of 3');
    expect(lines).toContain('SUMMARY:Pro plan: 0.25 ZEC\\, payment 3 of 3');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(lines.at(-1)).toBe('');
  });

  it('uses CRLF throughout and folds every line at 75 octets', () => {
    const name = 'Ünïcødé plan with a long name, to fold: ☕☕☕☕☕☕☕☕☕☕☕☕☕';
    const ics = remindersIcs({ ...plan, name }, [{ k: 1, release_round: round(1) }], NOW, uid);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const enc = new TextEncoder();
    for (const line of ics.split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    // Folding is undone by the reader, without splitting a character.
    expect(unfold(ics).some((l) => l.startsWith(`SUMMARY:${escapeText(name)}`))).toBe(true);
    const folded = foldLine('X'.repeat(74) + '☕☕');
    expect(folded.split('\r\n ').map((p) => enc.encode(p).length)).toEqual([74, 6]);
    expect(foldLine('short')).toBe('short');
  });

  it('escapes TEXT and drops control characters', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
    expect(escapeText('tab\there\u0007')).toBe('tabhere');
  });

  it('says nothing that would find the subscription: no ids, addresses or URLs, and a random UID per event', () => {
    const name = 'Plan';
    const ics = remindersIcs({ ...plan, name }, [{ k: 1, release_round: round(1) }, { k: 2, release_round: round(2) }], NOW);
    expect(ics).not.toMatch(/sub_|pkt_|off_|u1|utest1|https?:|\.onion|runner/i);
    const uids = unfold(ics).filter((l) => l.startsWith('UID:'));
    expect(uids).toHaveLength(2);
    expect(new Set(uids).size).toBe(2);
    for (const u of uids) expect(u).toMatch(/^UID:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(randomUid()).not.toBe(randomUid());
  });

  it('formats UTC date-times', () => {
    expect(icsUtc(NOW)).toBe('20261028T120000Z');
    expect(icsUtc(NOW + 0.9)).toBe('20261028T120000Z');
  });

  it("reminds of what the runner reports still to pay, and of nothing once the plan has ended", () => {
    const inst = (k: number, state: Installment['state']): Installment => ({ k, amount_zat: 1, release_round: round(k), release_at: roundTime(round(k)), state });
    const sub = (status: Subscription['status']): Subscription => ({
      subscription_id: 'sub_t',
      offer_id: 'off_t',
      status,
      created_at: NOW,
      funding: { txid: 'aa'.repeat(32), mined_height: 1, amount_zat: 3 },
      installments: [inst(1, 'mined'), inst(2, 'broadcast'), inst(3, 'sealed')],
    });
    expect(unpaidInstallments(sub('active'))).toEqual([{ k: 2, release_round: round(2) }, { k: 3, release_round: round(3) }]);
    for (const s of ['completed', 'cancelled', 'stopped', 'stalled'] as const) expect(unpaidInstallments(sub(s))).toEqual([]);
  });
});
