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

import type { Manifest, ManifestDay, ManifestEvent } from '../api/manifest.js';

/**
 * The most agenda rows a 7.5" panel can hold and still be read at the far side
 * of a kitchen. Tighter than the browser wall's eight — this is the ceiling,
 * and a household that asked for fewer gets fewer.
 */
export const EPAPER_TODAY_LIMIT = 6;

/** Rolling weeks in the month grid when the manifest does not say otherwise. */
export const EPAPER_GRID_WEEKS = 5;

export interface EpaperAgendaItem {
  /** `HH:MM`, or empty for an all-day entry (the renderer marks it). */
  readonly time: string;
  readonly title: string;
  readonly allDay: boolean;
}

export interface EpaperGridCell {
  /** Day-of-month number, 1–31. */
  readonly day: number;
  readonly date: CivilDate;
  readonly isToday: boolean;
  /** Whether the manifest actually covers this date (has event data for it). */
  readonly inWindow: boolean;
  /** How many events fall on this day, for density shading. */
  readonly eventCount: number;
}

export interface EpaperModel {
  readonly today: CivilDate;
  /** Header pieces, already localised. Casing is the renderer's business. */
  readonly header: {
    readonly weekday: string;
    readonly day: string;
    readonly month: string;
    readonly year: string;
  };
  readonly agenda: readonly EpaperAgendaItem[];
  /** How many of today's events did not fit, so the renderer can say "+3 more". */
  readonly agendaOverflow: number;
  /** Monday-first weekday labels for the grid header. */
  readonly weekdayLabels: readonly string[];
  /** Rows of exactly seven cells, Monday first. */
  readonly weeks: readonly (readonly EpaperGridCell[])[];
  readonly timezone: string;
  readonly generatedAt: number;
}

export interface EpaperViewOptions {
  /** The clock the panel should read; defaults to the manifest's own time. */
  readonly now?: number;
}

/** en-GB, matching the rest of the server's formatting. */
const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/** A civil date at UTC noon, so day-label formatting never drifts a day. */
function civilToUtcDate(date: CivilDate): Date {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 12));
}

/** Monday index of a civil date (0 = Monday), from core's Sunday-based one. */
function mondayIndex(date: CivilDate): number {
  return (dayOfWeek(date) + 6) % 7;
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
function clockLabel(epochMs: number, timezone: string, clock24: boolean): string {
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

  // Agenda: today's events, all-day first, capped for the panel. The cap is the
  // tighter of the household's number and the panel ceiling.
  const limit = Math.min(clampTodayEvents(manifest.display.todayEvents), EPAPER_TODAY_LIMIT);
  const todaysEvents = [...(byDate.get(today)?.events ?? [])].sort(agendaOrder);
  const agenda: EpaperAgendaItem[] = todaysEvents.slice(0, limit).map((event) => ({
    time: event.allDay ? '' : clockLabel(event.startsAt, timezone, clock24),
    title: event.title,
    allDay: event.allDay,
  }));
  const agendaOverflow = Math.max(0, todaysEvents.length - agenda.length);

  // Grid: whole weeks (Monday first) starting from the Monday of today's week.
  const weekCount = clampGridWeeks(manifest.display.horizonWeeks);
  const gridStart = addDays(today, -mondayIndex(today));
  const weeks: EpaperGridCell[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const row: EpaperGridCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      const day = byDate.get(date);
      row.push({
        day: Number.parseInt(date.slice(8, 10), 10),
        date,
        isToday: date === today,
        inWindow: day !== undefined,
        eventCount: day?.events.length ?? 0,
      });
    }
    weeks.push(row);
  }

  return {
    today,
    header: headerParts(today),
    agenda,
    agendaOverflow,
    weekdayLabels: [...WEEKDAY_LABELS],
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
  if (!Number.isFinite(value) || value < 1) return EPAPER_TODAY_LIMIT;
  return Math.floor(value);
}

function clampGridWeeks(value: number): number {
  if (!Number.isFinite(value) || value < 1) return EPAPER_GRID_WEEKS;
  return Math.min(8, Math.floor(value));
}
