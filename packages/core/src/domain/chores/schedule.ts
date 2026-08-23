import { addDays, dayOfWeek, daysBetween, isCivilDate, type CivilDate } from '../../time/civil.js';

/**
 * When a chore is due.
 *
 * Five cases, and the list is short on purpose. A chore that repeats is a
 * recurrence problem, and there is a hardened RFC 5545 engine two packages
 * away — `packages/calendar`, with `COUNT`, `BYSETPOS`, `EXDATE` and
 * `RECURRENCE-ID`. It is deliberately not used here.
 *
 * The reason is the failure mode rather than the capability. A household says
 * "bins on Tuesdays" and "hoover every other day"; nobody says `FREQ=MONTHLY;
 * BYDAY=-1FR`. Putting a general recurrence language behind a kitchen form
 * buys expressiveness nobody asked for and one failure that cannot be
 * explained standing at a fridge: a rule that parses, expands to nothing, and
 * leaves the wall silent about a chore that plainly exists.
 *
 * The precedent is already in this package. Shift rotations describe
 * themselves with their own pattern vocabulary rather than an RRULE, despite
 * being derived from calendar feeds — for the same reason, and it has held.
 *
 * Self-contained by the same rule `domain/shift/` follows: nothing else in
 * core imports this directory, and this directory imports nothing from core
 * beyond civil date arithmetic. Extracting it later is a `git mv`, and a
 * household with no chores loses nothing by having it switched off.
 */

/** 0 = Sunday, matching `dayOfWeek` and every calendar UI in the product. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ChoreSchedule =
  /** Every day. */
  | { readonly kind: 'daily' }
  /** Certain weekdays — "bins on Tuesdays", "hoover Saturday and Sunday". */
  | { readonly kind: 'weekdays'; readonly days: readonly number[] }
  /**
   * Every `n`th day counting from `from`, which is the day it first falls due.
   *
   * The anchor is part of the schedule rather than derived from the chore's
   * creation time, because "every 3 days" has no meaning without a day to
   * count from, and a household editing the chore must not silently re-phase it.
   */
  | { readonly kind: 'everyNDays'; readonly n: number; readonly from: CivilDate }
  /**
   * A day of the month, 1–28.
   *
   * Capped at 28 rather than clamping 29–31 to "the last day of the month",
   * and that is a refusal rather than a limitation. A chore set to the 31st
   * would behave differently in February from every other month, and the
   * household would have no way to tell from the form which they had asked
   * for. A control that means "the last day" should say so; when one exists it
   * is a sixth case here, not a special value in this one.
   */
  | { readonly kind: 'monthlyDate'; readonly day: number }
  /** A one-off on a named day. */
  | { readonly kind: 'once'; readonly date: CivilDate };

/** How far `dueDatesBetween` will walk before giving up. */
const MAX_SPAN_DAYS = 732;

/**
 * Is this chore due on this civil date?
 *
 * **Total, and never throws.** The schedule arrives from a JSON column this
 * process wrote, but a column written by a version of this code nobody has any
 * more is still a boundary, and this runs inside manifest assembly, which rule
 * nine forbids from failing. Anything unreadable answers "not due" — a chore
 * that quietly stops appearing is recoverable by editing it; an exception here
 * takes the wall down.
 *
 * A civil date, never an instant, and that is the whole of the timezone story.
 * "Bins out Tuesday" is a claim about what the kitchen calendar says, not about
 * a moment — so a chore ticked at 23:50 on Monday belongs to Monday, and the
 * day rolls at local midnight because the caller resolved the household's zone
 * to a date before calling. Getting this wrong in instant-space is the same
 * bug as rendering `DTEND` inclusive, wearing a different hat.
 */
export function dueOn(schedule: ChoreSchedule | null | undefined, date: CivilDate): boolean {
  if (schedule === null || schedule === undefined) return false;
  if (!isCivilDate(date)) return false;

  switch (schedule.kind) {
    case 'daily':
      return true;

    case 'weekdays': {
      if (!Array.isArray(schedule.days)) return false;
      const today = dayOfWeek(date);
      return schedule.days.some((day) => day === today);
    }

    case 'everyNDays': {
      const { n, from } = schedule;
      if (!Number.isInteger(n) || n < 1) return false;
      if (typeof from !== 'string' || !isCivilDate(from)) return false;
      const elapsed = daysBetween(from, date);
      // Before the anchor is not "every nth day in the other direction". A
      // household setting a chore to start next Monday means it starts then.
      if (elapsed < 0) return false;
      return elapsed % n === 0;
    }

    case 'monthlyDate': {
      const { day } = schedule;
      if (!Number.isInteger(day) || day < 1 || day > 28) return false;
      return Number(date.slice(8, 10)) === day;
    }

    case 'once':
      return typeof schedule.date === 'string' && schedule.date === date;

    default:
      // A `kind` this version has no arm for — a column written by a newer
      // build, then rolled back. Not due, rather than a thrown wall.
      return false;
  }
}

/**
 * Every date in `[from, to]` the chore falls due on, inclusive both ends.
 *
 * What "done 6 of the last 7 Tuesdays" is counted against, and what a week
 * view of a chore board is drawn from. Bounded rather than trusting its
 * caller: a range typed into a URL should cost a short list, not a walk to the
 * heat death of the universe. An unreadable range answers with nothing, for
 * the same reason `dueOn` does.
 */
export function dueDatesBetween(
  schedule: ChoreSchedule | null | undefined,
  from: CivilDate,
  to: CivilDate,
): CivilDate[] {
  if (!isCivilDate(from) || !isCivilDate(to)) return [];
  const span = daysBetween(from, to);
  if (span < 0 || span > MAX_SPAN_DAYS) return [];

  const out: CivilDate[] = [];
  let cursor = from;
  for (let step = 0; step <= span; step++) {
    if (dueOn(schedule, cursor)) out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * The next date on or after `from` that this chore is due, within `withinDays`.
 *
 * Bounded and returning `undefined` rather than searching forever, because two
 * of the five cases genuinely have no next date: a `once` in the past, and any
 * schedule a newer build wrote. "Nothing coming up" is a real answer and the
 * caller has to draw it either way.
 */
export function nextDueOn(
  schedule: ChoreSchedule | null | undefined,
  from: CivilDate,
  withinDays = 366,
): CivilDate | undefined {
  if (!isCivilDate(from)) return undefined;
  const limit = Math.min(Math.max(0, Math.trunc(withinDays)), MAX_SPAN_DAYS);
  let cursor = from;
  for (let step = 0; step <= limit; step++) {
    if (dueOn(schedule, cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return undefined;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `1st`, `2nd`, `23rd` — for the one case that names a number out loud. */
function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * The schedule as a household would say it out loud.
 *
 * Here rather than in the admin because the wall will want the same sentence,
 * and two renderers writing one fact two ways is a bug this project has paid
 * for more than once. Plain text — the caller escapes it, since only the
 * caller knows whether it is going into HTML, a 1-bit frame, or a log line.
 */
export function describeSchedule(schedule: ChoreSchedule | null | undefined): string {
  if (schedule === null || schedule === undefined) return 'No schedule';
  switch (schedule.kind) {
    case 'daily':
      return 'Every day';

    case 'weekdays': {
      if (!Array.isArray(schedule.days) || schedule.days.length === 0) return 'No days chosen';
      const names = [...new Set(schedule.days)]
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        .sort((a, b) => a - b)
        .map((day) => DAY_NAMES[day] as string);
      if (names.length === 0) return 'No days chosen';
      if (names.length === 7) return 'Every day';
      if (names.length === 1) return `Every ${names[0]}`;
      const last = names[names.length - 1] as string;
      return `Every ${names.slice(0, -1).join(', ')} and ${last}`;
    }

    case 'everyNDays':
      if (!Number.isInteger(schedule.n) || schedule.n < 1) return 'No schedule';
      if (schedule.n === 1) return 'Every day';
      if (schedule.n === 2) return 'Every other day';
      return `Every ${schedule.n} days`;

    case 'monthlyDate':
      if (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 28) {
        return 'No schedule';
      }
      return `The ${ordinal(schedule.day)} of each month`;

    case 'once':
      return typeof schedule.date === 'string' ? `Once, on ${schedule.date}` : 'No schedule';

    default:
      return 'No schedule';
  }
}
