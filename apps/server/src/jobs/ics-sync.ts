import { expandCalendar } from '@maverick-wall/calendar';
import { FETCH_LIMITS, type Fetcher, type JobHandler, type JobRecord, type JobResult, type UrlPolicy } from '@maverick-wall/core';
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
            consecutive_failures AS consecutiveFailures
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

    const policy: UrlPolicy = {
      allowPrivateNetwork: source.allowPrivateNetwork === 1,
      allowLoopback: source.allowLoopback === 1,
      allowHttp: source.allowHttp === 1,
    };

    const response = await deps.fetcher.fetch({
      url: opened.value,
      policy,
      maxBytes: FETCH_LIMITS.ics,
      acceptContentTypes: ICS_CONTENT_TYPES,
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
