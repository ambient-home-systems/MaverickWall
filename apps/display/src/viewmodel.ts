import type { CivilDate, Manifest, ManifestDay, ManifestEvent, ManifestShift } from './manifest.js';
export type { ManifestShift };

/**
 * Manifest to something drawable, with no DOM in sight.
 *
 * Every decision about what is shown and what is dropped happens here, so it
 * can be tested against a document rather than against a screenshot. The
 * renderer below it does no thinking at all.
 *
 * The shape is a pyramid: one day in full, a few days in summary, the rest as
 * colour. That is what "zoom" means on a wall — the further away a day is, the
 * less of it is worth the space, but the shape of the month still has to be
 * visible from the doorway.
 */

/*
 * Density, when the manifest does not say.
 *
 * These are the defaults, not the policy: the household owns these numbers now
 * and sets them on the Display screen, because the right answer depends on a
 * room nobody writing this can see. A ten-inch tablet in a hallway and a 43"
 * panel in a kitchen want different ones, and so do a family with one
 * appointment a week and one with six a day.
 *
 * They stay here because an older server, or a manifest that predates the
 * field, must still produce a sensible wall rather than an empty one.
 */
export const TODAY_EVENT_LIMIT = 8;
/** "Next six days", per the design. Empty days are shown, not skipped. */
export const NEXT_DAY_COUNT = 6;
export const NEXT_EVENT_LIMIT = 4;
/** Five weeks of horizon, not six: the design gives the rest to the day itself. */
export const HORIZON_WEEKS = 5;

/** The three things a wall can show, and the order it shows them in by default. */
export type DisplayBlock = 'now' | 'next' | 'horizon';
export const DEFAULT_BLOCKS: readonly DisplayBlock[] = ['now', 'next', 'horizon'];

/**
 * The order to draw in, from whatever the manifest said.
 *
 * Unknown names are dropped rather than trusted — this bundle can only render
 * what it has a renderer for, and a block named by a newer server would
 * otherwise be a gap on the wall. An empty result falls back to all three,
 * because a wall drawing nothing is the outcome rule nine exists to prevent.
 */
export function resolveBlocks(requested: readonly string[] | undefined): DisplayBlock[] {
  if (requested === undefined) return [...DEFAULT_BLOCKS];
  const blocks: DisplayBlock[] = [];
  for (const name of requested) {
    if (!DEFAULT_BLOCKS.includes(name as DisplayBlock)) continue;
    if (blocks.includes(name as DisplayBlock)) continue;
    blocks.push(name as DisplayBlock);
  }
  return blocks.length === 0 ? [...DEFAULT_BLOCKS] : blocks;
}

/** Older than this and the wall says so rather than quietly lying. */
export const STALE_AFTER_MS = 30 * 60_000;

export interface EventModel {
  readonly id: string;
  readonly title: string;
  readonly time: string;
  readonly allDay: boolean;
  readonly color: string;
  readonly location: string | undefined;
  readonly continues: boolean;
  /** Already happened. Dimmed rather than removed — it is still context. */
  readonly isPast: boolean;
  /** The next one due. The only thing on the wall that is highlighted. */
  readonly isNext: boolean;
}

export interface ShiftModel {
  readonly personName: string;
  readonly personAvatarUrl: string | null;
  readonly personColor: string;
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  readonly isWorking: boolean;
}

export interface DayModel {
  readonly date: CivilDate;
  readonly weekday: string;
  readonly dayNumber: string;
  readonly month: string;
  readonly isToday: boolean;
  readonly isPast: boolean;
  readonly shifts: readonly ShiftModel[];
  readonly events: readonly EventModel[];
  /** Events beyond the limit, so the wall can say how many it is not showing. */
  readonly hiddenEventCount: number;
}

export interface HorizonCell {
  readonly date: CivilDate;
  readonly dayNumber: string;
  readonly isToday: boolean;
  readonly isPast: boolean;
  readonly inMonth: boolean;
  /**
   * The colour token for the day.
   *
   * Every shift tints its cell, working or not: the horizon is the *shape* of
   * the rotation, and a rest day is part of that shape. Undefined means no
   * rota resolved for that day at all, which is a different fact and looks
   * different.
   */
  readonly shiftToken: string | undefined;
  readonly shiftCode: string | undefined;
  /** The full name, for the legend that sits under the grid. */
  readonly shiftLabel: string | undefined;
  readonly eventCount: number;
}

export type Staleness =
  | { readonly level: 'fresh' }
  | { readonly level: 'stale'; readonly message: string }
  | { readonly level: 'offline'; readonly message: string };

export interface DisplayModel {
  readonly timezone: string;
  readonly theme: string;
  readonly todayLabel: string;
  readonly clock: string;
  readonly today: DayModel | undefined;
  /** The badge: the single most important element on the wall. */
  readonly todayShift: ManifestShift | undefined;
  /** "Day 2 of 4 · 2 more", or undefined when there is no rota today. */
  readonly shiftRun: string | undefined;
  readonly next: readonly DayModel[];
  readonly horizon: readonly (readonly HorizonCell[])[];
  readonly notices: readonly { readonly level: string; readonly message: string }[];
  readonly staleness: Staleness;
  /** Which blocks to draw, in order. The renderer walks this and nothing else. */
  readonly blocks: readonly DisplayBlock[];
}

/** A whole number inside a range, or the fallback when it is not one at all. */
function bounded(value: number | undefined, low: number, high: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * The civil date in a zone, from `Intl` rather than from arithmetic.
 *
 * The whole application anchors on this: a wall showing the wrong day is worse
 * than a wall showing nothing, because nobody doubts it.
 */
export function localDate(at: number, timezone: string): CivilDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${find('year')}-${find('month')}-${find('day')}`;
}

export function localTime(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at));
}

function parts(date: CivilDate, timezone: string): { weekday: string; day: string; month: string } {
  // Noon UTC, so the date cannot slide across a boundary in either direction
  // when it is reinterpreted in the household's zone.
  const at = Date.parse(`${date}T12:00:00Z`);
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(new Date(at));
  const find = (type: string): string => formatted.find((part) => part.type === type)?.value ?? '';
  return { weekday: find('weekday'), day: find('day'), month: find('month') };
}

function eventTime(event: ManifestEvent, timezone: string): string {
  if (event.allDay) return 'All day';
  return localTime(event.startsAt, timezone);
}

function toEvent(
  event: ManifestEvent,
  timezone: string,
  marks: { isPast: boolean; isNext: boolean } = { isPast: false, isNext: false },
): EventModel {
  return {
    id: event.id,
    title: event.title,
    time: eventTime(event, timezone),
    allDay: event.allDay,
    color: event.color,
    location: event.location,
    continues: event.continues,
    isPast: marks.isPast,
    isNext: marks.isNext,
  };
}

/**
 * Mark what has been and what is next.
 *
 * Only today's list gets this. An all-day event is never "next" — it has no
 * time to be next at, and highlighting it would push the actual next thing
 * down the page.
 */
function markToday(events: readonly ManifestEvent[], now: number, timezone: string): EventModel[] {
  let foundNext = false;
  return events.map((event) => {
    const past = !event.allDay && event.endsAt <= now;
    const isNext = !past && !event.allDay && !foundNext && event.startsAt > now;
    if (isNext) foundNext = true;
    return toEvent(event, timezone, { isPast: past, isNext });
  });
}

function toShift(shift: ManifestShift): ShiftModel {
  return {
    personName: shift.personName,
    personAvatarUrl: shift.personAvatarUrl ?? null,
    personColor: shift.personColor,
    label: shift.label,
    shortCode: shift.shortCode,
    colorToken: shift.colorToken,
    isWorking: shift.isWorking,
  };
}

function toDay(day: ManifestDay, today: CivilDate, timezone: string, limit: number): DayModel {
  const { weekday, day: dayNumber, month } = parts(day.date, timezone);
  const shown = day.events.slice(0, limit);
  return {
    date: day.date,
    weekday,
    dayNumber,
    month,
    isToday: day.date === today,
    isPast: day.date < today,
    shifts: day.shifts.map(toShift),
    events: shown.map((event) => toEvent(event, timezone)),
    hiddenEventCount: day.events.length - shown.length,
  };
}

/**
 * Group the window into calendar weeks starting Monday.
 *
 * Padded at both ends so the grid is rectangular. A ragged first row reads as
 * a rendering fault from across a room, even though it is technically honest.
 */
function intoWeeks(cells: readonly HorizonCell[]): HorizonCell[][] {
  const weeks: HorizonCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7) as HorizonCell[]);
  }
  return weeks;
}

function weekdayIndex(date: CivilDate): number {
  // Monday first. `getUTCDay` is Sunday-first, and a household's week is not.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return (day + 6) % 7;
}

function addDays(date: CivilDate, days: number): CivilDate {
  const at = Date.parse(`${date}T12:00:00Z`) + days * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

export interface BuildOptions {
  readonly manifest: Manifest;
  /** Corrected wall time. Never the tablet's own clock. */
  readonly now: number;
  /** When the manifest on screen was last confirmed by the server. */
  readonly lastConfirmedAt: number;
  readonly offline: boolean;
}

export function buildModel(options: BuildOptions): DisplayModel {
  const { manifest, now } = options;
  const timezone = manifest.timezone;
  const today = localDate(now, timezone);

  // The household's numbers when the server sends them, this bundle's when it
  // does not. Guarded rather than trusted: the server clamps them too, and a
  // wall asked for two hundred weeks should still draw something.
  const chosen = manifest.display;
  const todayLimit = bounded(chosen?.todayEvents, 1, 20, TODAY_EVENT_LIMIT);
  const nextDays = bounded(chosen?.nextDays, 0, 14, NEXT_DAY_COUNT);
  const horizonWeeks = bounded(chosen?.horizonWeeks, 1, 8, HORIZON_WEEKS);
  const blocks = resolveBlocks(chosen?.blocks);

  const byDate = new Map<CivilDate, ManifestDay>();
  for (const day of manifest.days) byDate.set(day.date, day);

  const todayDay = byDate.get(today);

  /*
   * The next few days that have anything on them.
   *
   * Skipping empty days rather than showing them: three blank panels tell
   * nobody anything, and the horizon below already says those days are empty.
   */
  const next: DayModel[] = [];
  const wantsNext = blocks.includes('next');
  for (let offset = 1; wantsNext && offset <= nextDays; offset++) {
    const date = addDays(today, offset);
    if (date > manifest.window.to) break;
    const day = byDate.get(date) ?? { date, shifts: [], events: [] };
    next.push(toDay(day, today, timezone, NEXT_EVENT_LIMIT));
  }

  // The horizon starts on the Monday of the week containing today, so the grid
  // lines up with how a month is read rather than with when this happened to
  // be fetched.
  const start = addDays(today, -weekdayIndex(today));
  const cells: HorizonCell[] = [];
  const todayMonth = today.slice(0, 7);
  for (let offset = 0; offset < horizonWeeks * 7; offset++) {
    const date = addDays(start, offset);
    const day = byDate.get(date);
    // The first shift of the day, whether or not it is a working one.
    const shift = day?.shifts[0];
    cells.push({
      date,
      dayNumber: String(Number(date.slice(8, 10))),
      isToday: date === today,
      isPast: date < today,
      inMonth: date.slice(0, 7) === todayMonth,
      shiftToken: shift?.colorToken,
      shiftCode: shift?.shortCode,
      shiftLabel: shift?.label,
      eventCount: day?.events.length ?? 0,
    });
  }

  const age = Math.max(0, now - options.lastConfirmedAt);
  let staleness: Staleness = { level: 'fresh' };
  if (options.offline) {
    staleness = {
      level: 'offline',
      message: `Not reaching the server. Showing what was last known, ${describeAge(age)}.`,
    };
  } else if (age > STALE_AFTER_MS) {
    staleness = { level: 'stale', message: `Last updated ${describeAge(age)}.` };
  }

  const { weekday, day: dayNumber, month } = parts(today, timezone);

  return {
    timezone,
    theme: manifest.theme.active,
    todayLabel: `${weekday} ${dayNumber} ${month}`,
    clock: localTime(now, timezone),
    today:
      todayDay === undefined
        ? undefined
        : {
            ...toDay(todayDay, today, timezone, todayLimit),
            events: markToday(todayDay.events.slice(0, todayLimit), now, timezone),
          },
    todayShift: todayDay?.shifts[0],
    shiftRun: todayDay === undefined ? undefined : describeRun(byDate, today, timezone),
    next,
    horizon: intoWeeks(cells),
    notices: manifest.notices.map((notice) => ({ level: notice.level, message: notice.message })),
    staleness,
    blocks,
  };
}

/**
 * How far through a run of the same shift today is.
 *
 * The question a shift worker's household actually asks of a wall is not
 * "what is he on today" but "how many more of these" — so the badge says
 * "Day 2 of 4 · 2 more" rather than repeating the label.
 */
function describeRun(
  byDate: Map<CivilDate, ManifestDay>,
  today: CivilDate,
  _timezone: string,
): string | undefined {
  const key = byDate.get(today)?.shifts[0]?.key;
  if (key === undefined) return undefined;

  const sameAs = (date: CivilDate): boolean => byDate.get(date)?.shifts[0]?.key === key;

  let before = 0;
  while (before < 14 && sameAs(addDays(today, -(before + 1)))) before++;
  let after = 0;
  while (after < 14 && sameAs(addDays(today, after + 1))) after++;

  const total = before + after + 1;
  const position = before + 1;
  if (after === 0) return `Last of ${total}`;
  return `Day ${position} of ${total} · ${after} more`;
}

/** "12 minutes ago" reads better on a wall than a timestamp nobody can parse. */
export function describeAge(ageMs: number): string {
  // Floored, not rounded. Rounding turns 30 seconds into "1 minute ago", which
  // is a wall claiming to be staler than it is — and the whole point of this
  // line is that it can be trusted.
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
