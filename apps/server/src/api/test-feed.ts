import { expandCalendar } from '@maverick-wall/calendar';
import { analyseTitles, FETCH_LIMITS, requiredNetworkOptions, validateOutboundUrl, type Fetcher, type NetworkOption, type TitleObservation } from '@maverick-wall/core';

/**
 * Try a calendar URL before anything is saved.
 *
 * The single most valuable thing in the admin interface. Somebody pasting a
 * feed URL has no way to know whether they copied the right one — Google offers
 * a public HTML link and a secret iCal link side by side, and only one of them
 * works. Without this they save it, see nothing on the wall an hour later, and
 * have no idea which of a dozen things went wrong.
 *
 * So: fetch it, parse it, and show them their own events. If their calendar
 * comes back, it is right. Nothing else needs explaining.
 */

const ICS_CONTENT_TYPES = ['text/calendar', 'application/octet-stream', 'text/plain'];
const PREVIEW_COUNT = 5;

export interface TestFeedRequest {
  readonly url: string;
  readonly allowPrivateNetwork?: boolean;
  /** Separate from the LAN toggle. See the schema for why. */
  readonly allowLoopback?: boolean;
  readonly allowHttp?: boolean;
  readonly timezone: string;
}

export interface TestFeedEvent {
  readonly title: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: boolean;
  readonly location?: string;
}

export type TestFeedResult =
  | {
      readonly ok: true;
      readonly calendarName?: string;
      /** Host only. The path is a credential and never leaves the server. */
      readonly host: string;
      readonly byteSize: number;
      readonly totalEvents: number;
      readonly preview: readonly TestFeedEvent[];
      /** Titles that look like a work schedule, for the shift screen. */
      readonly shiftCandidates: readonly {
        readonly title: string;
        readonly confidence: string;
        readonly suggestedShiftKey: string | null | undefined;
        readonly reason: string;
      }[];
      /** Non-fatal parsing complaints worth showing. */
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly stage: 'url' | 'fetch' | 'parse';
      readonly message: string;
      /** Something the person can actually do. Absent when there is nothing. */
      readonly suggestion?: string;
      /**
       * Every network opt-in this address still needs, evaluated together.
       *
       * The guard stops at the first rule that refuses, which made adding a
       * loopback http feed a three-round conversation — one switch revealed
       * per submission. A form gets the whole answer here and can say it once,
       * with the controls in view. Empty means no switch would help; it never
       * means the address was acceptable.
       */
      readonly networkOptions: readonly NetworkOption[];
    };

/**
 * Turn a failure into advice.
 *
 * Every branch here corresponds to a mistake somebody actually makes. A message
 * that only names the error leaves them stuck; one that names the fix does not.
 *
 * **Nothing here may name a control.** This module is one layer below the forms
 * and does not know what any switch is called, so the five branches that used to
 * try were wrong in all three directions at once: `bare-hostname`,
 * `loopback-name` and a LAN `ip-literal` never reached here at all (an opt-in
 * exists for each, so `networkOptions` is never empty for them and the
 * aggregate wins); `internal-suffix` and a *public* `ip-literal` did reach here
 * and told the household to turn on local-network access, which opens neither;
 * and all five quoted labels — "allow local network", "allow loopback" — that
 * have never appeared on a checkbox anywhere in the product. The sentence that
 * names a switch is composed in `http/html.ts` from the table that renders it.
 */
function suggestionFor(code: string): string | undefined {
  switch (code) {
    case 'internal-suffix':
      // The one local-network code with a remedy worth stating, and it is not a
      // switch: these suffixes are refused under *every* policy, so the address
      // itself has to change. It names no control, and is therefore true on the
      // Home Assistant screen as well as on this one. The message beside it
      // already names the suffix, so this does not repeat it.
      return 'That kind of name is resolved by the device you are browsing from rather than by this server. Use the numeric address of the machine instead.';
    case 'reserved-name':
      // No suggestion here on purpose: unlike .local above, there is no other
      // address to reach for — one of these never resolves to anything.
      return undefined;
    case 'userinfo-present':
      return 'Remove the username and password from the address.';
    case 'unacceptable-content-type':
      return 'That address returned a web page rather than a calendar. In Google Calendar, use "Secret address in iCal format" — it ends in .ics';
    case 'dns-failed':
      return 'Check the address for typos, and that this machine can reach the internet.';
    case 'address-rejected':
      return 'The name resolves somewhere we will not fetch from.';
    case 'timeout':
      return 'The server did not answer in time. It may be temporarily down.';
    case 'network-error':
      return 'Check the address — the port especially — and that the calendar server is running and reachable from this machine.';
    case 'too-large':
      return 'That calendar is larger than we will download. Try a feed with a narrower date range.';
    case 'PARSE_FAILED':
      return 'The address responded, but not with a calendar. Check it is the iCal link rather than a web page.';
    default:
      return undefined;
  }
}

export async function testFeed(
  request: TestFeedRequest,
  fetcher: Fetcher,
): Promise<TestFeedResult> {
  const policy = {
    ...(request.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    ...(request.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(request.allowHttp === true ? { allowHttp: true } : {}),
  };

  const validated = validateOutboundUrl(request.url, policy);
  if (!validated.ok) {
    /*
     * The aggregate wins where it has anything to say. Two remedies for one
     * refusal is one too many, and the per-code suggestion is the narrower of
     * them — it names the first rule that refused, and for a loopback address
     * literal it named the wrong control entirely.
     */
    const networkOptions = requiredNetworkOptions(request.url, policy);
    const suggestion = networkOptions.length > 0 ? undefined : suggestionFor(validated.error.code);
    return {
      ok: false,
      stage: 'url',
      message: validated.error.message,
      ...(suggestion !== undefined ? { suggestion } : {}),
      networkOptions,
    };
  }

  const response = await fetcher.fetch({
    url: request.url,
    policy,
    maxBytes: FETCH_LIMITS.ics,
    acceptContentTypes: ICS_CONTENT_TYPES,
    // Shorter than a background sync. Somebody is watching a spinner.
    timeoutMs: 15_000,
  });

  if (response.status === 'rejected' || response.status === 'failed') {
    // Only the resolver knows a public-looking name landed on a LAN address,
    // so the answer comes from the outcome rather than from the URL.
    const networkOptions =
      response.status === 'rejected' ? (response.networkOptions ?? []) : [];
    const suggestion = networkOptions.length > 0 ? undefined : suggestionFor(response.code);
    return {
      ok: false,
      stage: 'fetch',
      message: response.message,
      ...(suggestion !== undefined ? { suggestion } : {}),
      networkOptions,
    };
  }

  if (response.status === 'not-modified') {
    // No conditional headers were sent, so this should not happen.
    return {
      ok: false,
      stage: 'fetch',
      message: 'The server returned no content.',
      networkOptions: [],
    };
  }

  const now = Date.now();
  const expanded = expandCalendar({
    icsText: response.body,
    targetTimezone: request.timezone,
    windowStart: new Date(now - 7 * 86_400_000),
    windowEnd: new Date(now + 90 * 86_400_000),
    maxEvents: 5000,
  });

  if (!expanded.ok) {
    const suggestion = suggestionFor(expanded.error.code);
    return {
      ok: false,
      stage: 'parse',
      message: expanded.error.detail
        ? `${expanded.error.message} (${expanded.error.detail})`
        : expanded.error.message,
      ...(suggestion !== undefined ? { suggestion } : {}),
      networkOptions: [],
    };
  }

  // Events from now onward, which is what somebody checking their calendar
  // expects to recognise. Showing last week's would be technically correct and
  // useless.
  const upcoming = expanded.value.filter((event) => event.endUtc.getTime() >= now);

  const observations: TitleObservation[] = expanded.value.map((event) => {
    const startDate = event.startUtc.toISOString().slice(0, 10);
    return event.allDay
      ? { title: event.title, dates: [startDate], allDay: true }
      : {
          title: event.title,
          dates: [startDate],
          allDay: false,
          startTime: event.startUtc.toISOString().slice(11, 16),
        };
  });

  const candidates = analyseTitles({ observations, windowDays: 97 })
    .filter((candidate) => candidate.confidence !== 'unlikely')
    .slice(0, 12);

  return {
    ok: true,
    ...(expanded.meta.calendarName !== undefined
      ? { calendarName: expanded.meta.calendarName }
      : {}),
    host: validated.value.hostname,
    byteSize: response.byteSize,
    totalEvents: expanded.value.length,
    preview: upcoming.slice(0, PREVIEW_COUNT).map((event) => ({
      title: event.title,
      startsAt: event.startUtc.getTime(),
      endsAt: event.endUtc.getTime(),
      allDay: event.allDay,
      ...(event.location !== undefined ? { location: event.location } : {}),
    })),
    shiftCandidates: candidates.map((candidate) => ({
      title: candidate.title,
      confidence: candidate.confidence,
      suggestedShiftKey: candidate.suggestedShiftKey,
      reason: candidate.reason,
    })),
    warnings: expanded.meta.warnings.slice(0, 5).map((warning) => warning.message),
  };
}
