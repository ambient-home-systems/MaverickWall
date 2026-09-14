import { expandCalendar } from '@maverick-wall/calendar';
import {
  FETCH_LIMITS,
  type Fetcher,
  type JobHandler,
  type JobRecord,
  type JobResult,
} from '@maverick-wall/core';
import { accountForSource, recordAccountError } from '../api/caldav-accounts.js';
import { connectionFor } from '../api/feed-credentials.js';
import { decideHost } from '../caldav/host-policy.js';
import { CTAG_BODY, calendarQueryBody, splitCalendarData } from '../caldav/query.js';
import { CALENDARSERVER_NS, prop, readMultistatus } from '../caldav/multistatus.js';
import { createEventWriter, toEventRow, type EventRow } from './events.js';
import { AUTH_FAILURE_HOLD_SECONDS, WINDOW_AFTER_DAYS, WINDOW_BEFORE_DAYS, sourceIdFromJobKey } from './ics-sync.js';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Syncing one CalDAV collection (RFC 013 §6.4, §6.5, §6.6).
 *
 * `ics-sync` with a different way of getting the bytes, and its own kind for
 * the reason `ha-calendar-sync` has one: the CTag is per collection and one
 * failing calendar must not take three working ones into backoff with it. Only
 * *discovery* is per account, and it is cached on the account row, so this job
 * is two requests at most and usually one.
 *
 * **Every failure path leaves yesterday's events in place**, which is rule nine
 * and is the same promise `ics-sync` makes on every one of its branches. A
 * calendar that is unreachable, whose password stopped being accepted, or whose
 * server answered something unreadable must leave the wall showing the calendar
 * it already had with an explanation — never an empty grid.
 *
 * Two things here are decisions rather than plumbing.
 *
 * **`expandCalendar` runs once per resource**, which is §6.5 and is better than
 * what the ICS path can do. The first row of CLAUDE.md's bug table is "one
 * malformed event killed a whole feed"; in CalDAV each resource is a complete
 * `VCALENDAR` holding one series and its overrides, so a bad one costs one
 * event rather than the calendar. `caldav-sync.test.ts` puts a truncated
 * resource between two good ones and asserts exactly that, because the property
 * is worth nothing unless something would notice it going away.
 *
 * **The host policy runs here too, not only at add time.** A stored collection
 * href is an address a server chose, and a sync is a request carrying the
 * household's password to it — so it is asked the same question discovery asks,
 * against the same `confirmedHost`. Without it, a server that moved a household
 * onto a new partition host between adding and syncing would have the password
 * sent somewhere nobody was ever shown.
 */

const XML_TYPES = ['application/xml', 'text/xml'] as const;

/**
 * A working set, cut by the same window the ICS path uses.
 *
 * The `time-range` filter is the one part of `calendar-data` §6.4 permits,
 * because it decides which *resources* come back without touching how they are
 * interpreted. There is no `<C:expand>` and there must never be one: server-side
 * expansion takes `packages/calendar` off the path and makes a household's
 * birthday land on a different day depending on their provider.
 */
export interface CaldavSyncDeps {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  readonly timezone: () => string;
  readonly now?: () => number;
}

interface CaldavSourceRow {
  readonly id: string;
  readonly name: string;
  readonly urlEncrypted: string | null;
  readonly enabled: number;
  readonly etag: string | null;
  readonly caldavAccountId: string | null;
}

export function createCaldavSyncHandler(deps: CaldavSyncDeps): JobHandler {
  const now = deps.now ?? (() => Date.now());

  const selectSource = deps.db.prepare(
    `SELECT id, name, url_encrypted AS urlEncrypted, enabled, etag,
            caldav_account_id AS caldavAccountId
       FROM calendar_sources WHERE id = ?`,
  );

  const events = createEventWriter(deps.db, now);

  const fail = (sourceId: string, message: string, retryAfterSeconds?: number): JobResult => {
    events.recordFailure(sourceId, message);
    return retryAfterSeconds === undefined
      ? { status: 'failed', error: message }
      : { status: 'failed', error: message, retryAfterSeconds };
  };

  return async (job: JobRecord): Promise<JobResult> => {
    const sourceId = sourceIdFromJobKey(job.key);
    if (!sourceId) return { status: 'skipped', reason: 'job key carries no source id' };

    const source = selectSource.get(sourceId) as CaldavSourceRow | undefined;
    if (!source) return { status: 'skipped', reason: 'source no longer exists' };
    if (source.enabled === 0) return { status: 'skipped', reason: 'source is disabled' };
    if (source.urlEncrypted === null) {
      return { status: 'skipped', reason: 'source has no collection address' };
    }
    if (source.caldavAccountId === null) {
      // A job row that outlived a change of kind. Skipping rather than failing
      // is the right answer either way: this handler has no credential to sign
      // in with and must not mark the source as failing for it.
      return { status: 'skipped', reason: 'source has no CalDAV account' };
    }

    const opened = deps.keyring.decrypt(source.urlEncrypted, 'calendar-source-url');
    if (!opened.ok) {
      return fail(
        sourceId,
        'The stored address for this calendar could not be read. It was most ' +
          'likely restored from a backup without its encryption key, and needs ' +
          'entering again.',
      );
    }

    const account = accountForSource(deps.db, source.caldavAccountId);
    if (account === undefined) {
      // The account row went while this job was queued. The calendars are
      // deleted with it (`removeCaldavAccount`), so this is a race rather than a
      // state, and the cached events stay either way.
      return { status: 'skipped', reason: 'CalDAV account no longer exists' };
    }

    /*
     * Address, policy and credential from the one resolver, which for this kind
     * reads the account and for every other reads the row. Nothing here knows
     * which — that is §6.2.2's whole claim, and this call site is the evidence
     * for it: it is the same expression `ics-sync` uses.
     */
    const connection = connectionFor(
      {
        url: opened.value,
        allowPrivateNetwork: false,
        allowLoopback: false,
        allowHttp: false,
        authUsername: null,
        authPassword: { stored: null },
        account,
      },
      deps.keyring,
    );

    if (connection.passwordUnreadable) {
      return fail(
        sourceId,
        'The stored password for this CalDAV account could not be read. It was ' +
          'most likely restored from a backup without its encryption key. Enter ' +
          'it again on the Calendars page.',
      );
    }

    /*
     * The same rule discovery ran, on the address that was stored.
     *
     * `confirmedHost` is what makes this silent for iCloud after the household
     * has answered once, and `serverUrl` is not needed here: the collection href
     * either matches the host they confirmed or it matches nothing, and a stored
     * href on a third host is exactly the case worth stopping.
     */
    const decision = decideHost({
      typedUrl: connection.url,
      nextUrl: connection.url,
      confirmedHost: connection.confirmedHost,
    });
    if (decision.status === 'unreadable') {
      return fail(sourceId, 'The stored address for this calendar is not one we can read.');
    }

    const at = now();

    /*
     * §6.6 — one cheap PROPFIND that answers "has anything in this calendar
     * changed". The CTag lands in `etag`, which is the column that already
     * means exactly this one transport along, so the whole of §6.6 is no schema
     * change and no new concept.
     */
    const ctagResponse = await deps.fetcher.fetch({
      url: connection.url,
      policy: connection.policy,
      method: 'PROPFIND',
      body: CTAG_BODY,
      maxBytes: FETCH_LIMITS.dav,
      acceptContentTypes: [...XML_TYPES],
      headers: { ...connection.headers, depth: '0' },
    });

    const refused = authFailure(ctagResponse);
    if (refused !== undefined) {
      // Account-wide rather than per calendar: a password that stopped being
      // accepted is the one fault that hits every calendar on the account at
      // once, and saying it on the account is what lets the screen offer the
      // one control that fixes all of them.
      recordAccountError(deps.db, account.id, refused, at);
      return fail(sourceId, refused, AUTH_FAILURE_HOLD_SECONDS);
    }
    if (ctagResponse.status === 'rejected') return fail(sourceId, ctagResponse.message);
    if (ctagResponse.status === 'failed') {
      return fail(sourceId, ctagResponse.message, ctagResponse.retryAfterSeconds);
    }
    if (ctagResponse.status === 'not-modified') {
      // Nothing conditional was sent, so this cannot happen. Stated as a value
      // rather than left to fall through, because the contract never throws.
      return fail(sourceId, 'The server answered 304 to a request that asked nothing.');
    }

    const ctag = ctagOf(ctagResponse.body);
    if (ctag !== undefined && source.etag !== null && ctag === source.etag) {
      // The cheap path, and the reason a CTag is stored at all: an unchanged
      // calendar costs one round trip, no REPORT and no parsing.
      events.recordUnchanged(sourceId);
      recordAccountError(deps.db, account.id, null, at);
      return { status: 'ok' };
    }

    const windowStart = new Date(at - WINDOW_BEFORE_DAYS * 86_400_000);
    const windowEnd = new Date(at + WINDOW_AFTER_DAYS * 86_400_000);

    const report = await deps.fetcher.fetch({
      url: connection.url,
      policy: connection.policy,
      method: 'REPORT',
      body: calendarQueryBody(windowStart, windowEnd),
      maxBytes: FETCH_LIMITS.dav,
      acceptContentTypes: [...XML_TYPES],
      headers: { ...connection.headers, depth: '1' },
    });

    const reportRefused = authFailure(report);
    if (reportRefused !== undefined) {
      recordAccountError(deps.db, account.id, reportRefused, at);
      return fail(sourceId, reportRefused, AUTH_FAILURE_HOLD_SECONDS);
    }
    if (report.status === 'rejected') return fail(sourceId, report.message);
    if (report.status === 'failed') return fail(sourceId, report.message, report.retryAfterSeconds);
    if (report.status === 'not-modified') {
      return fail(sourceId, 'The server answered 304 to a request that asked nothing.');
    }

    const split = splitCalendarData(report.body);
    if (!split.ok) {
      // The document came down and could not be read. Keep what we had, and
      // carry the reader's own complaint: "could not be parsed" on its own is
      // not a diagnosis, which is `ics-sync`'s lesson one transport along.
      return fail(
        sourceId,
        `That calendar's server answered with something we could not read: ${split.error.message}`,
      );
    }

    const timezone = deps.timezone();
    const rows: EventRow[] = [];
    let skipped = 0;

    /*
     * §6.5, and the loop is the feature.
     *
     * One `expandCalendar` per resource, so a resource that will not parse is
     * counted and stepped over rather than taking the other fifty with it. The
     * count is kept because a calendar quietly dropping events is worse than
     * one that says how many — but it is *not* a failure: the rest of the
     * calendar is real and belongs on the wall.
     */
    for (const resource of split.resources) {
      const expanded = expandCalendar({
        icsText: resource.calendarData,
        targetTimezone: timezone,
        windowStart,
        windowEnd,
        maxEvents: 5000,
      });
      if (!expanded.ok) {
        skipped += 1;
        continue;
      }
      for (const event of expanded.value) rows.push(toEventRow(event, sourceId, timezone));
    }

    if (skipped > 0 && rows.length === 0 && split.resources.length > 0) {
      /*
       * Every resource failed, which is not per-resource isolation working — it
       * is a calendar this parser cannot read at all, and replacing the cache
       * with nothing would blank it. Rule nine: keep yesterday's events and say
       * so.
       */
      return fail(
        sourceId,
        `None of the ${split.resources.length} events on this calendar could be read.`,
      );
    }

    events.replace(sourceId, rows);
    events.recordSuccess(sourceId, {
      // The CTag, in the column that already means "the marker that says
      // whether this changed". Null when the server does not answer `getctag`
      // at all, which costs a REPORT every poll and is correct rather than
      // optimal — inventing a marker would mean never noticing a change.
      etag: ctag ?? null,
      lastModified: null,
      host: hostOf(connection.url),
      eventCount: rows.length,
    });
    recordAccountError(deps.db, account.id, null, at);

    if (skipped > 0) {
      /*
       * Said in the log, and deliberately **not** in `last_error`.
       *
       * The settings row renders a non-null `last_error` as "Last sync failed"
       * in the danger tone, which would be a false sentence about a sync that
       * worked: the calendar is on the wall, and some of it is not. Writing it
       * there would trade one silence for one lie, and this repository's own
       * rule is that a claim belongs on the branch that can make it.
       *
       * The log is a channel a household can actually reach (System shows it,
       * which is rule eleven), and it carries **counts and the calendar's id
       * only** — never a title, a UID or a byte of the resource, because a
       * warning that names event content is the rule CLAUDE.md states outright
       * and there are tests asserting it.
       */
      console.warn(
        `[caldav] ${skipped} of ${split.resources.length} events on calendar ${sourceId} ` +
          `could not be read and were left out; the rest are on the wall.`,
      );
    }

    return { status: 'ok' };
  };
}

/** Host only, for diagnostics. Never the path. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The one failure that is not retryable and not about this calendar.
 *
 * A refused sign-in does not take the retry ladder (§4.6): no amount of waiting
 * turns a wrong password right, and a calendar polled every fifteen minutes
 * with a stale app-specific password can get a household locked out of their own
 * Apple ID. The sentence names the account and never the password, which is
 * CLAUDE.md's rule on warnings applied to a failure kind rather than a carve-out
 * for one.
 */
function authFailure(outcome: { status: string; httpStatus?: number }): string | undefined {
  if (outcome.status !== 'failed') return undefined;
  if (outcome.httpStatus !== 401 && outcome.httpStatus !== 403) return undefined;
  return (
    'Signing in to this CalDAV account was refused. The password was not accepted — if this is ' +
    'iCloud, an app-specific password rather than the Apple ID password is what is wanted. ' +
    'Enter a new one on the Calendars page.'
  );
}

/** `CS:getctag` off a `PROPFIND` answer, or undefined when the server sends none. */
function ctagOf(xml: string): string | undefined {
  const document = readMultistatus(xml);
  if (!document.ok) return undefined;
  for (const response of document.responses) {
    const value = prop(response, CALENDARSERVER_NS, 'getctag')?.text;
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}
