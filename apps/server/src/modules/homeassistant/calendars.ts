import { zonedWallClockToUtcMs, type NormalizedEvent } from '@maverick-wall/calendar';
import { blankIsAbsent, parseJsonOr, z } from '../../validation.js';

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
const calendarEntity = z.looseObject({
  // Only `calendar.*`. Home Assistant answers this endpoint with calendars,
  // but a rule that says so is one fewer thing to assume.
  entity_id: z.string().startsWith('calendar.'),
  name: blankIsAbsent(),
});

export function parseCalendarList(body: string): CalendarEntity[] {
  const entities: CalendarEntity[] = [];
  for (const entry of parseJsonOr(z.array(z.unknown()).catch([]), body, [])) {
    const shaped = calendarEntity.safeParse(entry);
    if (!shaped.success) continue;
    entities.push({
      entityId: shaped.data.entity_id,
      name: shaped.data.name ?? shaped.data.entity_id,
    });
  }
  return entities;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * One boundary of an event.
 *
 * Two shapes, exactly as ICS has two — and the schema says "one of them must
 * be there", which the hand-rolled version expressed as a pair of `typeof`
 * checks and an implicit `undefined`.
 */
const endpointShape = z.looseObject({
  date: z.string().regex(DATE_ONLY).optional(),
  dateTime: z.string().optional(),
});

const calendarEvent = z.looseObject({
  // Every one of these arrives as `""` from some integration or other, which
  // is a value meaning "nothing" rather than a value that fails a minimum.
  uid: blankIsAbsent(),
  summary: z.string().min(1),
  location: blankIsAbsent(),
  recurrence_id: blankIsAbsent(),
  start: endpointShape,
  end: endpointShape,
});

/**
 * One endpoint of an event, as an instant.
 *
 * Two shapes, exactly as ICS has two: `date` for an all-day boundary, which is
 * a local midnight and has to be anchored in the household's zone, and
 * `dateTime` for an instant, which carries its own offset and does not.
 */
function endpoint(
  value: z.infer<typeof endpointShape>,
  timezone: string,
): { ms: number; allDay: boolean } | undefined {
  if (value.date !== undefined) {
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

  if (value.dateTime !== undefined) {
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
  const events: NormalizedEvent[] = [];
  let index = 0;

  for (const raw of parseJsonOr(z.array(z.unknown()).catch([]), input.body, [])) {
    index++;
    const shaped = calendarEvent.safeParse(raw);
    if (!shaped.success) continue;
    const entry = shaped.data;

    const start = endpoint(entry.start, input.timezone);
    const end = endpoint(entry.end, input.timezone);
    if (start === undefined || end === undefined) continue;

    const title = entry.summary;

    /*
     * A uid, invented if Home Assistant did not supply one.
     *
     * Several integrations answer with no `uid` at all. The row id is built
     * from the uid, so two events with no uid on the same source would collide
     * and one would silently vanish — falling back to the position keeps them
     * distinct, and keeps it stable across a re-fetch of an unchanged
     * calendar, which is the property that matters.
     */
    const uid = entry.uid ?? `${input.entityId}#${index}@maverick-wall`;
    const recurrenceId = entry.recurrence_id;

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
      ...(entry.location !== undefined ? { location: entry.location } : {}),
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
