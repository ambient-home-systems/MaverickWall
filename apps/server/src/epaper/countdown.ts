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

/** The occasions an `occasion` countdown is dressed for (plan item P5.2). */
export const OCCASIONS = ['christmas', 'birthday', 'halloween', 'vacation', 'schools-out', 'new-year', 'custom'] as const;
export type Occasion = (typeof OCCASIONS)[number];

/**
 * Which occasion. **Absent is `custom`** — the theme's own accent and the
 * household's own picture — and so is a value from a newer server this
 * bundle does not know, which is the side to be wrong on: a Christmas tree on
 * a countdown to somebody's wedding is worse than no tree at all.
 */
export function countdownOccasion(config: unknown): Occasion {
  const value = configOf(config)['occasion'];
  return typeof value === 'string' && (OCCASIONS as readonly string[]).includes(value) ? (value as Occasion) : 'custom';
}

/**
 * The start date a `progress` countdown counts its days gone from, or
 * undefined for one not set, not a civil date, or **not before the target**.
 *
 * The schema refuses a start on or after the target with a sentence, so a
 * stored config never holds one; this refuses it again for a config from a
 * server older or newer than this bundle, because a bar from a start after its
 * own end has no honest fraction to draw — and a bar that drew one anyway
 * would be a number made up on the one screen a household trusts.
 */
export function countdownFrom(config: unknown): string | undefined {
  const own = configOf(config);
  const from = own['from'];
  const target = countdownTarget(config);
  if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(from) || target === undefined) return undefined;
  return daysUntil(from, target) > 0 ? from : undefined;
}

/** How far through a countdown's run the household is (plan item P5.2). */
export interface CountdownProgress {
  /** Whole days from the start to the target: the bar's length. */
  readonly total: number;
  /** Whole days gone, from the start to today, held between none and all of them. */
  readonly gone: number;
  /** `gone / total`, between 0 and 1. */
  readonly fraction: number;
  /** The fraction as a whole percentage, 100 only on the day or after it. */
  readonly percent: number;
}

/**
 * The days gone from `from` to `today`, out of `from` to `target` — all civil
 * dates — or undefined for a start that is not before its target.
 *
 * **Floored, never rounded**, so a bar one day short of its end reads 99% and
 * never 100%: "100%" on the day before is the countdown claiming a day that
 * has not come. Before the start the bar is empty; after the target it is
 * full and stays full, as the count says "3 days ago".
 */
export function countdownProgress(today: string, from: string, target: string): CountdownProgress | undefined {
  const total = daysUntil(from, target);
  if (!(total > 0)) return undefined;
  const gone = Math.max(0, Math.min(total, daysUntil(from, today)));
  return { total, gone, fraction: gone / total, percent: Math.floor((gone * 100) / total) };
}

/** The line under a progress bar: "21% of the way". */
export function percentWords(progress: CountdownProgress): string {
  return `${progress.percent}% of the way`;
}

/** One square of a mini month: the day of the month, or null for a square before the first or after the last. */
export type MonthSquare = number | null;

/** A target's month, laid out in weeks in the household's order. */
export interface MiniMonth {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  /** Rows of exactly seven squares. */
  readonly weeks: readonly (readonly MonthSquare[])[];
}

/**
 * The month a countdown's target falls in, as rows of seven, starting on the
 * household's own first day of the week — the calendar's own rule, so a mini
 * month and the month grid beside it put Monday in the same column.
 *
 * Read at UTC noon, `daysUntil`'s arithmetic, so no zone can slide the first
 * of the month into the wrong column. Four to six rows: how many is a fact
 * about the target's month and never about the events, so the grid's shape
 * changes only when the household changes the date.
 */
export function miniMonth(target: string, weekStart: 'sunday' | 'monday'): MiniMonth {
  const year = Number(target.slice(0, 4));
  const month = Number(target.slice(5, 7));
  const first = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay();
  const length = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  const lead = weekStart === 'monday' ? (first + 6) % 7 : first;
  const squares: MonthSquare[] = [];
  for (let i = 0; i < lead; i++) squares.push(null);
  for (let day = 1; day <= length; day++) squares.push(day);
  while (squares.length % 7 !== 0) squares.push(null);
  const weeks: MonthSquare[][] = [];
  for (let at = 0; at < squares.length; at += 7) weeks.push(squares.slice(at, at + 7));
  return { year, month, weeks };
}

/**
 * The day of the month today is, if today is in the target's own month — the
 * one day a mini month can mark as today — or undefined.
 */
export function todayInMonth(today: string, target: string): number | undefined {
  return today.slice(0, 7) === target.slice(0, 7) ? Number(today.slice(8, 10)) : undefined;
}

/* countdown-words:end */
