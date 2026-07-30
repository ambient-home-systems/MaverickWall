import type { ShiftOverride, ShiftPlan, ShiftType } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import type { EventCacheRow, HouseholdRow, SourceRow } from './manifest.js';

/**
 * Reads for the manifest.
 *
 * Separate from assembly so the interesting logic stays testable without a
 * database. Nothing here does any thinking; it turns rows into the shapes
 * `buildManifest` expects and stops.
 */

const HOUSEHOLD_DEFAULTS: HouseholdRow = {
  timezone: 'America/New_York',
  theme: 'board',
  daytimeTheme: null,
  daytimeStartsAt: null,
  daytimeEndsAt: null,
  shiftEnabled: 0,
};

export function readHousehold(db: SqliteDatabase): HouseholdRow {
  const row = db
    .prepare(
      `SELECT timezone, theme, daytime_theme AS daytimeTheme,
              daytime_starts_at AS daytimeStartsAt, daytime_ends_at AS daytimeEndsAt,
              shift_enabled AS shiftEnabled
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as HouseholdRow | undefined;
  // Defaults rather than an error. A missing settings row means setup has not
  // run, and the display should still boot and say so.
  return row ?? HOUSEHOLD_DEFAULTS;
}

export function readSources(db: SqliteDatabase): SourceRow[] {
  return db
    .prepare(
      `SELECT id, name, color, visible,
              last_success_at AS lastSuccessAt, last_error AS lastError,
              consecutive_failures AS consecutiveFailures, event_count AS eventCount
         FROM calendar_sources
        WHERE enabled = 1
        ORDER BY name`,
    )
    .all() as SourceRow[];
}

/**
 * Events overlapping a range of local dates.
 *
 * Filtered on the local date columns rather than the instants, because that is
 * what the grid is built from and it means the index does the work rather than
 * a timezone conversion per row.
 */
export function readEvents(db: SqliteDatabase, from: string, to: string): EventCacheRow[] {
  return db
    .prepare(
      `SELECT id, source_id AS sourceId, uid, title, location,
              starts_at AS startsAt, ends_at AS endsAt, all_day AS allDay,
              start_local_date AS startLocalDate, end_local_date AS endLocalDate, status
         FROM calendar_events_cache
        WHERE end_local_date >= ? AND start_local_date <= ?
        ORDER BY starts_at`,
    )
    .all(from, to) as EventCacheRow[];
}

export function readShiftTypes(db: SqliteDatabase): ShiftType[] {
  return db
    .prepare(
      `SELECT key, label, short_code AS shortCode, color_token AS colorToken,
              is_working AS isWorking
         FROM shift_types ORDER BY sort_order, key`,
    )
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        key: String(record['key']),
        label: String(record['label']),
        shortCode: String(record['shortCode']),
        colorToken: String(record['colorToken']),
        isWorking: record['isWorking'] === 1,
      };
    });
}

export function readShiftPlans(db: SqliteDatabase): ShiftPlan[] {
  return db
    .prepare(
      `SELECT id, name, kind, effective_from AS effectiveFrom, effective_to AS effectiveTo,
              priority, anchor_date AS anchorDate, cycle,
              calendar_source_id AS calendarSourceId, matchers
         FROM shift_plans ORDER BY priority DESC, effective_from DESC`,
    )
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      // Drizzle's json mode is not in play here, so the columns come back as
      // text and have to be parsed. A malformed one degrades to an empty plan
      // rather than taking the whole manifest down.
      const parse = <T>(value: unknown, fallback: T): T => {
        if (typeof value !== 'string') return fallback;
        try {
          return JSON.parse(value) as T;
        } catch {
          return fallback;
        }
      };
      return {
        ...record,
        cycle: parse<(string | null)[]>(record['cycle'], []),
        matchers: parse<unknown[]>(record['matchers'], []),
      } as unknown as ShiftPlan;
    });
}

export function readShiftOverrides(db: SqliteDatabase, from: string, to: string): ShiftOverride[] {
  return db
    .prepare(
      `SELECT date, shift_type_key AS shiftTypeKey, note
         FROM shift_overrides WHERE date BETWEEN ? AND ?`,
    )
    .all(from, to) as ShiftOverride[];
}

/** The most recent successful sync across all sources, for /healthz. */
export function readLastSync(db: SqliteDatabase): number | null {
  const row = db
    .prepare('SELECT MAX(last_success_at) AS lastSync FROM calendar_sources')
    .get() as { lastSync: number | null } | undefined;
  return row?.lastSync ?? null;
}

/** Which migrations have been applied, for /healthz. */
export function readSchemaVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS applied FROM __drizzle_migrations')
      .get() as { applied: number } | undefined;
    return row?.applied ?? 0;
  } catch {
    // The table only exists after the first migration has run.
    return 0;
  }
}

export function countUsers(db: SqliteDatabase): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS total FROM user').get() as { total: number };
    return row.total;
  } catch {
    return 0;
  }
}

export interface ScreenRow {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly theme: string | null;
  readonly revokedAt: number | null;
}

export function readScreens(db: SqliteDatabase): ScreenRow[] {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, theme, revoked_at AS revokedAt
         FROM screens WHERE revoked_at IS NULL`,
    )
    .all() as ScreenRow[];
}

export function touchScreen(db: SqliteDatabase, id: string, ip: string | null, agent: string | null): void {
  db.prepare(
    `UPDATE screens SET last_seen_at = ?, last_seen_ip = ?, last_seen_user_agent = ?
      WHERE id = ?`,
  ).run(Date.now(), ip, agent, id);
}
