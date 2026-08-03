import type { JobHandler, JobRecord, JobResult, Fetcher } from '@maverick-wall/core';
import { createEventWriter, toEventRow } from './events.js';
import { WINDOW_AFTER_DAYS, WINDOW_BEFORE_DAYS } from './ics-sync.js';
import { call, resolveConnection } from '../modules/homeassistant/client.js';
import { eventsPath, parseCalendarEvents } from '../modules/homeassistant/calendars.js';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Syncing one Home Assistant calendar entity.
 *
 * The same job as an ICS feed with a different way of getting the bytes, and
 * that is the whole design: it writes the same rows through the same writer,
 * so the manifest, the display, the shift matcher and the health notices have
 * no idea which kind a source is.
 *
 * Rule nine applies here exactly as it does to a feed. Every failure path
 * leaves the previously expanded events in place — a Home Assistant that is
 * rebooting must leave yesterday's calendar on the wall, not blank it.
 */

export const HA_CALENDAR_JOB = 'ha-calendar-sync';

export function sourceIdFromJobKey(key: string): string | undefined {
  const separator = key.indexOf(':');
  return separator < 0 ? undefined : key.slice(separator + 1);
}

export interface HaCalendarSyncDeps {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  readonly timezone: () => string;
  readonly now?: () => number;
}

interface SourceRow {
  readonly id: string;
  readonly enabled: number;
  readonly kind: string;
  readonly haEntityId: string | null;
}

export function createHaCalendarSyncHandler(deps: HaCalendarSyncDeps): JobHandler {
  const now = deps.now ?? ((): number => Date.now());
  const events = createEventWriter(deps.db, now);

  const selectSource = deps.db.prepare(
    `SELECT id, enabled, kind, ha_entity_id AS haEntityId
       FROM calendar_sources WHERE id = ?`,
  );

  return async (job: JobRecord): Promise<JobResult> => {
    const sourceId = sourceIdFromJobKey(job.key);
    if (!sourceId) return { status: 'skipped', reason: 'job key carries no source id' };

    const source = selectSource.get(sourceId) as SourceRow | undefined;
    if (!source) return { status: 'skipped', reason: 'source no longer exists' };
    if (source.enabled === 0) return { status: 'skipped', reason: 'source is disabled' };
    if (source.kind !== 'homeassistant' || source.haEntityId === null) {
      return { status: 'skipped', reason: 'source is not a Home Assistant calendar' };
    }

    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      /*
       * The connection is gone, and this source cannot say anything else.
       *
       * Recorded as a failure on the source so it shows on the Calendars
       * screen where somebody would look — a household who revoked their token
       * will see "Home Assistant is not connected" against the calendar that
       * stopped updating, rather than a calendar that quietly went stale.
       */
      events.recordFailure(sourceId, resolved.message);
      return { status: 'failed', error: resolved.message };
    }

    const at = now();
    const from = new Date(at - WINDOW_BEFORE_DAYS * 86_400_000);
    const to = new Date(at + WINDOW_AFTER_DAYS * 86_400_000);

    const response = await call(
      deps.fetcher,
      resolved.connection,
      eventsPath(source.haEntityId, from, to),
      // Longer than a state read: Home Assistant expands three months of
      // recurrence to answer this, and a Raspberry Pi takes its time over it.
      20_000,
    );

    if (!response.ok) {
      events.recordFailure(sourceId, response.message);
      return { status: 'failed', error: response.message };
    }

    const timezone = deps.timezone();
    const parsed = parseCalendarEvents({
      body: response.body,
      entityId: source.haEntityId,
      timezone,
    });

    const rows = parsed.map((event) => toEventRow(event, sourceId, timezone));
    events.replace(sourceId, rows);
    events.recordSuccess(sourceId, {
      // No conditional GET: the calendar API answers with no validator, and a
      // window that moves every run would defeat one anyway.
      etag: null,
      lastModified: null,
      host: resolved.connection.host,
      eventCount: rows.length,
    });

    return { status: 'ok' };
  };
}
