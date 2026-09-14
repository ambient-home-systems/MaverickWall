import {
  CALDAV_NS,
  DAV_NS,
  prop,
  readMultistatus,
  type MultistatusError,
} from './multistatus.js';

/**
 * The `calendar-query` REPORT, and what comes back out of it.
 *
 * Two things here are decisions rather than plumbing and both are RFC 013 §6.4
 * and §6.5.
 *
 * **There is no `<C:expand>` in this template and there must never be one.**
 * CalDAV's `calendar-data` accepts an element asking the *server* to expand
 * recurrences, and both iCloud and SabreDAV support it. It is tempting: it
 * would make this path as cheap as the Home Assistant one. Refuse it.
 * `packages/calendar` is this repository's most heavily tested package and
 * every rule in it is a decision a provider's expander makes differently —
 * recurrence computed on wall-clock and then anchored, `DTEND` exclusive, zones
 * from `Intl` rather than from a feed's own stale VTIMEZONE. Accepting server
 * expansion means a household's birthday lands on a different day depending on
 * which provider they use, and the one tested recurrence engine in this
 * repository stops being on the path. The time-range filter is a different
 * matter and is used: it cuts which *resources* come back without touching how
 * they are interpreted.
 *
 * **One resource per event is a feature, not a workaround.** In CalDAV each
 * resource is a complete `VCALENDAR` holding the master `VEVENT` and its
 * `RECURRENCE-ID` overrides together, so `expandCalendar` is called once per
 * resource rather than once per feed. The first row of CLAUDE.md's bug table is
 * "one malformed event killed a whole feed"; per-resource parsing makes that
 * structurally impossible here — one bad resource costs one event.
 *
 * The body is a **module constant with one interpolation**, and that
 * interpolation is a timestamp this process formatted from a `Date`. Nothing
 * household-authored reaches it, which is the sentence `FetchRequest.method`
 * hangs its whole widening on.
 */

/** A resource as it came back: an href, its ETag, and a whole `VCALENDAR`. */
export interface CalendarResource {
  /** The collection-relative or absolute href the server wrote. */
  readonly href: string;
  /** `DAV:getetag`, when the server sent one. The per-resource change marker. */
  readonly etag?: string;
  /**
   * The `VCALENDAR`, byte for byte as it arrived — CRLF and folding intact,
   * because ICS folding lands on exact octet boundaries and unfolding is
   * `packages/calendar`'s job rather than this file's.
   */
  readonly calendarData: string;
}

export type CalendarQueryResult =
  | { readonly ok: true; readonly resources: readonly CalendarResource[] }
  | { readonly ok: false; readonly error: MultistatusError };

/**
 * RFC 3339 in the basic UTC form a `time-range` wants: `20260301T000000Z`.
 *
 * Written out rather than sliced off `toISOString()`, because that is one
 * `replace` away from emitting the extended form a server is entitled to
 * refuse, and a refused REPORT is an empty calendar rather than an error
 * anybody sees.
 */
function icalUtc(when: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(when.getUTCFullYear(), 4)}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}` +
    `T${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}Z`
  );
}

/**
 * The REPORT body for one window.
 *
 * `VEVENT` only, deliberately: a household's shopping list is a `VTODO`
 * collection and RFC 012's to-do lists are how this product reads one. A
 * calendar widget asking for tasks would draw them as events.
 */
export function calendarQueryBody(windowStart: Date, windowEnd: Date): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\n` +
    `  <D:prop>\n` +
    `    <D:getetag/>\n` +
    // No `<C:expand>`. See this module's docstring; `caldav-query.test.ts`
    // asserts the absence rather than trusting the comment.
    `    <C:calendar-data/>\n` +
    `  </D:prop>\n` +
    `  <C:filter>\n` +
    `    <C:comp-filter name="VCALENDAR">\n` +
    `      <C:comp-filter name="VEVENT">\n` +
    `        <C:time-range start="${icalUtc(windowStart)}" end="${icalUtc(windowEnd)}"/>\n` +
    `      </C:comp-filter>\n` +
    `    </C:comp-filter>\n` +
    `  </C:filter>\n` +
    `</C:calendar-query>\n`
  );
}

/** The `PROPFIND` that asks a collection whether anything in it has changed. */
export const CTAG_BODY =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">\n` +
  `  <D:prop>\n` +
  `    <CS:getctag/>\n` +
  `  </D:prop>\n` +
  `</D:propfind>\n`;

/**
 * Split a `multistatus` into one `VCALENDAR` per resource.
 *
 * A response with no `calendar-data` is **skipped rather than refused**: the
 * collection itself appears in some servers' answers, and a resource the server
 * answered 404 for one property of is not a reason to lose the other fifty
 * events. The caller then expands each string on its own, which is where §6.5's
 * isolation actually happens — this function only makes it possible.
 */
export function splitCalendarData(xml: string): CalendarQueryResult {
  const document = readMultistatus(xml);
  if (!document.ok) return document;

  const resources: CalendarResource[] = [];
  for (const response of document.responses) {
    const data = prop(response, CALDAV_NS, 'calendar-data');
    // `raw` rather than `text`: `text` is trimmed, and a trimmed ICS has lost
    // its final CRLF. Absent when the element had children, which a
    // `calendar-data` never does.
    const body = data?.raw;
    if (body === undefined || body.trim() === '') continue;

    const etag = prop(response, DAV_NS, 'getetag')?.text;
    resources.push({
      href: response.href,
      ...(etag !== undefined && etag !== '' ? { etag } : {}),
      calendarData: body,
    });
  }

  return { ok: true, resources };
}
