/**
 * Public surface of @maverick-wall/calendar.
 *
 * Everything here is plain and serialisable. No parser object escapes this
 * package, so callers can cache these, persist them, or ship them over a
 * socket without dragging ical.js into their process.
 */

/** A wall-clock reading with no zone attached. Not an instant. */
export interface WallClock {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  /** 1-31 */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type EventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

/**
 * One fully resolved calendar instance. Recurrence has already been expanded,
 * so consumers never see an RRULE and never need a recurrence library.
 */
export interface NormalizedEvent {
  readonly uid: string;
  /**
   * Which instance of a series this is, as a basic-format local reading such as
   * `20260315T090000`. Present on every instance of a recurring event, absent
   * on one-off events. Combined with `uid` it is a stable identity across
   * re-fetches and restarts.
   */
  readonly recurrenceId?: string;
  readonly title: string;
  readonly startUtc: Date;
  /** Exclusive. For all-day events this is local midnight *after* the last day. */
  readonly endUtc: Date;
  readonly allDay: boolean;
  /**
   * The IANA zone this instance was anchored in. For floating times, all-day
   * dates, and unresolvable TZIDs this is the caller's `targetTimezone`, since
   * that is what actually determined the instant.
   */
  readonly sourceTzid: string;
  readonly location?: string;
  /** `CANCELLED` never appears; those instances are filtered out. */
  readonly status: EventStatus;
  readonly isRecurringInstance: boolean;
  /** Only present when `includeDescription` was requested. */
  readonly description?: string;
}

export type CalendarErrorCode =
  /** `icsText` was empty or not a string. */
  | 'EMPTY_INPUT'
  /** `targetTimezone` is not a zone this platform recognises. */
  | 'INVALID_TIMEZONE'
  /** Window bounds missing, not dates, or start is not before end. */
  | 'INVALID_WINDOW'
  /** `maxEvents` was not a positive integer. */
  | 'INVALID_OPTION'
  /** The document is not recoverable ICS. */
  | 'PARSE_FAILED'
  /** Input exceeded `maxBytes`. */
  | 'TOO_LARGE'
  /** A bug in this package. Should never be returned; report it if it is. */
  | 'INTERNAL';

export interface CalendarError {
  readonly code: CalendarErrorCode;
  /** Safe to show a user. Contains no event content and no feed credentials. */
  readonly message: string;
  /** Safe to log. Parser detail, when there is any. */
  readonly detail?: string;
}

export type CalendarWarningCode =
  | 'EVENT_SKIPPED'
  | 'MISSING_UID'
  | 'MISSING_DTSTART'
  | 'UNRESOLVED_TIMEZONE'
  | 'WINDOWS_TIMEZONE_MAPPED'
  | 'INVALID_RRULE'
  | 'ORPHAN_OVERRIDE'
  | 'NEGATIVE_DURATION'
  | 'MAX_EVENTS_REACHED'
  | 'EXPANSION_TRUNCATED';

/**
 * Something was wrong but the calendar still rendered. Warnings drive the
 * admin UI and the on-screen degraded banner; they never gate display.
 * Safe to log: a code, a UID, and a message, never event bodies.
 */
export interface CalendarWarning {
  readonly code: CalendarWarningCode;
  readonly message: string;
  readonly uid?: string;
}

export interface ExpansionMeta {
  readonly warnings: readonly CalendarWarning[];
  /**
   * `maxEvents` or an internal ceiling was hit. The returned list is the
   * earliest events in the window, not all of them. Surface this rather than
   * implying a quiet afternoon.
   */
  readonly truncated: boolean;
  /** How many instances existed before the cap was applied. */
  readonly totalBeforeCap: number;
  /** `X-WR-CALNAME`, when the feed supplies one. A sensible default label. */
  readonly calendarName?: string;
}

/**
 * Success carries `value` plus expansion metadata; failure carries a typed
 * error. `expandCalendar` returns `Result<NormalizedEvent[], CalendarError>`
 * and never throws.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T; readonly meta: ExpansionMeta }
  | { readonly ok: false; readonly error: E };

export interface ExpandCalendarInput {
  readonly icsText: string;
  /** IANA zone, e.g. `America/Chicago`. Anchors all-day and floating times. */
  readonly targetTimezone: string;
  /** Inclusive. Events straddling this bound are included. */
  readonly windowStart: Date;
  /** Exclusive. */
  readonly windowEnd: Date;
  /** Cap on returned instances. Default 2000. */
  readonly maxEvents?: number;
  /**
   * Include DESCRIPTION. Off by default: descriptions carry meeting links,
   * dial-in PINs, and addresses that have no business on a kitchen wall or in
   * a websocket payload.
   */
  readonly includeDescription?: boolean;
  /** Reject inputs larger than this. Default 16 MiB. */
  readonly maxBytes?: number;
}

/** How a wall clock is anchored to the timeline. Internal, exported for tests. */
export type ZoneRef =
  | { readonly kind: 'utc' }
  | { readonly kind: 'floating' }
  | { readonly kind: 'iana'; readonly tzid: string }
  | { readonly kind: 'unknown'; readonly tzid: string };

export interface LocalDateTime {
  readonly wall: WallClock;
  readonly zone: ZoneRef;
  /** `VALUE=DATE` — a calendar date, not an instant. */
  readonly isDate: boolean;
}

/** One VEVENT, normalised. Either a series master or a RECURRENCE-ID override. */
export interface NormalizedVevent {
  readonly uid: string;
  readonly sequence: number;
  readonly title: string;
  readonly description: string | undefined;
  readonly location: string | undefined;
  readonly status: EventStatus;
  readonly start: LocalDateTime;
  /** Exclusive, per RFC 5545. Synthesised from DURATION or defaults if absent. */
  readonly end: LocalDateTime;
  readonly allDay: boolean;
  readonly rrule: string | undefined;
  readonly rdates: readonly LocalDateTime[];
  readonly exdates: readonly LocalDateTime[];
  readonly recurrenceId: LocalDateTime | undefined;
}

/** A series master plus any RECURRENCE-ID overrides sharing its UID. */
export interface ParsedEvent {
  readonly master: NormalizedVevent;
  readonly overrides: readonly NormalizedVevent[];
}

export interface ParseResult {
  readonly events: readonly ParsedEvent[];
  readonly warnings: readonly CalendarWarning[];
  readonly calendarName: string | undefined;
  /** Set when the document could not be parsed at all. */
  readonly error: CalendarError | undefined;
}
