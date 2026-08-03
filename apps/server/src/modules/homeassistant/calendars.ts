import { zonedWallClockToUtcMs, type NormalizedEvent } from '@maverick-wall/calendar';

/**
 * Home Assistant calendar entities, normalised into the ICS shape.
 *
 * The whole value of this file is that it produces `NormalizedEvent` and
 * nothing downstream can tell the difference. The same row writer, the same
 * cache, the same manifest, the same renderer. An HA calendar that took its
 * own path through the display would be a second implementation of the thing
 * this product is, kept correct by nobody.
 *
 * For an add-on household this is the onboarding win: their calendars are
 * already in Home Assistant, and they add them here without finding a single
 * ICS address.
 *
 * Pure, and never throws.
 */

export interface CalendarEntity {
  readonly entityId: string;
  readonly name: string;
}

/** Parse `/api/calendars`, which is a flat list of the calendar entities. */
export function parseCalendarList(body: string): CalendarEntity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entities: CalendarEntity[] = [];
  for (const entry of parsed as { entity_id?: unknown; name?: unknown }[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const entityId = entry.entity_id;
    if (typeof entityId !== 'string' || !entityId.startsWith('calendar.')) continue;
    entities.push({
      entityId,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entityId,
    });
  }
  return entities;
}

interface RawEndpoint {
  readonly date?: unknown;
  readonly dateTime?: unknown;
}

interface RawEvent {
  readonly uid?: unknown;
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly location?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly recurrence_id?: unknown;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * One endpoint of an event, as an instant.
 *
 * Two shapes, exactly as ICS has two: `date` for an all-day boundary, which is
 * a local midnight and has to be anchored in the household's zone, and
 * `dateTime` for an instant, which carries its own offset and does not.
 */
function endpoint(raw: unknown, timezone: string): { ms: number; allDay: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as RawEndpoint;

  if (typeof value.date === 'string') {
    const match = DATE_ONLY.exec(value.date);
    if (match === null) return undefined;
    return {
      ms: zonedWallClockToUtcMs(
        {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: 0,
          minute: 0,
          second: 0,
        },
        timezone,
      ),
      allDay: true,
    };
  }

  if (typeof value.dateTime === 'string') {
    const ms = Date.parse(value.dateTime);
    return Number.isFinite(ms) ? { ms, allDay: false } : undefined;
  }

  return undefined;
}

export interface ParseEventsInput {
  readonly body: string;
  readonly entityId: string;
  /** The household's zone. Anchors all-day boundaries, exactly as ICS does. */
  readonly timezone: string;
}

/**
 * Parse `/api/calendars/{entity_id}?start=&end=`.
 *
 * **`end` is exclusive**, in both shapes, which is the same promise ICS makes
 * with `DTEND` and the same trap: a one-day all-day event on the 15th ends on
 * the 16th. Rendering it inclusive puts every birthday on the wrong day, and
 * it is the single most common bug in calendar code. The row writer already
 * steps back a millisecond to get the last day actually occupied, so nothing
 * here needs to — but a change to this function that "fixed" the end date
 * would break it, which is why this is written down.
 *
 * An event whose shape is surprising is skipped, not fatal. One unreadable
 * entry must not cost a household the rest of their calendar.
 */
export function parseCalendarEvents(input: ParseEventsInput): NormalizedEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const events: NormalizedEvent[] = [];
  let index = 0;

  for (const entry of parsed as RawEvent[]) {
    index++;
    if (typeof entry !== 'object' || entry === null) continue;

    const start = endpoint(entry.start, input.timezone);
    const end = endpoint(entry.end, input.timezone);
    if (start === undefined || end === undefined) continue;

    const title = typeof entry.summary === 'string' ? entry.summary : '';
    if (title === '') continue;

    /*
     * A uid, invented if Home Assistant did not supply one.
     *
     * Several integrations answer with no `uid` at all. The row id is built
     * from the uid, so two events with no uid on the same source would collide
     * and one would silently vanish — falling back to the position keeps them
     * distinct, and keeps it stable across a re-fetch of an unchanged
     * calendar, which is the property that matters.
     */
    const uid =
      typeof entry.uid === 'string' && entry.uid !== ''
        ? entry.uid
        : `${input.entityId}#${index}@maverick-wall`;

    const recurrenceId =
      typeof entry.recurrence_id === 'string' && entry.recurrence_id !== ''
        ? entry.recurrence_id
        : undefined;

    events.push({
      uid,
      ...(recurrenceId !== undefined ? { recurrenceId } : {}),
      title,
      startUtc: new Date(start.ms),
      // Never before the start. A calendar that answers with a reversed pair
      // would otherwise produce a negative span and a row that lands on no day
      // at all.
      endUtc: new Date(Math.max(start.ms, end.ms)),
      allDay: start.allDay,
      /*
       * The household's zone, and honestly so.
       *
       * Home Assistant resolves recurrence itself and hands back instants; it
       * never tells us which zone the event was authored in. Claiming a TZID
       * we were not given would be worse than naming the zone that actually
       * determined the instant, which is what this field means for floating
       * times in the ICS path too.
       */
      sourceTzid: input.timezone,
      ...(typeof entry.location === 'string' && entry.location !== ''
        ? { location: entry.location }
        : {}),
      // Home Assistant filters cancelled instances out before answering, so
      // anything that arrives here is on.
      status: 'CONFIRMED',
      isRecurringInstance: recurrenceId !== undefined,
    });
  }

  return events;
}

/**
 * The query for a window.
 *
 * Home Assistant wants ISO instants and refuses the request without both. It
 * also expands recurrence itself over exactly this range, which is why an HA
 * calendar source has no RRULE handling anywhere in this integration.
 */
export function eventsPath(entityId: string, from: Date, to: Date): string {
  const start = encodeURIComponent(from.toISOString());
  const end = encodeURIComponent(to.toISOString());
  return `/calendars/${encodeURIComponent(entityId)}?start=${start}&end=${end}`;
}
