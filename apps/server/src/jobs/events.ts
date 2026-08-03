import { localDateOf, type NormalizedEvent } from '@maverick-wall/calendar';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Writing a calendar's events, whatever produced them.
 *
 * Extracted when Home Assistant calendar entities arrived, because both syncs
 * end the same way: replace this source's rows atomically, then record what
 * happened on the source. Two copies of that would drift, and the half that
 * drifts is the one that forgets the transaction — which is how a household
 * ends up looking at an empty calendar for the half second a sync is running.
 */

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
 * Pure, so the mapping — particularly the inclusive end date, which is the
 * classic off-by-one — can be tested without a database.
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

export interface SuccessDetail {
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** Host only, for diagnostics. Never the path, which carries the credential. */
  readonly host: string | null;
  readonly eventCount: number;
}

export interface EventWriter {
  /** Replace this source's events atomically. */
  replace(sourceId: string, rows: readonly EventRow[]): void;
  recordFailure(sourceId: string, message: string): void;
  recordUnchanged(sourceId: string): void;
  recordSuccess(sourceId: string, detail: SuccessDetail): void;
}

export function createEventWriter(db: SqliteDatabase, now: () => number): EventWriter {
  const recordFailure = db.prepare(
    `UPDATE calendar_sources
        SET last_sync_at = ?, last_error = ?,
            consecutive_failures = consecutive_failures + 1, updated_at = ?
      WHERE id = ?`,
  );

  const recordUnchanged = db.prepare(
    `UPDATE calendar_sources
        SET last_sync_at = ?, last_success_at = ?, last_error = NULL,
            consecutive_failures = 0, updated_at = ?
      WHERE id = ?`,
  );

  const recordSuccess = db.prepare(
    `UPDATE calendar_sources
        SET last_sync_at = ?, last_success_at = ?, last_error = NULL,
            consecutive_failures = 0, etag = ?, last_modified = ?,
            url_host = ?, event_count = ?, updated_at = ?
      WHERE id = ?`,
  );

  const deleteEvents = db.prepare('DELETE FROM calendar_events_cache WHERE source_id = ?');

  const insertEvent = db.prepare(
    `INSERT INTO calendar_events_cache
       (id, source_id, uid, recurrence_id, title, location, starts_at, ends_at,
        all_day, start_local_date, end_local_date, source_tzid, status,
        is_recurring_instance, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /*
   * Delete-then-insert inside one transaction rather than a diff.
   *
   * A feed is small, expansion is fast, and a partially applied update is a
   * class of bug nobody wants to debug from a kitchen. Readers never observe
   * the empty intermediate state, because the transaction is the unit of
   * visibility.
   */
  const replace = db.transaction((sourceId: string, rows: readonly EventRow[]) => {
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

  return {
    replace(sourceId, rows) {
      replace(sourceId, rows);
    },
    recordFailure(sourceId, message) {
      const at = now();
      recordFailure.run(at, message, at, sourceId);
    },
    recordUnchanged(sourceId) {
      const at = now();
      recordUnchanged.run(at, at, at, sourceId);
    },
    recordSuccess(sourceId, detail) {
      const at = now();
      recordSuccess.run(
        at, at, detail.etag, detail.lastModified, detail.host, detail.eventCount, at, sourceId,
      );
    },
  };
}
