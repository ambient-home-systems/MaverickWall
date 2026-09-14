import { expandCalendar } from '@maverick-wall/calendar';
import { analyseTitles, FETCH_LIMITS, requiredNetworkOptions, validateOutboundUrl, type Fetcher, type NetworkOption, type TitleObservation, type UrlPolicy } from '@maverick-wall/core';
import { discover, type DiscoverFailureCode } from '../caldav/discover.js';
import { connectionFor } from './feed-credentials.js';

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
  /**
   * The account to sign in as, when the household has given one.
   *
   * In clear, and only for the length of this request: nothing is stored yet —
   * the whole point of this screen is answering "does this work" before a row
   * exists — so there is no envelope to open and nothing here writes one.
   */
  readonly username?: string;
  readonly password?: string;
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
      /**
       * Which question failed, and the fourth one is the whole value of §6.7.
       *
       * `discover` is CalDAV's, and it exists because *the address is fine and
       * the password is wrong* is a completely different sentence from *you are
       * signed in and that account has no calendars*, and both are different
       * again from *that address is not a CalDAV server*. Collapsing them into
       * "could not connect" would reduce the best screen in the admin to the
       * worst kind of error.
       *
       * It is the same failure *shape* as the other three deliberately, so the
       * admin's error rendering is reused rather than copied: one `errorBlock`,
       * one suggestion slot, one `networkOptions` list.
       */
      readonly stage: 'url' | 'fetch' | 'parse' | 'discover';
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
 *
 * **Two branches now point at the username and password fields, and that is a
 * narrowing of the rule rather than a hole in it.** They name *what is being
 * asked for* — "where the calendar's username and password are asked for
 * below" — rather than a label on a control, which is the thing this module
 * cannot know. Every form that reaches here draws those two fields, which is
 * what makes the sentence true wherever it is read; a `<label>`'s wording is
 * still nothing this file has an opinion about.
 */
function suggestionFor(code: string, sentCredentials = false): string | undefined {
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
      /*
       * The refusal stays and the remedy changes (RFC 013 §4.3).
       *
       * `validateOutboundUrl` still refuses `https://me:pw@host/…` for both of
       * the reasons written at the check — storing it is a bad idea, and
       * `user@host` is a parser-confusion trick where the part a person reads
       * as the host is the username. What stopped being true the day a feed
       * could carry a credential is the old sentence's *implication*: it told
       * somebody holding a Nextcloud app password that this product had
       * nowhere to put it.
       */
      return 'Remove the username and password from the address, and enter them where the calendar’s username and password are asked for below.';
    case 'unacceptable-content-type':
      /*
       * A web page in place of a calendar meant exactly one thing — the wrong
       * of Google's two links — until a feed could be credentialed. Now it
       * means a second thing at least as often: a server answering an
       * unauthenticated GET with an HTML sign-in page rather than with a bare
       * 401. Which sentence is the likely one depends on whether this attempt
       * signed in, so the second clause is offered only when it did not; with
       * a credential already supplied, Google's link is the better guess and
       * the sentence is left exactly as it was.
       */
      return sentCredentials
        ? 'That address returned a web page rather than a calendar. In Google Calendar, use "Secret address in iCal format" — it ends in .ics'
        : 'That address returned a web page rather than a calendar. In Google Calendar, use "Secret address in iCal format" — it ends in .ics. Or, if this calendar needs a username and password, enter them below.';
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

/**
 * A 401 or a 403 has three different causes and three different fixes
 * (RFC 013 §4.4).
 *
 * The one thing to get wrong here is reporting all three as "that password was
 * not accepted", which turns the best screen in the admin into a shrug: it is
 * the correct sentence for exactly one of them, and for the other two the
 * action it names does nothing.
 *
 * The decision is taken from **what the request carried**, never from what the
 * household typed. Those are not the same thing — a username with no password
 * beside it composes no header at all (`connectionFor`), so a form with a name
 * in it and the password field empty is a request that signed in as nobody, and
 * telling that household their password was rejected would be a sentence about
 * a field they have not filled in yet.
 */
function signInSuggestion(
  response: { readonly code: string; readonly httpStatus?: number; readonly finalUrl?: string; readonly credentialsDropped?: boolean },
  sentCredentials: boolean,
): string | undefined {
  if (response.code !== 'http-error') return undefined;
  if (response.httpStatus !== 401 && response.httpStatus !== 403) return undefined;

  if (response.credentialsDropped) {
    /*
     * The third case, and the only one whose remedy is not about the password.
     *
     * The credential reached the first address and was taken off the hop that
     * followed, because credentials are scoped to the origin they were issued
     * for. Phase A has no confirmation flow to re-attach it — that is §6.3.1's
     * machinery, built for CalDAV — so the honest answer is to name where the
     * address went and let the household point at it directly.
     */
    const where = originOf(response.finalUrl);
    return where === undefined
      ? 'That address redirected somewhere else, and a password is not sent across a redirect. Use the address it redirected to.'
      : `The address redirected to ${where}, and the password is not sent there. Use that address instead.`;
  }

  return sentCredentials
    ? 'The username or password was not accepted. If this is a Nextcloud or similar server, an app password rather than the account password is usually what is wanted.'
    : 'This calendar needs a username and password; enter them below.';
}

/** The origin of a URL, for a sentence. Never the path, which is the credential. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export async function testFeed(
  request: TestFeedRequest,
  fetcher: Fetcher,
): Promise<TestFeedResult> {
  /*
   * The same resolver the sync job uses, with the password in clear rather
   * than in an envelope.
   *
   * That is the whole reason `connectionFor` takes a union: the bytes this
   * screen puts on the wire have to be the bytes the sync puts on the wire an
   * hour later, or a feed that tests green fails silently once it is stored —
   * which is precisely the failure `testFeed` exists to remove.
   */
  const connection = connectionFor({
    url: request.url,
    allowPrivateNetwork: request.allowPrivateNetwork === true,
    allowLoopback: request.allowLoopback === true,
    allowHttp: request.allowHttp === true,
    authUsername: request.username,
    authPassword: { typed: request.password },
  });
  const policy = connection.policy;
  /** Whether this attempt actually carried a credential, which is not the same as being given one. */
  const sentCredentials = connection.headers['authorization'] !== undefined;

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
    url: connection.url,
    policy,
    maxBytes: FETCH_LIMITS.ics,
    acceptContentTypes: ICS_CONTENT_TYPES,
    ...(sentCredentials ? { headers: connection.headers } : {}),
    // Shorter than a background sync. Somebody is watching a spinner.
    timeoutMs: 15_000,
  });

  if (response.status === 'rejected' || response.status === 'failed') {
    // Only the resolver knows a public-looking name landed on a LAN address,
    // so the answer comes from the outcome rather than from the URL.
    const networkOptions =
      response.status === 'rejected' ? (response.networkOptions ?? []) : [];
    const signIn =
      response.status === 'failed' ? signInSuggestion(response, sentCredentials) : undefined;
    const suggestion =
      networkOptions.length > 0
        ? undefined
        : (signIn ?? suggestionFor(response.code, sentCredentials));
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

/**
 * Trying a CalDAV account before anything is saved (RFC 013 §6.7).
 *
 * `testFeed`'s job one protocol along, and the same argument for it: somebody
 * typing `caldav.icloud.com` and an app-specific password has no way to know
 * whether they copied the password right, whether two-factor got in the way, or
 * whether the address is even a CalDAV server. Running the discovery and
 * showing them their own calendar *names* answers all of that before a row
 * exists.
 *
 * **It answers a picker rather than a preview**, which is the step the ICS path
 * does not have: a CalDAV account has several calendars and the household has
 * to choose. That is closer to the Home Assistant calendar-entity flow than to
 * pasting a URL, and the screen reuses that shape rather than inventing one.
 *
 * Nothing here stores anything, exactly as `testFeed` stores nothing — the
 * password is in clear for the length of one request and is handed to
 * `discover`, which is the only thing that puts it on a wire.
 */
export interface TestCaldavRequest {
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
  readonly allowPrivateNetwork?: boolean;
  readonly allowLoopback?: boolean;
  readonly allowHttp?: boolean;
  /** A host the household has already been shown and accepted (§6.3.1). */
  readonly confirmedHost?: string | null;
}

export interface TestCaldavCalendar {
  readonly url: string;
  readonly displayName: string;
  readonly ctag?: string;
}

export type TestCaldavResult =
  | {
      readonly ok: true;
      /** The host the calendars actually live on, which may not be the typed one. */
      readonly host: string;
      readonly principalUrl: string;
      readonly homeSetUrl: string;
      /** What the household picks from. Never empty — that is its own sentence. */
      readonly calendars: readonly TestCaldavCalendar[];
    }
  /**
   * Not a failure: a **question**, and it has its own arm because it is neither
   * ok nor wrong (§6.3.1).
   *
   * Discovery wants to leave the host the household typed, and the credential
   * has not been sent there. The caller names this host on a confirmation
   * screen and runs this again with it as `confirmedHost`. Filing it under
   * `ok: false` with a message would have made it an error somebody has to read
   * past, and every caller would need to tell it from a real one by matching on
   * the sentence.
   */
  | { readonly ok: false; readonly needsConfirmation: { readonly host: string } }
  | {
      readonly ok: false;
      readonly needsConfirmation?: undefined;
      readonly stage: 'url' | 'fetch' | 'parse' | 'discover';
      readonly message: string;
      readonly suggestion?: string;
      readonly networkOptions: readonly NetworkOption[];
    };

/**
 * The four sentences §6.7 names, mapped from `discover`'s own outcome.
 *
 * Each one names a different next action, which is the entire reason the codes
 * are distinct in `discover` rather than being one `failed`. A suggestion that
 * names no control, per the rule at `suggestionFor`: this module is a layer
 * below the forms and does not know what any switch is called.
 */
function caldavSuggestion(code: DiscoverFailureCode): string | undefined {
  switch (code) {
    case 'not-caldav':
      return 'Check the address. For iCloud it is caldav.icloud.com, and for a self-hosted server it is usually the address you sign in to rather than a link to one calendar.';
    case 'unauthorized':
      return 'For iCloud this needs an app-specific password created at appleid.apple.com, not the Apple ID password itself. For Nextcloud and similar, an app password rather than the account password is usually what is wanted.';
    case 'no-calendars':
      return 'Check you signed in as the right account. A calendar somebody shared with you may need accepting in their app first.';
    case 'unreachable':
      return 'The server did not answer. It may be temporarily down, or the address may have a typo in it.';
    default:
      return undefined;
  }
}

export async function testCaldavAccount(
  request: TestCaldavRequest,
  fetcher: Fetcher,
): Promise<TestCaldavResult> {
  const policy: UrlPolicy = {
    ...(request.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    ...(request.allowLoopback === true ? { allowLoopback: true } : {}),
    ...(request.allowHttp === true ? { allowHttp: true } : {}),
  };

  /*
   * The address is checked here as well as inside the chain, and that is not a
   * duplicate: `validateOutboundUrl` is what produces `networkOptions`, which
   * is the aggregate answer a form needs to reveal every switch at once rather
   * than one per submission. `discover` refuses the same address a hop later
   * with a sentence that names no switch.
   */
  const validated = validateOutboundUrl(request.serverUrl, policy);
  if (!validated.ok) {
    const networkOptions = requiredNetworkOptions(request.serverUrl, policy);
    const suggestion = networkOptions.length > 0 ? undefined : suggestionFor(validated.error.code);
    return {
      ok: false,
      stage: 'url',
      message: validated.error.message,
      ...(suggestion !== undefined ? { suggestion } : {}),
      networkOptions,
    };
  }

  const result = await discover(fetcher, {
    serverUrl: request.serverUrl,
    username: request.username,
    password: request.password,
    policy,
    ...(request.confirmedHost === undefined ? {} : { confirmedHost: request.confirmedHost }),
    // Shorter than a background sync: somebody is watching a spinner, and this
    // is four round trips rather than one.
    timeoutMs: 15_000,
  });

  if (result.status === 'needs-confirmation') {
    return { ok: false, needsConfirmation: { host: result.host } };
  }

  if (result.status === 'failed') {
    /*
     * A refusal by the guard keeps the aggregate answer, exactly as the ICS
     * path does: the guard stops at the first rule that refuses, so a form
     * given one code at a time takes three submissions to add a loopback http
     * server.
     */
    const networkOptions =
      result.code === 'refused' ? requiredNetworkOptions(request.serverUrl, policy) : [];
    const suggestion = networkOptions.length > 0 ? undefined : caldavSuggestion(result.code);
    return {
      ok: false,
      // Everything past the address is `discover`'s own stage, which is the
      // distinction §6.7 is for; a bad address is still `url`, so the two
      // screens agree about what that word means.
      stage: result.code === 'bad-address' ? 'url' : 'discover',
      message: result.message,
      ...(suggestion !== undefined ? { suggestion } : {}),
      networkOptions,
    };
  }

  return {
    ok: true,
    // The host the calendars are actually on, which on iCloud is the partition
    // host rather than the one that was typed. It is what the account row
    // stores as `confirmedHost` when it differs.
    host: hostOf(result.homeSetUrl) ?? validated.value.hostname,
    principalUrl: result.principalUrl,
    homeSetUrl: result.homeSetUrl,
    calendars: result.calendars.map((calendar) => ({
      url: calendar.url,
      displayName: calendar.displayName,
      ...(calendar.ctag !== undefined ? { ctag: calendar.ctag } : {}),
    })),
  };
}

/** Host only, for a sentence and for the stored `confirmedHost`. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
