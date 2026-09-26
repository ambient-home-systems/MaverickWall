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

/**
 * What each occasion wears on the wall (plan item P5.2): an accent pair, a
 * motif and an ambient scene.
 *
 * **The pair is two tokens, never two colours.** Each is one of the palette's
 * readable tokens (`paletteTokens` in `theme.ts`, S13), which every theme —
 * a custom one included — derives until it clears 4.5:1 on both its `--bg`
 * and its `--panel`; so the count painted in `a` and its unit in `b` are
 * legible on every theme by construction rather than by a check here. The one
 * exception is `custom`, which is the theme's own accent over its own muted
 * ink: a household that chose neither a tree nor a cake gets their theme.
 *
 * **The motif is a key from the bundled set** (D6), drawn as an `<img>`;
 * `custom` has none of its own and wears the household's picture, if they
 * chose one. The six named here are the six the emoji set was curated for.
 */
export type OccasionScene = 'snow' | 'balloons' | 'leaves' | 'waves' | 'planes' | 'fireworks' | 'sparkles';

export interface OccasionLook {
  /** The count's colour: a token name. */
  readonly a: string;
  /** The unit's and the scene's colour: a token name. */
  readonly b: string;
  /** The occasion's own picture, or undefined for the household's. */
  readonly motif: EmojiKey | undefined;
  readonly scene: OccasionScene;
}

export const OCCASION_LOOKS: Readonly<Record<Occasion, OccasionLook>> = {
  christmas: { a: '--temp-hot', b: '--temp-cool', motif: 'christmas-tree', scene: 'snow' },
  birthday: { a: '--wx-storm', b: '--wx-sun', motif: 'birthday-cake', scene: 'balloons' },
  halloween: { a: '--temp-warm', b: '--wx-storm', motif: 'jack-o-lantern', scene: 'leaves' },
  vacation: { a: '--wx-rain', b: '--wx-sun', motif: 'beach-umbrella', scene: 'waves' },
  'schools-out': { a: '--temp-cool', b: '--wx-rain', motif: 'school-satchel', scene: 'planes' },
  'new-year': { a: '--wx-sun', b: '--wx-storm', motif: 'fireworks', scene: 'fireworks' },
  custom: { a: '--accent', b: '--muted', motif: undefined, scene: 'sparkles' },
};

/**
 * One cycle of each scene, in ms — stated here and nowhere else, `SKY_MOTION_MS`'
 * rule, because `motion.ts` computes the phase from it.
 *
 * Each is chosen for how the thing moves — unhurried snow, a slow rise, a
 * slower drift — and then held to the tick rule the forecast's sky is held
 * to: a cycle must not divide the fifteen-second redraw closely enough that a
 * restart would land near where a continuous loop is, or the one fault the
 * phase lock exists to prevent would be invisible to a household and to a
 * test alike. `countdown.test.ts` holds every one to at least a quarter of a
 * cycle.
 */
export const OCCASION_SCENE_MS = {
  snow: 6_500,
  balloons: 11_000,
  leaves: 9_000,
  /** The sun's glow; the two bands of water below it have their own. */
  waves: 9_000,
  planes: 10_000,
  fireworks: 3_400,
  sparkles: 4_400,
} as const satisfies Readonly<Record<OccasionScene, number>>;

/** The two bands of water under a vacation's sun: a near one and a slower far one. */
export const WAVE_BAND_MS: readonly [number, number] = [4_200, 6_200];

/** Where a thing in a scene rests, in percent of the box; its still frame. */
export interface SceneSpot {
  readonly left: number;
  readonly top: number;
}

/**
 * Where each scene's pieces sit, in its still frame and at their phase.
 *
 * **Fixed, never random**, `SKY_PARTICLES`' reason: the wall is rebuilt every
 * fifteen seconds, and a piece resumed through a redraw has to be found where
 * it was. Each is a fixed share of its cycle behind the one before it, so a
 * field of snow is spread through the fall rather than falling as one row.
 * Few, and flat — the oldest tablet a wall runs on is the budget (plan P4.3).
 */
export const SCENE_SPOTS: Readonly<Record<Exclude<OccasionScene, 'waves' | 'fireworks'>, readonly SceneSpot[]>> = {
  snow: [
    { left: 6, top: 14 }, { left: 18, top: 62 }, { left: 29, top: 30 }, { left: 41, top: 80 }, { left: 52, top: 8 },
    { left: 63, top: 48 }, { left: 74, top: 22 }, { left: 85, top: 70 }, { left: 93, top: 38 }, { left: 12, top: 90 },
  ],
  balloons: [{ left: 6, top: 64 }, { left: 26, top: 22 }, { left: 72, top: 70 }, { left: 88, top: 30 }, { left: 48, top: 88 }],
  leaves: [{ left: 8, top: 18 }, { left: 30, top: 66 }, { left: 55, top: 10 }, { left: 78, top: 52 }, { left: 90, top: 84 }, { left: 18, top: 88 }],
  planes: [{ left: 10, top: 16 }, { left: 44, top: 74 }, { left: 70, top: 34 }],
  sparkles: [{ left: 8, top: 12 }, { left: 86, top: 18 }, { left: 14, top: 78 }, { left: 82, top: 72 }, { left: 50, top: 6 }],
};

/** A New Year's bursts: where each goes off. Each throws `SPARKS` sparks. */
export const FIREWORK_BURSTS: readonly SceneSpot[] = [{ left: 16, top: 22 }, { left: 80, top: 16 }, { left: 62, top: 70 }];

/** How many sparks one burst throws, evenly round a circle. */
export const SPARKS = 8;

/** Where a spark ends up, in spacing steps (`--s4`) from its burst: a unit circle's point. */
export function sparkReach(index: number): { readonly dx: number; readonly dy: number } {
  const angle = (index / SPARKS) * Math.PI * 2;
  return { dx: Math.round(Math.cos(angle) * 100) / 100, dy: Math.round(Math.sin(angle) * 100) / 100 };
}

/** What the editor's occasion picker calls each, in the order it lists them. */
export const OCCASION_LABELS: Readonly<Record<Occasion, string>> = {
  christmas: 'Christmas',
  birthday: 'A birthday',
  halloween: 'Halloween',
  vacation: 'A holiday',
  'schools-out': 'School’s out',
  'new-year': 'New Year',
  custom: 'Something else',
};

/**
 * The sentence a start date on or after its target is refused with — the
 * server's own (`widget-schema.ts`), said beside the field before the save is
 * even tried.
 */
export const START_AFTER_TARGET = 'The start date has to be before the date it counts down to.';

/** How long a progress bar takes to fill the day it grows, in ms. */
export const PROGRESS_FILL_MS = 1_200;

/**
 * A mini month's title: "December 2026", in the wall's locale. Read at UTC
 * noon and formatted in UTC, `targetDateWords`' reason.
 */
export function monthTitleWords(target: string, locale: string): string {
  const at = new Date(`${target.slice(0, 7)}-01T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at);
  } catch {
    return target.slice(0, 7);
  }
}

/**
 * The weekday heads over a mini month, one letter each, in the household's
 * order. 4 January 2026 is a Sunday, so the seven days from it (or from the
 * 5th, a Monday) are one week in the right order.
 */
export function weekdayHeads(weekStart: 'sunday' | 'monday', locale: string): string[] {
  const heads: string[] = [];
  for (let i = 0; i < 7; i++) {
    const at = new Date(Date.UTC(2026, 0, (weekStart === 'monday' ? 5 : 4) + i, 12));
    try {
      heads.push(new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(at));
    } catch {
      heads.push('SMTWTFS'.charAt(at.getUTCDay()));
    }
  }
  return heads;
}
