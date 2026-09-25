import { isEmojiKey, type EmojiKey } from './emoji.js';

/**
 * What a countdown says, decided once and without a DOM (plan item P5.2).
 *
 * Every look a countdown has — the number, the tear-off page, the ticket —
 * draws the same facts: how many days, in which words, and whether today is
 * the day. Those facts live here, pure, for the reason `widget-options.ts`,
 * `ink.ts` and `ladder.ts` are pure: there is no DOM in the display's test
 * suite, so a rule decided inside a `createElement` call is a rule nothing can
 * check. `countdown-looks.ts` builds the nodes and does no thinking.
 *
 * **The words are the panel's too.** `apps/server/src/epaper/countdown.ts`
 * transcribes the block between the markers below character for character and
 * `countdown-parity.test.ts` compares the two as text — the seam `variants.ts`,
 * `tiers.ts` and `clock-face.ts` already sit at, for their reason: the display
 * bundle has no bundler and the server cannot import it, and two renderers
 * holding one sentence is this project's most repeated bug. What is outside the
 * block is the wall's alone: the picture (a panel draws none), the date in the
 * wall's locale, and everything that moves.
 *
 * **Every new key is optional and absent by default, and absent is what a
 * countdown drew before this existed**: `unitWords` absent is days, `emoji`
 * absent is no picture, `celebrate` absent is on — the one default that does
 * something, and the only day it does anything on is the target itself.
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

/**
 * The picture beside "Today!" — a key from the bundled set (P4.2), drawn as an
 * `<img>` and never as a code point, so every wall shows the same popper.
 */
export const CELEBRATION_EMOJI: EmojiKey = 'party-popper';

/** The chosen picture, or undefined for none or a key this bundle has no art for. */
export function countdownEmoji(config: unknown): EmojiKey | undefined {
  const key = configOf(config)['emoji'];
  return isEmojiKey(key) ? key : undefined;
}

/**
 * A civil date as a countdown's page prints it: "Thu 25 Dec". Read at UTC
 * noon and formatted in UTC, because the string is a calendar date with no
 * zone in it — reading it as a local instant would slide it a day for anybody
 * west of Greenwich, `weekdayOfDate`'s trap.
 */
export function targetDateWords(target: string, locale: string): string {
  const at = new Date(`${target}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
      .format(at)
      .replace(/,/g, '');
  } catch {
    return target;
  }
}

/** How long a burst of confetti falls, in ms. Stated here and nowhere else. */
export const CELEBRATION_MS = 4_800;

/**
 * How often the day may celebrate again: at most once an hour. A wall that
 * went off every tick would be a wall a household turns off; once an hour is
 * a room walked back into finding it still happy.
 */
export const CELEBRATION_EVERY_MS = 60 * 60_000;

/** How long a page takes to tear off at midnight, in ms. */
export const PAGE_TEAR_MS = 1_400;

/** How long one flap on the board takes to fall, in ms. */
export const FLAP_FALL_MS = 900;

/**
 * How many pieces of confetti a burst draws: capped, and flat, for the oldest
 * tablet a wall runs on (plan P4.3 — particle counts are capped, 2D only).
 */
export const CONFETTI_PIECES = 28;

/** One piece of confetti: where it starts across the box, and how it falls. */
export interface ConfettiPiece {
  /** Its left edge, as a percentage of the box. */
  readonly left: number;
  /** How far it drifts sideways as it falls, in spacing steps (`--s3`): -4 to 4. */
  readonly drift: number;
  /** How far it turns, in degrees. */
  readonly turn: number;
  /** Which of the palette's colours it is painted in. */
  readonly tone: number;
}

/**
 * The burst, laid out the same way on every draw.
 *
 * **Deterministic, not random**, because a draw rebuilds every piece every
 * fifteen seconds: a burst resumed through a redraw has to find each piece
 * where it left it, and `Math.random()` would scatter them afresh mid-fall.
 * A fixed stride over the width is enough to look thrown.
 */
export function confettiPieces(count = CONFETTI_PIECES): ConfettiPiece[] {
  const pieces: ConfettiPiece[] = [];
  for (let i = 0; i < count; i++) {
    pieces.push({
      left: (i * 37 + 11) % 97,
      drift: ((i * 53) % 9) - 4,
      turn: 180 + ((i * 71) % 5) * 90,
      tone: i % 5,
    });
  }
  return pieces;
}
