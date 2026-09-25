/**
 * A countdown's words, on the panel (plan item P5.2).
 *
 * The block between the markers is `apps/display/src/countdown.ts`'s character
 * for character, and `countdown-parity.test.ts` holds the two to it — a panel
 * following a wall counts the same days in the same words, and one that said
 * "12 days" where its wall said "12 sleeps" would be `shifts[0]` in a
 * countdown. The wall is the spec: where these disagree, the display file is
 * right.
 *
 * Nothing is declared outside the block. The wall's file carries the picture,
 * the date in its locale and the motion's timings after its block; a panel
 * draws no picture, prints its date in its own alphabet (`widgets.ts`) and
 * does not move.
 */

/* countdown-words:begin */

/** How the count is worded: days, or the sleeps a child counts. */
export type CountdownWords = 'days' | 'sleeps';

/** The words a countdown draws on its day, on every look (P5.2). */
export const TODAY_WORDS = 'Today!';

type Config = Readonly<Record<string, unknown>>;

function configOf(config: unknown): Config {
  return typeof config === 'object' && config !== null && !Array.isArray(config) ? (config as Config) : {};
}

/** The target date, or undefined for one not set or not a civil date. */
export function countdownTarget(config: unknown): string | undefined {
  const target = configOf(config)['target'];
  return typeof target === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(target) ? target : undefined;
}

/** The household's own label — the widget's title — trimmed. Empty is none. */
export function countdownLabel(config: unknown): string {
  const title = configOf(config)['title'];
  return typeof title === 'string' ? title.trim() : '';
}

/**
 * Days or sleeps. Anything but `sleeps` is days, so a value from a newer
 * server this bundle does not know reads as the words it always drew.
 */
export function countdownWords(config: unknown): CountdownWords {
  return configOf(config)['unitWords'] === 'sleeps' ? 'sleeps' : 'days';
}

/**
 * Whether the day plays a burst of confetti. **Absent is on** — the plan's
 * default — so only an explicit `false` is off.
 */
export function celebrates(config: unknown): boolean {
  return configOf(config)['celebrate'] !== false;
}

/**
 * Whole days from `today` to `target`, both civil dates: positive before the
 * day, zero on it, negative after. Noon to noon in UTC, so neither a clock
 * change nor the zone can put a birthday on the wrong side of a boundary —
 * the same arithmetic the widget has always done.
 */
export function daysUntil(today: string, target: string): number {
  return Math.round((Date.parse(`${target}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

/**
 * The unit under the number: "day", "days", "sleep", "sleeps", "day ago",
 * "days ago". Empty on the day itself, where the count is "Today!".
 *
 * **Sleeps only count forward.** "12 sleeps until Christmas" is how a child
 * counts; nobody counts the sleeps since, so a date that has passed reads in
 * days whichever words the household chose — "3 days ago", never "3 sleeps
 * ago". The days forms are exactly the strings the number has always drawn.
 */
export function unitWords(days: number, words: CountdownWords): string {
  if (days === 0) return '';
  const n = Math.abs(days);
  if (days < 0) return n === 1 ? 'day ago' : 'days ago';
  if (words === 'sleeps') return n === 1 ? 'sleep' : 'sleeps';
  return n === 1 ? 'day' : 'days';
}

/**
 * The ticket's line under the destination: "Departs in 12 days", "Departed 3
 * days ago", and on the day "Today!". The number is written out here as well
 * as on the board, because the board is what a small box gives up first — and
 * on the day the line is where "Today!" goes, because there is nothing left on
 * the board to count.
 */
export function ticketLine(days: number, words: CountdownWords): string {
  if (days === 0) return TODAY_WORDS;
  const n = Math.abs(days);
  return days > 0 ? `Departs in ${n} ${unitWords(days, words)}` : `Departed ${n} ${unitWords(days, words)}`;
}

/**
 * The count as the digits a board or a page draws — the number without its
 * sign, since "ago" is what says which side of the day it is.
 */
export function countDigits(days: number): string {
  return String(Math.abs(days));
}

/**
 * The digits a board showed yesterday, for the flaps that fall at midnight.
 *
 * A countdown's count moves by exactly one a day, so what the board read
 * before the change is always `days + 1`: 12 becomes 11, and -3 ("3 days
 * ago") was -2. On the day after the target the board read "Today!" rather
 * than a number, so there are no old digits to fall and the new ones simply
 * arrive. Right-aligned to the new digits' width — 100 becoming 99 is three
 * flaps becoming two, and only the two that are there can fall.
 */
export function previousDigits(days: number, width: number): string[] {
  const before = days + 1;
  const old = before === 0 ? '' : countDigits(before);
  const padded = old.length >= width ? old.slice(old.length - width) : ' '.repeat(width - old.length) + old;
  return padded.split('');
}

/* countdown-words:end */
