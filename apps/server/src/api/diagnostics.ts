import { integrityCheck, type SqliteDatabase } from '../db/open.js';
import type { LogLine } from '../logbuffer.js';
import { redactLog } from './redact.js';

/**
 * The document somebody attaches to a bug report.
 *
 * Its whole value is that it can be handed over without thinking, so the rule
 * is not "avoid obvious secrets" but "carry nothing that belongs to the
 * household". No feed URLs — the path is the credential — no event titles, no
 * email addresses, no tokens. Hostnames only, because a failing feed is
 * usually failing at a host somebody can recognise.
 *
 * There is a test asserting that a database stuffed with private-looking data
 * produces an export containing none of it. That test is the feature — and for
 * a long time it was the *only* one, which is how the log tail went out
 * unfiltered: it proved the database projection was clean and could say
 * nothing at all about `log`, because it never put a secret in one. There is
 * now a second test that does, because every field here is a projection and
 * the log is the only one whose contents this file does not choose.
 */

export interface Diagnostics {
  readonly generatedAt: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly uptimeSeconds: number;
  readonly node: string;
  readonly platform: string;
  readonly database: {
    readonly integrityOk: boolean;
    readonly integrityDetail: string;
    readonly sizeBytes: number;
    readonly journalMode: string;
  };
  readonly household: {
    readonly timezone: string;
    readonly theme: string;
    readonly setupComplete: boolean;
    readonly shiftEnabled: boolean;
  };
  readonly counts: Readonly<Record<string, number>>;
  /** Per source: how it is doing, named by host rather than by address. */
  readonly sources: readonly {
    readonly host: string | null;
    readonly enabled: boolean;
    readonly eventCount: number;
    readonly consecutiveFailures: number;
    readonly lastError: string | null;
    readonly lastSuccessAgoSeconds: number | null;
  }[];
  readonly screens: readonly {
    readonly orientation: string;
    readonly rotation: number;
    readonly lastSeenAgoSeconds: number | null;
    readonly appVersion: string | null;
    readonly revoked: boolean;
  }[];
  readonly jobs: readonly {
    readonly kind: string;
    readonly consecutiveFailures: number;
    readonly lastError: string | null;
    readonly lastDurationMs: number | null;
  }[];
  readonly log: readonly LogLine[];
}

export interface DiagnosticsInput {
  readonly db: SqliteDatabase;
  readonly appVersion: string;
  readonly startedAt: number;
  readonly now: number;
  readonly log: readonly LogLine[];
  readonly databaseSizeBytes: number;
}

function count(db: SqliteDatabase, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    // A table missing because a migration failed is exactly the sort of thing
    // this export exists to reveal, so it reports zero rather than throwing.
    return 0;
  }
}

const ago = (at: number | null, now: number): number | null =>
  at === null ? null : Math.max(0, Math.round((now - at) / 1000));

export function buildDiagnostics(input: DiagnosticsInput): Diagnostics {
  const { db, now } = input;
  const integrity = integrityCheck(db);

  const household = db
    .prepare(
      `SELECT timezone, theme, setup_completed_at AS setupCompletedAt,
              shift_enabled AS shiftEnabled
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as
    | { timezone: string; theme: string; setupCompletedAt: number | null; shiftEnabled: number }
    | undefined;

  const sources = db
    .prepare(
      `SELECT url_host AS host, enabled, event_count AS eventCount,
              consecutive_failures AS consecutiveFailures, last_error AS lastError,
              last_success_at AS lastSuccessAt
         FROM calendar_sources ORDER BY url_host`,
    )
    .all() as {
    host: string | null;
    enabled: number;
    eventCount: number;
    consecutiveFailures: number;
    lastError: string | null;
    lastSuccessAt: number | null;
  }[];

  const screens = db
    .prepare(
      `SELECT orientation, rotation, last_seen_at AS lastSeenAt, app_version AS appVersion,
              revoked_at AS revokedAt
         FROM screens`,
    )
    .all() as {
    orientation: string;
    rotation: number;
    lastSeenAt: number | null;
    appVersion: string | null;
    revokedAt: number | null;
  }[];

  const jobs = db
    .prepare(
      `SELECT kind, consecutive_failures AS consecutiveFailures, last_error AS lastError,
              last_duration_ms AS lastDurationMs
         FROM job_state ORDER BY kind`,
    )
    .all() as {
    kind: string;
    consecutiveFailures: number;
    lastError: string | null;
    lastDurationMs: number | null;
  }[];

  let journalMode = 'unknown';
  try {
    journalMode = String(db.pragma('journal_mode', { simple: true }));
  } catch {
    // Reported as unknown rather than taken as a failure.
  }

  return {
    generatedAt: now,
    appVersion: input.appVersion,
    schemaVersion: count(db, '__drizzle_migrations'),
    uptimeSeconds: Math.max(0, Math.round((now - input.startedAt) / 1000)),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    database: {
      integrityOk: integrity.ok,
      integrityDetail: integrity.detail,
      sizeBytes: input.databaseSizeBytes,
      journalMode,
    },
    household: {
      timezone: household?.timezone ?? 'unknown',
      theme: household?.theme ?? 'unknown',
      setupComplete: household?.setupCompletedAt != null,
      shiftEnabled: household?.shiftEnabled === 1,
    },
    counts: {
      calendars: sources.length,
      events: count(db, 'calendar_events_cache'),
      people: count(db, 'people'),
      screens: screens.length,
      shiftPlans: count(db, 'shift_plans'),
      users: count(db, 'user'),
    },
    // Deliberately no name and no id: a household calls a feed "Mum's work",
    // which is about them rather than about the fault.
    sources: sources.map((source) => ({
      host: source.host,
      enabled: source.enabled === 1,
      eventCount: source.eventCount,
      consecutiveFailures: source.consecutiveFailures,
      lastError: source.lastError,
      lastSuccessAgoSeconds: ago(source.lastSuccessAt, now),
    })),
    screens: screens.map((screen) => ({
      orientation: screen.orientation,
      rotation: screen.rotation,
      lastSeenAgoSeconds: ago(screen.lastSeenAt, now),
      appVersion: screen.appVersion,
      revoked: screen.revokedAt !== null,
    })),
    jobs,
    // Never `input.log` — see `redact.ts`. The buffer holds whatever any
    // `console.log` in the process wrote, and this is the one field of the
    // export that is not something this file picked out on purpose.
    log: redactLog(input.log),
  };
}
