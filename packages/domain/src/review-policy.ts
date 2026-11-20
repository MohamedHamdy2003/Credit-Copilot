import { validDate, daysBetween } from './calculations.js';
import { invariant } from './errors.js';
import type { Actor } from './access.js';
export const REASON_REQUEST_DAYS = 30; // PM-9; an inclusive calendar-day implementation.
export function reasonWindow(decided: string, today: string) {
  validDate(decided);
  validDate(today);
  const deadline = new Date(`${decided}T00:00:00Z`);
  deadline.setUTCDate(deadline.getUTCDate() + REASON_REQUEST_DAYS);
  return {
    deadline: deadline.toISOString().slice(0, 10),
    eligible:
      daysBetween(decided, today) >= 0 && daysBetween(decided, today) <= REASON_REQUEST_DAYS,
  };
}
export function requireSenior(actor: Actor) {
  invariant(
    actor.role === 'credit_officer' && ['senior', 'head'].includes(actor.tier),
    'Forbidden',
    'Referred applications require a Senior Credit Officer',
    403,
  );
}
export interface ReviewCalendar {
  weekendDays: number[];
  holidays: string[];
}
export function referralTarget(start: string, calendar: ReviewCalendar) {
  validDate(start);
  invariant(
    calendar.weekendDays.length < 7 &&
      calendar.weekendDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    'InvalidCalendar',
    'At least one working weekday is required',
  );
  calendar.holidays.forEach(validDate);
  const date = new Date(`${start}T00:00:00Z`);
  let remaining = 2;
  while (remaining) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (
      !calendar.weekendDays.includes(date.getUTCDay()) &&
      !calendar.holidays.includes(date.toISOString().slice(0, 10))
    )
      remaining--;
  }
  return date.toISOString().slice(0, 10);
}
export function rejectionClauses(input: {
  fraudReferral: boolean;
  missing: string[];
  results: { rule: string; result: string }[];
  customerDeclined: boolean;
}) {
  invariant(
    !input.fraudReferral && !input.missing.length,
    'UnresolvedReferral',
    'Missing or tampered evidence requires referral and reassessment, not rejection',
    409,
  );
  return [
    ...new Set(
      input.results
        .filter((r) => r.result === 'fail' && r.rule !== 'CP-4.1')
        .map((r) => r.rule.split(' ')[0]!)
        .concat(input.customerDeclined ? ['CP-4.1'] : []),
    ),
  ];
}
