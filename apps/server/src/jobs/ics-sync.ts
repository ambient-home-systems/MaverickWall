import { expandCalendar } from '@maverick-wall/calendar';
import { FETCH_LIMITS, type Fetcher, type JobHandler, type JobRecord, type JobResult } from '@maverick-wall/core';
import { connectionFor } from '../api/feed-credentials.js';
import { createEventWriter, toEventRow, type EventRow } from './events.js';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';

export { toEventRow };
export type { EventRow };

/**
 * Syncing one calendar feed.
 *
 * The job that makes everything else worth having, and the one place where
 * rule nine is decided. Every failure path below keeps the previously expanded
 * events in the cache. A feed that is unreachable, malformed, moved, or whose
 * URL can no longer be decrypted must leave yesterday's calendar on the wall
 * with an explanation — never an empty grid.
 */

/**
 * How far either side of today the cache is kept.
 *
 * **`WINDOW_BEFORE_DAYS` is a floor set by the rota, not by the wall.** The
 * display only ever shows a day of history, and 7 was generous for that — but a
 * calendar-derived shift plan reads event *titles* to recognise a shift, so a
 * run of shifts can only be followed back as far as the cache goes. At 7 a
 * fortnight of straights on day 13 reported "Day 8 of 9": seven days of history
 * and one of future, counted exactly.
 *
 * That was the third window in a chain that all had to agree, and the first two
 * were widened one release at a time while this one quietly capped the answer:
 * the run resolution (0.40.0), then the manifest's own event read (0.41.0),
 * then this. `ics-sync.test.ts` now asserts it stays at or above
 * `RUN_WINDOW_DAYS`, so the chain cannot come apart again silently.
 */
export const WINDOW_BEFORE_DAYS = 90;
export const WINDOW_AFTER_DAYS = 90;

const ICS_CONTENT_TYPES = ['text/calendar', 'application/octet-stream', 'text/plain'];

/**
 * How long a feed whose sign-in was refused waits before it tries again
 * (RFC 013 §4.6).
 *
 * Not a backoff — a **hold**. The backoff ladder exists for an upstream that
 * might be well in five minutes, and no amount of waiting turns a wrong
 * password right. What the ordinary ladder would do here is worse than
 * useless: Apple locks an Apple ID out of CalDAV after enough wrong
 * app-specific-password attempts in a window, and Nextcloud's own brute-force
 * protection does the same to an account after a run of failed Basic-auth
 * requests from one address. A feed polled every fifteen minutes with a
 * password that went stale on day one would still be knocking days later, on a
 * fixed interval, and could lock the household out of their own server. A
 * calendar that stops trying is a better neighbour to the account it is a
 * guest of.
 *
 * A week rather than for ever, which is the one place this differs from "never
 * retry": the credential might be fine and the server temporarily
 * misconfigured, and a wall that never tries again would need a household to
 * notice and press something. The path that actually recovers this is an edit
 * — `updateSource` re-arms the job the moment a credential changes — so this
 * number is only the floor under a household who never comes back.
 */
export const AUTH_FAILURE_HOLD_SECONDS = 7 * 24 * 60 * 60;

export interface CalendarSourceRow {
  readonly id: string;
  readonly name: string;
  readonly urlEncrypted: string | null;
  readonly enabled: number;
  readonly allowPrivateNetwork: number;
  readonly allowLoopback: number;
  readonly allowHttp: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly consecutiveFailures: number;
  readonly authUsername: string | null;
  readonly authPasswordEncrypted: string | null;
}

export interface IcsSyncDeps {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  /** Household timezone. Anchors all-day events and the local date columns. */
  readonly timezone: () => string;
  readonly now?: () => number;
}

export function sourceIdFromJobKey(key: string): string | undefined {
  const separator = key.indexOf(':');
  return separator < 0 ? undefined : key.slice(separator + 1);
}

/** Host only, for diagnostics. Never the path, which carries the credential. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function createIcsSyncHandler(deps: IcsSyncDeps): JobHandler {
  const now = deps.now ?? (() => Date.now());

  const selectSource = deps.db.prepare(
    `SELECT id, name, url_encrypted AS urlEncrypted, enabled,
            allow_private_network AS allowPrivateNetwork,
            allow_loopback AS allowLoopback, allow_http AS allowHttp,
            etag, last_modified AS lastModified,
            consecutive_failures AS consecutiveFailures,
            auth_username AS authUsername,
            auth_password_encrypted AS authPasswordEncrypted
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

    const source = selectSource.get(sourceId) as CalendarSourceRow | undefined;
    if (!source) {
      // The source was deleted but its job row survived. Harmless; boot
      // reconciliation will remove it.
      return { status: 'skipped', reason: 'source no longer exists' };
    }
    if (source.enabled === 0) return { status: 'skipped', reason: 'source is disabled' };
    if (source.urlEncrypted === null) {
      // A source of another kind — a Home Assistant calendar entity — whose
      // own job is elsewhere. Reachable only if a job row outlived a change of
      // kind, and skipping is the right answer either way: this handler has no
      // address to fetch and must not mark the source as failing for it.
      return { status: 'skipped', reason: 'source has no feed address' };
    }

    const opened = deps.keyring.decrypt(source.urlEncrypted, 'calendar-source-url');
    if (!opened.ok) {
      // Almost always a backup restored without /data/.secret. Not retryable —
      // no amount of waiting recovers a key that is gone — but the cached
      // events stay, so the wall keeps showing the calendar it already had.
      return fail(
        sourceId,
        'The stored address for this calendar could not be read. It was most ' +
          'likely restored from a backup without its encryption key, and needs ' +
          'entering again.',
      );
    }

    /*
     * Address, policy and credential resolved together, in one place.
     *
     * Not three reads at this call site: the three network opt-ins and the
     * `authorization` header are the same question — what this connection is
     * allowed to be — and reading them separately here is how `testFeed` and
     * this job come to disagree about a feed neither of them can test against
     * the other.
     */
    const connection = connectionFor(
      {
        url: opened.value,
        allowPrivateNetwork: source.allowPrivateNetwork === 1,
        allowLoopback: source.allowLoopback === 1,
        allowHttp: source.allowHttp === 1,
        authUsername: source.authUsername,
        authPassword: { stored: source.authPasswordEncrypted },
      },
      deps.keyring,
    );

    if (connection.passwordUnreadable) {
      // The decrypt-failure branch above, one column along, and it reaches a
      // household the same way: a backup restored without its key. Not
      // retryable, and the cached events stay.
      return fail(
        sourceId,
        'The stored password for this calendar could not be read. It was most ' +
          'likely restored from a backup without its encryption key. Enter it ' +
          'again on the Calendars page.',
      );
    }

    const response = await deps.fetcher.fetch({
      url: connection.url,
      policy: connection.policy,
      maxBytes: FETCH_LIMITS.ics,
      acceptContentTypes: ICS_CONTENT_TYPES,
      ...(Object.keys(connection.headers).length > 0 ? { headers: connection.headers } : {}),
      conditional: {
        ...(source.etag ? { etag: source.etag } : {}),
        ...(source.lastModified ? { lastModified: source.lastModified } : {}),
      },
    });

    if (response.status === 'not-modified') {
      // The cheap path, and the reason ETags are stored at all: an unchanged
      // feed costs one round trip and no parsing.
      events.recordUnchanged(sourceId);
      return { status: 'ok' };
    }

    if (response.status === 'rejected') {
      return fail(sourceId, response.message);
    }

    if (response.status === 'failed') {
      /*
       * A refused sign-in is not a flaky upstream, so it does not take the
       * retry ladder (RFC 013 §4.6). The cached events stay, exactly as they do
       * on every other failure path in this job — rule nine — and the message
       * names the control that fixes it, because a household reading "401
       * Unauthorized" has no next action and a household reading a sentence
       * naming the Calendars page does.
       *
       * The sentence carries the username where there is one and never the
       * password. The username is already on the settings row, so repeating it
       * costs nothing and is often the whole diagnosis; the password crosses
       * this codebase exactly as far as the keyring and the outbound header,
       * and a diagnosis string is neither. That is not a carve-out for a new
       * kind of message — it is CLAUDE.md's existing rule on warnings and logs
       * applied to a failure kind Phase A introduces.
       */
      if (response.httpStatus === 401 || response.httpStatus === 403) {
        const account =
          source.authUsername === null || source.authUsername === ''
            ? ''
            : ` for ${source.authUsername}`;
        return fail(
          sourceId,
          `Signing in to this calendar${account} was refused. The password for ` +
            'this calendar was not accepted. Enter a new one on the Calendars page.',
          AUTH_FAILURE_HOLD_SECONDS,
        );
      }
      return fail(sourceId, response.message, response.retryAfterSeconds);
    }

    const timezone = deps.timezone();
    const at = now();
    const windowStart = new Date(at - WINDOW_BEFORE_DAYS * 86_400_000);
    const windowEnd = new Date(at + WINDOW_AFTER_DAYS * 86_400_000);

    const expanded = expandCalendar({
      icsText: response.body,
      targetTimezone: timezone,
      windowStart,
      windowEnd,
      maxEvents: 5000,
    });

    if (!expanded.ok) {
      // The feed downloaded but is not usable. Keep what we had.
      //
      // `detail` carries the parser's own complaint and is the only part that
      // says what was actually wrong. Dropping it, as an earlier version did,
      // left "The calendar feed could not be parsed" as the entire diagnosis.
      const detail = expanded.error.detail ? `: ${expanded.error.detail}` : '';
      return fail(sourceId, `${expanded.error.message} (${expanded.error.code})${detail}`);
    }

    const rows = expanded.value.map((event) => toEventRow(event, sourceId, timezone));
    events.replace(sourceId, rows);

    events.recordSuccess(sourceId, {
      etag: response.etag ?? null,
      lastModified: response.lastModified ?? null,
      host: hostOf(response.finalUrl),
      eventCount: rows.length,
    });

    return { status: 'ok' };
  };
}
