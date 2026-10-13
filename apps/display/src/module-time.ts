import { DISPLAY_LOCALE, localDate, localTime } from './viewmodel.js';

/**
 * The words a module's countdown and timeline say (plan item M7.5), from the
 * wall's own corrected clock. Pure, so they can be held to the minute.
 *
 * A module says *when*, never how long: the wall works out what is left on
 * every draw, so a countdown goes on counting with the server gone, and a
 * schedule moves on past an item without a new panel arriving.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long until an instant, or since it: one unit where one says it and two
 * where the hours alone would be out by most of one.
 *
 *   - under an hour, whole minutes, **rounded up** while it is to come, so the
 *     countdown never claims a minute fewer than there is (a timer's rule) —
 *     and "Now" in the last minute and the minute after;
 *   - under two days, hours and minutes ("4 h 20 min"), the minutes floored;
 *   - after that, whole days, floored ("3 days").
 *
 * Past the instant the same units say how long ago, floored.
 */
export function untilWords(at: number, now: number): string {
  const gap = at - now;
  if (gap > -MINUTE && gap <= MINUTE) return 'Now';
  const ahead = gap > 0;
  const span = Math.abs(gap);
  let words: string;
  if (span < HOUR) {
    const minutes = ahead ? Math.ceil(span / MINUTE) : Math.floor(span / MINUTE);
    words = `${minutes} min`;
  } else if (span < 2 * DAY) {
    const hours = Math.floor(span / HOUR);
    const minutes = Math.floor((span - hours * HOUR) / MINUTE);
    words = minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  } else {
    words = `${Math.floor(span / DAY)} days`;
  }
  return ahead ? `In ${words}` : `${words} ago`;
}

/**
 * When an instant is, as a timeline's time column says it: the time alone on
 * the wall's own today, and the weekday before it on any other day — "14:00",
 * "Thu 07:00". In the household's zone and their twelve- or twenty-four-hour
 * clock, as every event time on the wall is.
 */
export function whenWords(at: number, now: number, timezone: string, hour12: boolean): string {
  const time = localTime(at, timezone, hour12);
  if (localDate(at, timezone) === localDate(now, timezone)) return time;
  const day = new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: timezone, weekday: 'short' }).format(new Date(at));
  return `${day} ${time}`;
}

/**
 * Which item on a timeline is next: the first not yet reached, or none when
 * every one has passed. An item is passed at its instant, so the one at 14:00
 * is next until 14:00 and passed from then.
 */
export function nextIndex(items: readonly { readonly at: number }[], now: number): number {
  return items.findIndex((item) => item.at > now);
}
