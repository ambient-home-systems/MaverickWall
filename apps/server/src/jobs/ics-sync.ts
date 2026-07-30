import { expandCalendar, localDateOf, type NormalizedEvent } from '@maverick-wall/calendar';
import { FETCH_LIMITS, type Fetcher, type JobHandler, type JobRecord, type JobResult, type UrlPolicy } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Syncing one calendar feed.
 *
 * The job that makes everything else worth having, and the one place where
 * rule nine is decided. Every failure path below keeps the previously expanded
 * events in the cache. A feed that is unreachable, malformed, moved, or whose
 * URL can no longer be decrypted must leave yesterday's calendar on the wall
 * with an explanation — never an empty grid.
 */

/** How far either side of today the cache is kept. */
export const WINDOW_BEFORE_DAYS = 7;
export const WINDOW_AFTER_DAYS = 90;

const ICS_CONTENT_TYPES = ['text/calendar', 'application/octet-stream', 'text/plain'];

export interface CalendarSourceRow {
  readonly id: string;
  readonly name: string;
  readonly urlEncrypted: string;
  readonly enabled: number;
  readonly allowPrivateNetwork: number;
  readonly allowHttp: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly consecutiveFailures: number;
}

export interface EventRow {
  readonly id: string;
  readonly sourceId: string;
  readonly uid: string;
  readonly recurrenceId: string | null;
  readonly title: string;
  readonly location: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly allDay: number;
  readonly startLocalDate: string;
  readonly endLocalDate: string;
  readonly sourceTzid: string;
  readonly status: string;
  readonly isRecurringInstance: number;
}

/**
 * Turn an expanded occurrence into a database row.
 *
 * Kept separate and pure so the mapping — particularly the inclusive end date,
 * which is the classic off-by-one — can be tested without a database.
 */
export function toEventRow(
  event: NormalizedEvent,
  sourceId: string,
  timezone: string,
): EventRow {
  const startMs = event.startUtc.getTime();
  const endMs = event.endUtc.getTime();

  return {
    // Stable across syncs, so per-instance state could later attach to it.
    id: `${sourceId}:${event.uid}:${event.recurrenceId ?? ''}`,
    sourceId,
    uid: event.uid,
    recurrenceId: event.recurrenceId ?? null,
    title: event.title,
    location: event.location ?? null,
    startsAt: startMs,
    endsAt: endMs,
    allDay: event.allDay ? 1 : 0,
    startLocalDate: localDateOf(startMs, timezone),
    // endUtc is exclusive. Stepping back a millisecond gives the last day the
    // event actually occupies, which is what a grid needs. Using endUtc
    // directly puts every all-day event on one day too many.
    endLocalDate: localDateOf(Math.max(startMs, endMs - 1), timezone),
    sourceTzid: event.sourceTzid,
    status: event.status,
    isRecurringInstance: event.isRecurringInstance ? 1 : 0,
  };
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
            allow_private_network AS allowPrivateNetwork, allow_http AS allowHttp,
            etag, last_modified AS lastModified,
            consecutive_failures AS consecutiveFailures
       FROM calendar_sources WHERE id = ?`,
  );

  const recordFailure = deps.db.prepare(
    `UPDATE calendar_sources
        SET last_sync_at = ?, last_error = ?,
            consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ?`,
  );

  const recordUnchanged = deps.db.prepare(
    `UPDATE calendar_sources
        SET last_sync_at = ?, last_success_at = ?, last_error = NULL,
            consecutive_failures = 0, updated_at = ?
      WHERE id = ?`,
  );

  const recordSuccess = deps.db.prepare(
    `UPDATE calendar_sources
        SET last_sync_at = ?, last_success_at = ?, last_error = NULL,
            consecutive_failures = 0, etag = ?, last_modified = ?,
            url_host = ?, event_count = ?, updated_at = ?
      WHERE id = ?`,
  );

  const deleteEvents = deps.db.prepare('DELETE FROM calendar_events_cache WHERE source_id = ?');

  const insertEvent = deps.db.prepare(
    `INSERT INTO calendar_events_cache
       (id, source_id, uid, recurrence_id, title, location, starts_at, ends_at,
        all_day, start_local_date, end_local_date, source_tzid, status,
        is_recurring_instance, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /**
   * Replace this source's events atomically.
   *
   * Delete-then-insert inside one transaction rather than a diff. A feed is
   * small, expansion is fast, and a partially applied update is a class of bug
   * nobody wants to debug from a kitchen. Readers never observe the empty
   * intermediate state because the transaction is the unit of visibility.
   */
  const replaceEvents = deps.db.transaction((sourceId: string, rows: EventRow[]) => {
    deleteEvents.run(sourceId);
    const syncedAt = now();
    for (const row of rows) {
      insertEvent.run(
        row.id, row.sourceId, row.uid, row.recurrenceId, row.title, row.location,
        row.startsAt, row.endsAt, row.allDay, row.startLocalDate, row.endLocalDate,
        row.sourceTzid, row.status, row.isRecurringInstance, syncedAt,
      );
    }
  });

  const fail = (sourceId: string, message: string, retryAfterSeconds?: number): JobResult => {
    const at = now();
    recordFailure.run(at, message, at, sourceId);
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
      const at = now();
      recordUnchanged.run(at, at, at, sourceId);
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
    replaceEvents(sourceId, rows);

    recordSuccess.run(
      at, at,
      response.etag ?? null,
      response.lastModified ?? null,
      hostOf(response.finalUrl),
      rows.length,
      at,
      sourceId,
    );

    return { status: 'ok' };
  };
}
