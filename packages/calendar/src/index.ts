import { expandEvents } from './expand.js';
import { parseIcs } from './parse.js';
import { isValidTimeZone } from './timezone.js';
import type {
  CalendarError,
  ExpandCalendarInput,
  NormalizedEvent,
  Result,
} from './types.js';

const DEFAULT_MAX_EVENTS = 2000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function fail(
  code: CalendarError['code'],
  message: string,
  detail?: string,
): Result<NormalizedEvent[], CalendarError> {
  return {
    ok: false,
    error: detail === undefined ? { code, message } : { code, message, detail },
  };
}

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Parse an ICS document and expand it into concrete events inside a window.
 *
 * Never throws. Every failure — malformed input, an unknown timezone, an absurd
 * recurrence rule — comes back as a typed `CalendarError` or, where the
 * calendar is still usable, as a warning alongside the events that survived.
 *
 * ```ts
 * const result = expandCalendar({
 *   icsText,
 *   targetTimezone: 'America/Chicago',
 *   windowStart: new Date('2026-03-01T00:00:00Z'),
 *   windowEnd: new Date('2026-04-01T00:00:00Z'),
 * });
 *
 * if (!result.ok) return showBanner(result.error.message);
 * render(result.value, { truncated: result.meta.truncated });
 * ```
 */
export function expandCalendar(
  input: ExpandCalendarInput,
): Result<NormalizedEvent[], CalendarError> {
  try {
    if (input === null || typeof input !== 'object') {
      return fail('INVALID_OPTION', 'expandCalendar requires an input object.');
    }

    const {
      icsText,
      targetTimezone,
      windowStart,
      windowEnd,
      maxEvents = DEFAULT_MAX_EVENTS,
      includeDescription = false,
      maxBytes = DEFAULT_MAX_BYTES,
    } = input;

    if (typeof targetTimezone !== 'string' || !isValidTimeZone(targetTimezone)) {
      return fail(
        'INVALID_TIMEZONE',
        'The target timezone is not a recognised IANA timezone name.',
        typeof targetTimezone === 'string' ? targetTimezone : typeof targetTimezone,
      );
    }

    if (!isUsableDate(windowStart) || !isUsableDate(windowEnd)) {
      return fail('INVALID_WINDOW', 'The window start and end must both be valid dates.');
    }
    if (windowStart.getTime() >= windowEnd.getTime()) {
      return fail('INVALID_WINDOW', 'The window start must be before the window end.');
    }

    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      return fail('INVALID_OPTION', 'maxEvents must be a positive whole number.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      return fail('INVALID_OPTION', 'maxBytes must be a positive whole number.');
    }

    const parsed = parseIcs(icsText, maxBytes);
    if (parsed.error) return { ok: false, error: parsed.error };

    const outcome = expandEvents(
      parsed.events,
      {
        windowStartMs: windowStart.getTime(),
        windowEndMs: windowEnd.getTime(),
        targetTimezone,
        includeDescription,
        // Collect generously above the cap so the sort still sees enough
        // candidates to pick a genuinely correct earliest-N.
        collectionCeiling: Math.max(maxEvents * 5, 20_000),
      },
      maxEvents,
    );

    return {
      ok: true,
      value: outcome.events,
      meta: {
        warnings: [...parsed.warnings, ...outcome.warnings],
        truncated: outcome.truncated,
        totalBeforeCap: outcome.totalBeforeCap,
        ...(parsed.calendarName !== undefined ? { calendarName: parsed.calendarName } : {}),
      },
    };
  } catch (error) {
    // The contract is that this function never throws. If we land here it is a
    // bug in this package, and the caller still gets something actionable.
    const detail = error instanceof Error ? error.message : 'unknown error';
    return fail('INTERNAL', 'The calendar could not be processed.', detail);
  }
}

export { resolveTzid } from './zoneAliases.js';
export {
  formatIsoDate,
  formatWallClockBasic,
  isValidTimeZone,
  localDateOf,
  resolveZonedWallClock,
  wallClockInZone,
  zonedWallClockToUtcMs,
} from './timezone.js';
export type { ResolutionKind, ZonedResolution } from './timezone.js';
export type { ZoneResolution } from './zoneAliases.js';
export type {
  CalendarError,
  CalendarErrorCode,
  CalendarWarning,
  CalendarWarningCode,
  EventStatus,
  ExpandCalendarInput,
  ExpansionMeta,
  NormalizedEvent,
  Result,
  WallClock,
} from './types.js';
