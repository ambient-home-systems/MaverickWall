import { Recur, Time, Timezone } from 'ical.js';
import {
  addDaysToWallClock,
  formatWallClockBasic,
  resolveZonedWallClock,
  utcMsFromWallClock,
  wallClockInZone,
  wholeDaysBetween,
} from './timezone.js';
import type {
  CalendarWarning,
  LocalDateTime,
  NormalizedEvent,
  NormalizedVevent,
  ParsedEvent,
  WallClock,
} from './types.js';

/** Guards a single pathological rule such as FREQ=SECONDLY with no COUNT. */
const MAX_ITERATIONS_PER_EVENT = 20_000;

export interface ExpandContext {
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly targetTimezone: string;
  readonly includeDescription: boolean;
  /** Collection ceiling before the caller's maxEvents cap is applied. */
  readonly collectionCeiling: number;
}

/** Which IANA zone a normalised time is actually anchored in. */
function zoneIdFor(local: LocalDateTime, targetTimezone: string): string {
  switch (local.zone.kind) {
    case 'utc':
      return 'UTC';
    case 'iana':
      return local.zone.tzid;
    case 'floating':
    case 'unknown':
      return targetTimezone;
    default:
      return targetTimezone;
  }
}

function toWallClock(time: Time): WallClock {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
}

function floatingTime(wall: WallClock, isDate: boolean): Time {
  return new Time(
    {
      year: wall.year,
      month: wall.month,
      day: wall.day,
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second,
      isDate,
    },
    Timezone.localTimezone,
  );
}

/**
 * RRULE `UNTIL` is expressed in UTC whenever DTSTART carries a zone, but we
 * iterate in wall-clock space. Rewriting UNTIL into the event's own local
 * reading keeps the comparison meaningful. Without this, a series anchored in
 * UTC+13 ends up to a day short.
 */
function rewriteUntil(rrule: string, zoneId: string): string {
  return rrule.replace(/UNTIL=(\d{8})T(\d{6})Z/i, (_match, date: string, time: string) => {
    const instantMs = Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(4, 6)) - 1,
      Number(date.slice(6, 8)),
      Number(time.slice(0, 2)),
      Number(time.slice(2, 4)),
      Number(time.slice(4, 6)),
    );
    return `UNTIL=${formatWallClockBasic(wallClockInZone(instantMs, zoneId))}`;
  });
}

interface Shape {
  readonly zoneId: string;
  readonly allDay: boolean;
  /** All-day only: whole days each instance spans, minimum 1. */
  readonly dayCount: number;
  /** Timed only: wall-clock seconds each instance spans. */
  readonly durationSeconds: number;
}

function shapeOf(vevent: NormalizedVevent, targetTimezone: string): Shape {
  const zoneId = zoneIdFor(vevent.start, targetTimezone);

  if (vevent.allDay) {
    const days = wholeDaysBetween(vevent.start.wall, vevent.end.wall);
    return { zoneId, allDay: true, dayCount: Math.max(1, days), durationSeconds: 0 };
  }

  const endZoneId = zoneIdFor(vevent.end, targetTimezone);
  let durationSeconds: number;
  if (endZoneId === zoneId) {
    // Normal case. A 09:00-10:00 event stays one wall-clock hour on every
    // instance, which is what people expect across a DST boundary and what
    // mainstream clients do.
    durationSeconds =
      (utcMsFromWallClock(vevent.end.wall) - utcMsFromWallClock(vevent.start.wall)) / 1000;
  } else {
    // DTSTART and DTEND in different zones. Fall back to elapsed real time.
    const startMs = resolveZonedWallClock(vevent.start.wall, zoneId).instantMs;
    const endMs = resolveZonedWallClock(vevent.end.wall, endZoneId).instantMs;
    durationSeconds = (endMs - startMs) / 1000;
  }

  return { zoneId, allDay: false, dayCount: 0, durationSeconds: Math.max(0, durationSeconds) };
}

function addSeconds(wall: WallClock, seconds: number): WallClock {
  const d = new Date(utcMsFromWallClock(wall) + seconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

interface Built {
  readonly event: NormalizedEvent;
  readonly startMs: number;
  readonly endMs: number;
}

function build(
  source: NormalizedVevent,
  startWall: WallClock,
  recurrenceKey: string | undefined,
  shape: Shape,
  context: ExpandContext,
  isRecurringInstance: boolean,
): Built {
  const endWall = shape.allDay
    ? addDaysToWallClock(startWall, shape.dayCount)
    : addSeconds(startWall, shape.durationSeconds);

  const startMs = resolveZonedWallClock(startWall, shape.zoneId).instantMs;
  const endMs = resolveZonedWallClock(endWall, shape.zoneId).instantMs;

  const event: NormalizedEvent = {
    uid: source.uid,
    ...(recurrenceKey !== undefined ? { recurrenceId: recurrenceKey } : {}),
    title: source.title,
    startUtc: new Date(startMs),
    endUtc: new Date(endMs),
    allDay: shape.allDay,
    sourceTzid: shape.zoneId,
    ...(source.location !== undefined ? { location: source.location } : {}),
    status: source.status,
    isRecurringInstance,
    ...(context.includeDescription && source.description !== undefined
      ? { description: source.description }
      : {}),
  };

  return { event, startMs, endMs };
}

/** Instance-level intersection with the window. Zero-length events count. */
function intersects(startMs: number, endMs: number, windowStart: number, windowEnd: number): boolean {
  if (startMs >= windowEnd) return false;
  if (endMs > startMs) return endMs > windowStart;
  return startMs >= windowStart;
}

function expandOne(
  parsed: ParsedEvent,
  context: ExpandContext,
  warnings: CalendarWarning[],
  budget: { remaining: number },
): { built: Built[]; truncated: boolean } {
  const { master } = parsed;
  const shape = shapeOf(master, context.targetTimezone);
  const isRecurring = Boolean(master.rrule) || master.rdates.length > 0;
  const built: Built[] = [];

  // A cancelled master cancels the whole series.
  if (master.status === 'CANCELLED') return { built, truncated: false };

  const overridesByKey = new Map<string, NormalizedVevent>();
  for (const override of parsed.overrides) {
    if (!override.recurrenceId) continue;
    overridesByKey.set(formatWallClockBasic(override.recurrenceId.wall), override);
  }

  const excluded = new Set<string>();
  for (const exdate of master.exdates) excluded.add(formatWallClockBasic(exdate.wall));

  const candidates = new Map<string, WallClock>();
  const addCandidate = (wall: WallClock): void => {
    candidates.set(formatWallClockBasic(wall), wall);
  };

  addCandidate(master.start.wall);
  let truncated = false;

  if (master.rrule) {
    try {
      const recur = Recur.fromString(rewriteUntil(master.rrule, shape.zoneId));
      const iterator = recur.iterator(floatingTime(master.start.wall, master.allDay));
      let iterations = 0;

      for (;;) {
        if (iterations >= MAX_ITERATIONS_PER_EVENT) {
          truncated = true;
          warnings.push({
            code: 'EXPANSION_TRUNCATED',
            message:
              'This event repeats too densely to expand fully; later instances may be missing.',
            uid: master.uid,
          });
          break;
        }
        iterations++;

        const next = iterator.next();
        if (!next) break;

        const wall = toWallClock(next);
        // Cheap pre-filter in wall-clock space. The 48h pad absorbs any offset
        // difference between the event's zone and UTC.
        if (utcMsFromWallClock(wall) > context.windowEndMs + 48 * 3_600_000) break;
        addCandidate(wall);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      warnings.push({
        code: 'INVALID_RRULE',
        message: `Repeat rule could not be applied (${detail}); showing the first occurrence only.`,
        uid: master.uid,
      });
    }
  }

  for (const rdate of master.rdates) addCandidate(rdate.wall);

  const emit = (candidate: Built): boolean => {
    if (!intersects(candidate.startMs, candidate.endMs, context.windowStartMs, context.windowEndMs)) {
      return true;
    }
    if (budget.remaining <= 0) return false;
    budget.remaining--;
    built.push(candidate);
    return true;
  };

  for (const [key, wall] of candidates) {
    if (excluded.has(key)) continue;

    const override = overridesByKey.get(key);
    if (override) {
      overridesByKey.delete(key);
      if (override.status === 'CANCELLED') continue;
      const candidate = build(
        override,
        override.start.wall,
        key,
        shapeOf(override, context.targetTimezone),
        context,
        true,
      );
      if (!emit(candidate)) return { built, truncated: true };
      continue;
    }

    const candidate = build(
      master,
      wall,
      isRecurring ? key : undefined,
      shape,
      context,
      isRecurring,
    );
    if (!emit(candidate)) return { built, truncated: true };
  }

  // Overrides whose original slot fell outside the window but which were moved
  // into it. Without this pass, a meeting dragged from last month into today
  // silently disappears.
  for (const [key, override] of overridesByKey) {
    if (override.status === 'CANCELLED') continue;
    const candidate = build(
      override,
      override.start.wall,
      key,
      shapeOf(override, context.targetTimezone),
      context,
      true,
    );
    if (!emit(candidate)) return { built, truncated: true };
  }

  return { built, truncated };
}

export interface ExpansionOutcome {
  readonly events: NormalizedEvent[];
  readonly warnings: CalendarWarning[];
  readonly truncated: boolean;
  readonly totalBeforeCap: number;
}

/**
 * Expand parsed events into concrete instances inside the window, sorted by
 * start. Never throws: a single broken event degrades to a warning and the rest
 * of the calendar renders normally.
 */
export function expandEvents(
  parsed: readonly ParsedEvent[],
  context: ExpandContext,
  maxEvents: number,
): ExpansionOutcome {
  const warnings: CalendarWarning[] = [];
  const budget = { remaining: context.collectionCeiling };
  const all: Built[] = [];
  let truncated = false;

  for (const event of parsed) {
    try {
      const result = expandOne(event, context, warnings, budget);
      for (const item of result.built) all.push(item);
      truncated = truncated || result.truncated;
      if (budget.remaining <= 0) {
        truncated = true;
        break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      warnings.push({
        code: 'EVENT_SKIPPED',
        message: `An event could not be expanded and was skipped: ${detail}`,
        uid: event.master.uid,
      });
    }
  }

  // Sort before capping, so the cap keeps the *earliest* events rather than an
  // arbitrary slice in feed order. Ties are broken deterministically because
  // snapshots depend on it.
  all.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
    const byTitle = a.event.title.localeCompare(b.event.title);
    if (byTitle !== 0) return byTitle;
    const byUid = a.event.uid.localeCompare(b.event.uid);
    if (byUid !== 0) return byUid;
    return (a.event.recurrenceId ?? '').localeCompare(b.event.recurrenceId ?? '');
  });

  const totalBeforeCap = all.length;
  let capped = all;
  if (all.length > maxEvents) {
    capped = all.slice(0, maxEvents);
    truncated = true;
    warnings.push({
      code: 'MAX_EVENTS_REACHED',
      message: `This range contains ${totalBeforeCap} events; showing the first ${maxEvents}.`,
    });
  }

  return {
    events: capped.map((item) => item.event),
    warnings,
    truncated,
    totalBeforeCap,
  };
}
