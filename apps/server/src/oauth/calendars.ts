import { FETCH_LIMITS, type Fetcher, type FetchOutcome } from '@maverick-wall/core';
import { zonedWallClockToUtcMs, type NormalizedEvent } from '@maverick-wall/calendar';
import { DEFAULT_USER_AGENT } from '../net/fetcher.js';
import { parseJsonOr, z } from '../validation.js';
import type { OAuthEndpoints, OAuthProvider } from './endpoints.js';

/**
 * Reading a signed-in account's calendars (plan item M5.11): which calendars
 * it has, and one calendar's events over the sync window.
 *
 * **The provider expands recurrence, and that is a decision rather than a
 * shortcut.** CalDAV refuses server-side expansion (`<C:expand>`), because a
 * CalDAV server is somebody's implementation of a standard and its expansion
 * can put a birthday on a different day from the household's own app. Here
 * the provider *is* the household's own app: Google Calendar's
 * `singleEvents=true` and Outlook's `calendarView` are exactly the occurrences
 * those apps draw, with a timed event as an instant carrying its offset and an
 * all-day one as a date. Rebuilding an RRULE out of Outlook's own recurrence
 * objects to expand it a second time would be the way to disagree with them.
 *
 * GETs only, through the SSRF-guarded fetcher, to the addresses
 * `OAuthEndpoints` names; a page link the provider hands back is followed only
 * if it is on that same origin.
 */

/** A calendar the account can read, as the picker offers it. */
export interface RemoteCalendar {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
}

export type CalendarsResult =
  | { readonly ok: true; readonly calendars: readonly RemoteCalendar[] }
  | { readonly ok: false; readonly status?: number; readonly message: string };

export type EventsResult =
  | { readonly ok: true; readonly events: readonly NormalizedEvent[] }
  | { readonly ok: false; readonly status?: number; readonly message: string };

/** More than this many occurrences in the window is a calendar this version will not draw whole, so it says so. */
export const MAX_EVENTS = 5000;
const MAX_PAGES = 20;

async function get(fetcher: Fetcher, endpoints: OAuthEndpoints, url: string, token: string, extra: Record<string, string> = {}): Promise<FetchOutcome> {
  return fetcher.fetch({
    url,
    policy: endpoints.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: 20_000,
    acceptContentTypes: ['application/json'],
    userAgent: DEFAULT_USER_AGENT,
    headers: { authorization: `Bearer ${token}`, ...extra },
  });
}

function failed(provider: OAuthProvider, outcome: FetchOutcome): { ok: false; status?: number; message: string } {
  const name = provider === 'google' ? 'Google' : 'Microsoft';
  if (outcome.status === 'failed' && outcome.code === 'http-error') {
    const status = outcome.httpStatus ?? 0;
    if (status === 401) return { ok: false, status, message: `${name} did not accept the sign-in. It will be tried again.` };
    if (status === 403) {
      return {
        ok: false,
        status,
        message: `${name} refused to share that calendar. Sign in again on the Calendars screen and allow calendar access.`,
      };
    }
    if (status === 404) return { ok: false, status, message: `That calendar is not in the ${name} account any more.` };
    if (status === 429) return { ok: false, status, message: `${name} asked for a pause. It will be tried again.` };
    return { ok: false, status, message: `${name} refused it (${status}). It will be tried again.` };
  }
  return { ok: false, message: `Could not reach ${name}. It will be tried again.` };
}

/** A next-page link, followed only on the origin its first page came from. */
function sameOrigin(link: string, base: string): boolean {
  try {
    return new URL(link).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** A local calendar date's midnight in the household's zone: the anchor every all-day boundary takes. */
function midnight(date: string, timezone: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return undefined;
  return zonedWallClockToUtcMs(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0 },
    timezone,
  );
}

// --- Google ---------------------------------------------------------------

const googleList = z.object({
  items: z.array(z.unknown()).catch([]),
  nextPageToken: z.string().max(2000).optional().catch(undefined),
});
const googleCalendar = z.object({
  id: z.string().min(1).max(500),
  summary: z.string().max(500).optional().catch(undefined),
  summaryOverride: z.string().max(500).optional().catch(undefined),
  primary: z.boolean().optional().catch(undefined),
});

export async function listGoogleCalendars(fetcher: Fetcher, endpoints: OAuthEndpoints, token: string): Promise<CalendarsResult> {
  const calendars: RemoteCalendar[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250' });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const outcome = await get(fetcher, endpoints, `${endpoints.googleApi}/users/me/calendarList?${params.toString()}`, token);
    if (outcome.status !== 'ok') return failed('google', outcome);
    const list = parseJsonOr(googleList, outcome.body, { items: [], nextPageToken: undefined });
    for (const item of list.items) {
      const one = googleCalendar.safeParse(item);
      if (!one.success) continue;
      calendars.push({
        id: one.data.id,
        name: one.data.summaryOverride ?? one.data.summary ?? one.data.id,
        primary: one.data.primary === true,
      });
    }
    pageToken = list.nextPageToken;
    if (pageToken === undefined) break;
  }
  return { ok: true, calendars };
}

const googleTime = z.object({
  date: z.string().max(20).optional().catch(undefined),
  dateTime: z.string().max(40).optional().catch(undefined),
});
const googleEvent = z.object({
  id: z.string().min(1).max(1024),
  status: z.string().max(40).optional().catch(undefined),
  summary: z.string().max(2000).optional().catch(undefined),
  location: z.string().max(2000).optional().catch(undefined),
  start: googleTime,
  end: googleTime,
  recurringEventId: z.string().max(1024).optional().catch(undefined),
});

/** Read one page of Google's events into occurrences; a malformed one costs itself. */
export function parseGoogleEvents(body: string, timezone: string): { events: NormalizedEvent[]; nextPageToken?: string } {
  const list = parseJsonOr(googleList, body, { items: [], nextPageToken: undefined });
  const events: NormalizedEvent[] = [];
  for (const item of list.items) {
    const shaped = googleEvent.safeParse(item);
    if (!shaped.success) continue;
    const event = shaped.data;
    // Cancelled occurrences of a series still arrive; they are not on.
    if (event.status === 'cancelled') continue;
    const allDay = event.start.date !== undefined;
    const start = allDay ? midnight(event.start.date ?? '', timezone) : Date.parse(event.start.dateTime ?? '');
    const end = allDay ? midnight(event.end.date ?? '', timezone) : Date.parse(event.end.dateTime ?? '');
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    events.push({
      // Unique per occurrence: with `singleEvents=true` an instance's id is
      // its series' id and its start, so the row id is stable across syncs.
      uid: event.id,
      title: event.summary ?? '(No title)',
      startUtc: new Date(start),
      // Exclusive, as ICS's DTEND is; never before the start.
      endUtc: new Date(Math.max(start, end)),
      allDay,
      sourceTzid: timezone,
      ...(event.location === undefined || event.location === '' ? {} : { location: event.location }),
      status: event.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
      isRecurringInstance: event.recurringEventId !== undefined,
    });
  }
  return { events, ...(list.nextPageToken === undefined ? {} : { nextPageToken: list.nextPageToken }) };
}

export async function googleEvents(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  token: string,
  calendarId: string,
  window: { readonly from: Date; readonly to: Date; readonly timezone: string },
): Promise<EventsResult> {
  const events: NormalizedEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      singleEvents: 'true',
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      maxResults: '2500',
      orderBy: 'startTime',
    });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const outcome = await get(
      fetcher,
      endpoints,
      `${endpoints.googleApi}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      token,
    );
    if (outcome.status !== 'ok') return failed('google', outcome);
    const read = parseGoogleEvents(outcome.body, window.timezone);
    events.push(...read.events);
    if (events.length > MAX_EVENTS) {
      return { ok: false, message: `That calendar has more than ${MAX_EVENTS} events in six months, more than a wall reads.` };
    }
    pageToken = read.nextPageToken;
    if (pageToken === undefined) break;
  }
  return { ok: true, events };
}

// --- Microsoft ------------------------------------------------------------

const graphList = z.object({
  value: z.array(z.unknown()).catch([]),
  '@odata.nextLink': z.string().max(4000).optional().catch(undefined),
});
const graphCalendar = z.object({
  id: z.string().min(1).max(1024),
  name: z.string().max(500).optional().catch(undefined),
  isDefaultCalendar: z.boolean().optional().catch(undefined),
});

export async function listMicrosoftCalendars(fetcher: Fetcher, endpoints: OAuthEndpoints, token: string): Promise<CalendarsResult> {
  const calendars: RemoteCalendar[] = [];
  let url: string | undefined = `${endpoints.graph}/me/calendars?$select=id,name,isDefaultCalendar&$top=100`;
  for (let page = 0; page < MAX_PAGES && url !== undefined; page++) {
    const outcome = await get(fetcher, endpoints, url, token);
    if (outcome.status !== 'ok') return failed('microsoft', outcome);
    const list = parseJsonOr(graphList, outcome.body, { value: [], '@odata.nextLink': undefined });
    for (const item of list.value) {
      const one = graphCalendar.safeParse(item);
      if (one.success) {
        calendars.push({ id: one.data.id, name: one.data.name ?? 'Calendar', primary: one.data.isDefaultCalendar === true });
      }
    }
    const next = list['@odata.nextLink'];
    url = next !== undefined && sameOrigin(next, endpoints.graph) ? next : undefined;
  }
  return { ok: true, calendars };
}

const graphTime = z.object({ dateTime: z.string().max(40), timeZone: z.string().max(100).optional().catch(undefined) });
const graphEvent = z.object({
  id: z.string().min(1).max(1024),
  subject: z.string().max(2000).nullish().catch(undefined),
  start: graphTime,
  end: graphTime,
  isAllDay: z.boolean().optional().catch(undefined),
  isCancelled: z.boolean().optional().catch(undefined),
  showAs: z.string().max(40).optional().catch(undefined),
  type: z.string().max(40).optional().catch(undefined),
  location: z.object({ displayName: z.string().max(2000).nullish().catch(undefined) }).nullish().catch(undefined),
});

/**
 * Graph's date-and-time, asked for in UTC (`Prefer: outlook.timezone`), as an
 * instant. Graph writes it with no offset — `2026-10-07T09:00:00.0000000` —
 * and the request is what makes it UTC.
 */
function graphInstant(value: string): number {
  return Date.parse(`${value.slice(0, 23)}Z`);
}

/**
 * An all-day boundary's calendar date.
 *
 * Outlook keeps an all-day event as midnight in a zone, and asked for in UTC
 * a midnight comes back either as itself or converted. Itself is the date.
 * Converted, it is that zone's midnight read in UTC — up to fourteen hours
 * either side — and the nearest UTC midnight is the date for every zone
 * within twelve hours of UTC. **Unproven against a real account**: which of
 * the two Graph does is not stated in its documentation, so both are read.
 */
function graphDate(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}T00:00:00/.test(value)) return value.slice(0, 10);
  const at = graphInstant(value);
  if (!Number.isFinite(at)) return undefined;
  return new Date(Math.round(at / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

/** Read one page of Outlook's occurrences; a malformed one costs itself. */
export function parseGraphEvents(body: string, timezone: string): { events: NormalizedEvent[]; nextLink?: string } {
  const list = parseJsonOr(graphList, body, { value: [], '@odata.nextLink': undefined });
  const events: NormalizedEvent[] = [];
  for (const item of list.value) {
    const shaped = graphEvent.safeParse(item);
    if (!shaped.success) continue;
    const event = shaped.data;
    if (event.isCancelled === true) continue;
    const allDay = event.isAllDay === true;
    const startDate = allDay ? graphDate(event.start.dateTime) : undefined;
    const endDate = allDay ? graphDate(event.end.dateTime) : undefined;
    const start = allDay ? (startDate === undefined ? undefined : midnight(startDate, timezone)) : graphInstant(event.start.dateTime);
    const end = allDay ? (endDate === undefined ? undefined : midnight(endDate, timezone)) : graphInstant(event.end.dateTime);
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const location = event.location?.displayName ?? undefined;
    events.push({
      // Unique per occurrence in a calendar view: an occurrence of a series
      // carries an id of its own.
      uid: event.id,
      title: event.subject === undefined || event.subject === null || event.subject === '' ? '(No title)' : event.subject,
      startUtc: new Date(start),
      endUtc: new Date(Math.max(start, end)),
      allDay,
      sourceTzid: timezone,
      ...(location === undefined || location === '' ? {} : { location }),
      status: event.showAs === 'tentative' ? 'TENTATIVE' : 'CONFIRMED',
      isRecurringInstance: event.type === 'occurrence' || event.type === 'exception',
    });
  }
  const next = list['@odata.nextLink'];
  return { events, ...(next === undefined ? {} : { nextLink: next }) };
}

export async function microsoftEvents(
  fetcher: Fetcher,
  endpoints: OAuthEndpoints,
  token: string,
  calendarId: string,
  window: { readonly from: Date; readonly to: Date; readonly timezone: string },
): Promise<EventsResult> {
  const events: NormalizedEvent[] = [];
  const params = new URLSearchParams({
    startDateTime: window.from.toISOString(),
    endDateTime: window.to.toISOString(),
    $select: 'id,subject,start,end,isAllDay,isCancelled,showAs,type,location',
    $top: '500',
  });
  let url: string | undefined = `${endpoints.graph}/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params.toString()}`;
  for (let page = 0; page < MAX_PAGES && url !== undefined; page++) {
    const outcome = await get(fetcher, endpoints, url, token, { prefer: 'outlook.timezone="UTC"' });
    if (outcome.status !== 'ok') return failed('microsoft', outcome);
    const read = parseGraphEvents(outcome.body, window.timezone);
    events.push(...read.events);
    if (events.length > MAX_EVENTS) {
      return { ok: false, message: `That calendar has more than ${MAX_EVENTS} events in six months, more than a wall reads.` };
    }
    url = read.nextLink !== undefined && sameOrigin(read.nextLink, endpoints.graph) ? read.nextLink : undefined;
  }
  return { ok: true, events };
}
