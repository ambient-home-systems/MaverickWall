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
    readonly setupComplete: boolean;
    readonly shiftEnabled: boolean;
  };
  /**
   * What each wall looks like, by name. A theme key is a name the household
   * chose from a list of five, not content, and with no household theme any
   * more (RFC 015 phase 2) this is the only place an export can still say what
   * a wall is drawing. A panel's theme is null: it has none.
   */
  readonly walls: readonly { readonly name: string; readonly theme: string | null }[];
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
      `SELECT timezone, setup_completed_at AS setupCompletedAt,
              shift_enabled AS shiftEnabled
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as
    | { timezone: string; setupCompletedAt: number | null; shiftEnabled: number }
    | undefined;

  /*
   * The host and never the account.
   *
   * `auth_username` is the one column on this table where "it is not a
   * credential" is not the end of the argument: a Basic-auth username is very
   * often an **email address**, which is exactly what this export promises it
   * contains none of. It is in clear on the row because the settings screen has
   * to show which account a feed uses, and that is a different audience from a
   * file written to be handed to a stranger.
   *
   * What actually keeps it out is the **projection** a hundred lines below,
   * which names every field it carries; not selecting it here is a belt over
   * that, and a measured one — selecting it alone leaves the export unchanged,
   * because the projection is what decides. `system.test.ts` seeds a username
   * shaped like an address and asserts it does not survive, and that assertion
   * goes red when the projection carries it rather than when this query does.
   */
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
      `SELECT name, theme, orientation, rotation, last_seen_at AS lastSeenAt,
              app_version AS appVersion, revoked_at AS revokedAt
         FROM screens`,
    )
    .all() as {
    name: string;
    theme: string | null;
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
      setupComplete: household?.setupCompletedAt != null,
      shiftEnabled: household?.shiftEnabled === 1,
    },
    walls: screens
      .filter((screen) => screen.revokedAt === null)
      .map((screen) => ({ name: screen.name, theme: screen.theme })),
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
