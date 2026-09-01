/**
 * The manifest, reduced to what a 1-bit e-paper frame draws (RFC 006).
 *
 * This is the eInk counterpart to the display bundle's `viewmodel.ts`: all the
 * "what to show" decisions live here so the renderer below can do no thinking.
 * It deliberately does *not* reinvent the calendar engine — the server manifest
 * has already expanded recurrence, resolved shifts, bucketed events into days
 * (with `DTEND` exclusive), and applied the household's density. This only
 * *selects*: today's agenda, and a rolling week grid for the month shape.
 *
 * It lives in `apps/server`, not the display package, because the frame is
 * rendered here — the device cannot run a browser. The display's `buildModel`
 * is browser-bundled and typed against a separate `Manifest`; sharing it would
 * mean a fragile cross-package import for logic that is genuinely different at
 * 1-bit (no colour, no avatars, a fixed panel). So the manifest is the shared
 * contract, not the code.
 */
import { addDays, dayOfWeek, type CivilDate } from '@maverick-wall/core';

import type { Manifest, ManifestDay, ManifestEvent, ManifestPersonShift } from '../api/manifest.js';

/**
 * The most of today the model carries, so the *renderer* can decide how much
 * of it to draw.
 *
 * This was `EPAPER_TODAY_LIMIT = 6`, and its comment called it "the most agenda
 * rows a 7.5-inch panel can hold and still be read at the far side of a kitchen".
 * That was an honest measurement — of one panel, applied to every panel from
 * 640×384 to 1872×1404, which is a 3.7× range that drew six rows at every size
 * and left the bottom half of the biggest one white.
 *
 * So it is a working set now rather than an answer, exactly as
 * `EPAPER_UPCOMING_LIMIT` below already was: generous, bounded so a very large
 * panel cannot ask the model for a hundred rows of a day that has four things
 * on it, and cut to the box by `agendaRowsInBox` where the box is known. The
 * household's own density still binds first and is applied here — "show me at
 * most four things" is a request about the day, not about the panel.
 */
export const EPAPER_AGENDA_LIMIT = 24;

/** Rolling weeks in the month grid when the manifest does not say otherwise. */
export const EPAPER_GRID_WEEKS = 5;

export interface EpaperAgendaItem {
  /** `HH:MM`, or empty for an all-day entry (the renderer marks it). */
  readonly time: string;
  readonly title: string;
  readonly allDay: boolean;
}

/**
 * One row of the *upcoming* list a calendar widget can draw — today and the
 * days after it, unfiltered and only loosely capped.
 *
 * `agenda` above is today's, already cut to the household's density for the
 * built-in layout. A widget cannot select from that: filtering that list by
 * calendar leaves fewer rows than it held, and a household asking for twelve
 * events would never see more. So the widget's source is its own list,
 * carrying the source id it filters on and the date it groups under, and the
 * *renderer* does the cutting.
 */
export interface EpaperUpcomingItem {
  readonly date: CivilDate;
  /** `HH:MM`, or empty for an all-day entry. */
  readonly time: string;
  readonly title: string;
  readonly allDay: boolean;
  /** Which calendar it came from, for the widget's "calendars to show". */
  readonly sourceId: string;
  readonly isToday: boolean;
}

/**
 * The most upcoming rows the model carries. Generous rather than exact: the
 * widget's own cap is what a household set, and this only bounds the frame's
 * working set. Fifty is the largest count the editor will store.
 */
export const EPAPER_UPCOMING_LIMIT = 60;

/**
 * The most events a grid cell carries, for the labelled month and the week
 * columns.
 *
 * Four was what a 34px cell on a 7.5" panel could show; a 235px cell on a
 * 13.3" one has room for eight and was drawing four and a "+9". The renderer
 * counts what fits (`cellTitlesInBox`), so this is only the working set —
 * twelve, the same cut the browser wall's slim list makes, which is why a day
 * with twenty events says "+17" rather than "+9" on both.
 *
 * Raising it also helps the month grid's spans, which is the other thing this
 * cap decides: an event past it contributes no span, so a bar could be split
 * where a cell's fifth event was the one that continues. At twelve that takes
 * a cell nobody has. `eventCount` beside it is still the day's true total.
 */
export const EPAPER_CELL_TITLES_LIMIT = 12;

export interface EpaperGridCell {
  /** Day-of-month number, 1–31. */
  readonly day: number;
  readonly date: CivilDate;
  readonly isToday: boolean;
  /** Whether the manifest actually covers this date (has event data for it). */
  readonly inWindow: boolean;
  /** How many events fall on this day, for density shading. */
  readonly eventCount: number;
  /**
   * The first few events on this day, for the labelled-pill month and the week
   * columns. Density shading only ever needed the count; a cell that names what
   * is on it needs the names, and a panel has no second request to make.
   *
   * It carries the whole event rather than its title because the month grid
   * now groups a multi-day event into one bar, and grouping on the *title*
   * would merge two unrelated "Bin day" entries a week apart into a seven-day
   * span — see `month-spans.ts`, which the wall reads the same way.
   */
  readonly events: readonly EpaperCellEvent[];
}

/** One of a cell's events, as much of it as either month treatment needs. */
export interface EpaperCellEvent {
  /** Identity, stable across every date the event touches. */
  readonly id: string;
  readonly title: string;
  readonly allDay: boolean;
  /** The server's own "covers more than one date". */
  readonly continues: boolean;
}

export interface EpaperShiftLine {
  /**
   * Whose shift, for the widget's "whose rota" option.
   *
   * The id rather than the name, because that is what the editor stores and a
   * household may rename a person without meaning to empty their widget.
   */
  readonly personId: string;
  readonly person: string;
  readonly code: string;
  readonly label: string;
  /** `HH:MM–HH:MM`, or empty for an untimed shift. */
  readonly time: string;
  readonly working: boolean;
}

export interface EpaperModel {
  readonly today: CivilDate;
  /** `HH:MM` of the frame's own time, for a clock widget. */
  readonly time: string;
  /** Header pieces, already localised. Casing is the renderer's business. */
  readonly header: {
    readonly weekday: string;
    readonly day: string;
    readonly month: string;
    readonly year: string;
  };
  /** Today's shift(s), one per person who has one. Empty when nobody does. */
  readonly todayShifts: readonly EpaperShiftLine[];
  readonly agenda: readonly EpaperAgendaItem[];
  /**
   * How many events today has in total, so the renderer can say "+3 more".
   *
   * The *total*, not the overflow, because the cut moved: the renderer decides
   * how many rows the box holds, so only it knows how many were left out. A
   * pre-computed overflow would have been an answer to a question this file can
   * no longer ask.
   */
  readonly agendaTotal: number;
  /** Today and the days after it, for a calendar widget's upcoming list. */
  readonly upcoming: readonly EpaperUpcomingItem[];
  /** Weekday labels for the grid header, in the household's week order. */
  readonly weekdayLabels: readonly string[];
  /** Rows of exactly seven cells, in the household's week order. */
  readonly weeks: readonly (readonly EpaperGridCell[])[];
  readonly timezone: string;
  readonly generatedAt: number;
}

export interface EpaperViewOptions {
  /** The clock the panel should read; defaults to the manifest's own time. */
  readonly now?: number;
}

/** en-GB, matching the rest of the server's formatting. Sunday- or Monday-first. */
const WEEKDAY_LABELS_SUNDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const WEEKDAY_LABELS_MONDAY = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/** A civil date at UTC noon, so day-label formatting never drifts a day. */
function civilToUtcDate(date: CivilDate): Date {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12));
}

/**
 * How many days a civil date sits past the start of its week (0 = the first
 * day), from core's Sunday-based `dayOfWeek`. Monday-first rotates by one.
 */
function weekOffset(date: CivilDate, weekStart: 'sunday' | 'monday'): number {
  return weekStart === 'monday' ? (dayOfWeek(date) + 6) % 7 : dayOfWeek(date);
}

function headerParts(today: CivilDate): EpaperModel['header'] {
  const d = civilToUtcDate(today);
  const fmt = (opts: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(d);
  return {
    weekday: fmt({ weekday: 'long' }),
    day: fmt({ day: 'numeric' }),
    month: fmt({ month: 'long' }),
    year: fmt({ year: 'numeric' }),
  };
}

/** `HH:MM` for a timed event in the panel's zone; 24-hour unless asked otherwise. */
/** Exported so a clock widget can re-read the time in its own format. */
export function clockLabel(epochMs: number, timezone: string, clock24: boolean): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: !clock24,
    timeZone: timezone,
  }).format(new Date(epochMs));
}

/** All-day first, then by start time — how an agenda reads top to bottom. */
function agendaOrder(a: ManifestEvent, b: ManifestEvent): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return a.startsAt - b.startsAt;
}

export function buildEpaperModel(manifest: Manifest, options: EpaperViewOptions = {}): EpaperModel {
  const timezone = manifest.timezone;
  const clock24 = manifest.display.clock24 !== false;
  const today = localDateFromManifest(manifest, options.now ?? manifest.generatedAt, timezone);

  const byDate = new Map<CivilDate, ManifestDay>();
  for (const day of manifest.days) byDate.set(day.date, day);

  // Agenda: today's events, all-day first. The cap is the tighter of the
  // household's number and the working set — the *panel* is not consulted here
  // any more, because this file cannot see the box the rows are drawn in.
  const limit = Math.min(clampTodayEvents(manifest.display.todayEvents), EPAPER_AGENDA_LIMIT);
  const todaysEvents = [...(byDate.get(today)?.events ?? [])].sort(agendaOrder);
  const agenda: EpaperAgendaItem[] = todaysEvents.slice(0, limit).map((event) => ({
    time: event.allDay ? '' : clockLabel(event.startsAt, timezone, clock24),
    title: event.title,
    allDay: event.allDay,
  }));

  // The widget's source: today and the days after it, in order, unfiltered.
  // Deliberately not the capped `agenda` above — see `EpaperUpcomingItem`.
  const upcoming: EpaperUpcomingItem[] = [];
  for (const day of manifest.days) {
    if (day.date < today) continue;
    if (upcoming.length >= EPAPER_UPCOMING_LIMIT) break;
    for (const event of [...day.events].sort(agendaOrder)) {
      if (upcoming.length >= EPAPER_UPCOMING_LIMIT) break;
      upcoming.push({
        date: day.date,
        time: event.allDay ? '' : clockLabel(event.startsAt, timezone, clock24),
        title: event.title,
        allDay: event.allDay,
        sourceId: event.sourceId,
        isToday: day.date === today,
      });
    }
  }

  // Today's shifts, one line per person who has one. `shifts` is already
  // resolved per person in the manifest, so this only formats it for 1-bit.
  // A hyphen, not the wall's en dash: the bitmap font is ASCII, and anything
  // outside it draws as a blank cell — "07:00 19:00", which reads as two
  // separate times rather than a span.
  const shiftTime = (shift: ManifestPersonShift): string =>
    shift.startTime && shift.endTime ? `${shift.startTime}-${shift.endTime}` : '';
  const todayShifts: EpaperShiftLine[] = (byDate.get(today)?.shifts ?? []).map((shift) => ({
    personId: shift.personId,
    person: shift.personName,
    code: shift.shortCode,
    label: shift.label,
    time: shiftTime(shift),
    working: shift.isWorking,
  }));

  // Grid: whole weeks starting from the first day (Sunday or Monday, per the
  // household) of today's week.
  const weekStart: 'sunday' | 'monday' = manifest.display.weekStart === 'monday' ? 'monday' : 'sunday';
  const weekCount = clampGridWeeks(manifest.display.horizonWeeks);
  const gridStart = addDays(today, -weekOffset(today, weekStart));
  const weeks: EpaperGridCell[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const row: EpaperGridCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      const day = byDate.get(date);
      /*
       * Only the calendars the household keeps on the grid.
       *
       * The wall filters the same flag at the same seam (`viewmodel.ts` in
       * `apps/display`), and it has to be the same answer: a panel following a
       * wall that draws one arrangement must not draw a different month. The
       * agenda and `upcoming` above are deliberately unfiltered — the switch
       * takes a calendar out of the squares, not off the panel.
       */
      const gridEvents = (day?.events ?? []).filter((event) => event.showInGrid !== false);
      row.push({
        day: Number.parseInt(date.slice(8, 10), 10),
        date,
        isToday: date === today,
        inWindow: day !== undefined,
        eventCount: gridEvents.length,
        events: [...gridEvents]
          .sort(agendaOrder)
          .slice(0, EPAPER_CELL_TITLES_LIMIT)
          .map((event) => ({
            id: event.id,
            title: event.title,
            allDay: event.allDay,
            continues: event.continues,
          })),
      });
    }
    weeks.push(row);
  }

  return {
    today,
    time: clockLabel(options.now ?? manifest.generatedAt, timezone, clock24),
    header: headerParts(today),
    todayShifts,
    agenda,
    agendaTotal: todaysEvents.length,
    upcoming,
    weekdayLabels: [...(weekStart === 'monday' ? WEEKDAY_LABELS_MONDAY : WEEKDAY_LABELS_SUNDAY)],
    weeks,
    timezone,
    generatedAt: manifest.generatedAt,
  };
}

/**
 * Today's civil date, from the manifest's window when possible.
 *
 * The manifest already knows the household zone; re-deriving it here with a
 * separate `Intl` call is one more place to disagree with the server about what
 * day it is. So the window's own dates are the source of truth, and the epoch
 * is only the tiebreaker for which of them is today.
 */
function localDateFromManifest(manifest: Manifest, nowMs: number, timezone: string): CivilDate {
  const guess = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(nowMs));
  // en-CA yields YYYY-MM-DD. Clamp into the window so the grid always has data
  // for "today" even if the clock and the manifest disagree at a boundary.
  const from = manifest.window.from;
  const to = manifest.window.to;
  if (guess < from) return from;
  if (guess > to) return to;
  return guess;
}

function clampTodayEvents(value: number): number {
  if (!Number.isFinite(value) || value < 1) return EPAPER_AGENDA_LIMIT;
  return Math.floor(value);
}

function clampGridWeeks(value: number): number {
  if (!Number.isFinite(value) || value < 1) return EPAPER_GRID_WEEKS;
  return Math.min(8, Math.floor(value));
}
