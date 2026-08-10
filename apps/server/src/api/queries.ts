import type { ShiftOverride, ShiftPlan, ShiftType } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import type { SetupState } from '../auth/session.js';
import type {
  EventCacheRow,
  HouseholdRow,
  PersonRow,
  PlacedWidgetRow,
  SourceRow,
} from './manifest.js';

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
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  layoutMode: 'auto',
  layoutAspect: 0.5625,
};

export function readHousehold(db: SqliteDatabase): HouseholdRow {
  const row = db
    .prepare(
      `SELECT timezone, theme, daytime_theme AS daytimeTheme,
              daytime_starts_at AS daytimeStartsAt, daytime_ends_at AS daytimeEndsAt,
              shift_enabled AS shiftEnabled,
              display_today_events AS displayTodayEvents,
              display_next_days AS displayNextDays,
              display_horizon_weeks AS displayHorizonWeeks,
              display_blocks AS displayBlocks,
              layout_mode AS layoutMode,
              layout_aspect AS layoutAspect
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as HouseholdRow | undefined;
  // Defaults rather than an error. A missing settings row means setup has not
  // run, and the display should still boot and say so.
  return row ?? HOUSEHOLD_DEFAULTS;
}

/**
 * The placed widgets for one canvas — a wall's own, or the shared default.
 *
 * `screenId` null reads the default layout (rows with no owner); a screen id
 * reads that wall's own. The `config` column is JSON this process wrote, parsed
 * leniently because a row that will not parse is one missing widget, never a
 * manifest that fails to build — rule nine. `buildLayout` clamps the
 * coordinates and checks the type; this only turns rows into the shape it
 * expects.
 */
export function readLayoutWidgets(
  db: SqliteDatabase,
  screenId: string | null = null,
): PlacedWidgetRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, x, y, w, h, z, config
         FROM layout_widgets
        WHERE screen_id IS ?
        ORDER BY z, created_at`,
    )
    .all(screenId) as {
    id: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    config: string | null;
  }[];

  return rows.map((row) => {
    let config: unknown;
    if (row.config !== null) {
      try {
        config = JSON.parse(row.config);
      } catch {
        config = undefined;
      }
    }
    return { id: row.id, type: row.type, x: row.x, y: row.y, w: row.w, h: row.h, z: row.z, config };
  });
}

export interface LayoutWidgetInput {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config?: unknown;
}

/**
 * Save a whole layout at once — for one wall, or the shared default.
 *
 * `screenId` null writes the default: the mode and aspect on the household, the
 * widgets with no owner. A screen id writes that wall: the mode and aspect on
 * the screen row (a non-null `layout_mode` there is what marks the wall as
 * having its own canvas), the widgets owned by it.
 *
 * Replace rather than diff, because the editor sends the canvas it has and the
 * simplest correct thing is to make the database match it. One transaction per
 * owner, so a wall polling mid-save reads the old canvas or the new one, never
 * half of either — and only that owner's rows are touched, so saving one wall
 * never disturbs another. The rows are trusted here because the boundary
 * validated them; the display clamps again in `buildLayout` regardless.
 */
export function replaceLayout(
  db: SqliteDatabase,
  screenId: string | null,
  layout: { readonly mode: string; readonly aspect: number; readonly widgets: readonly LayoutWidgetInput[] },
): void {
  const at = Date.now();
  const tx = db.transaction(() => {
    if (screenId === null) {
      db.prepare(
        `UPDATE household_settings SET layout_mode = ?, layout_aspect = ?, updated_at = ?
          WHERE id = 'singleton'`,
      ).run(layout.mode, layout.aspect, at);
    } else {
      db.prepare(
        `UPDATE screens SET layout_mode = ?, layout_aspect = ?, updated_at = ? WHERE id = ?`,
      ).run(layout.mode, layout.aspect, at, screenId);
    }

    db.prepare('DELETE FROM layout_widgets WHERE screen_id IS ?').run(screenId);
    const insert = db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    layout.widgets.forEach((widget, index) => {
      insert.run(
        widget.id,
        screenId,
        widget.type,
        widget.x,
        widget.y,
        widget.w,
        widget.h,
        // Stored order carries the z, so a plain read is already back-to-front.
        widget.z ?? index,
        widget.config === undefined ? null : JSON.stringify(widget.config),
        at,
        at,
      );
    });
  });
  tx();
}

/**
 * The effective display settings for a wall: its own override, or the
 * household's, field by field.
 *
 * The one place the fallback lives, so the manifest, the editor preview and any
 * future per-wall screen all resolve it the same way. Null on a screen field
 * means "follow the household" — the common case, and the easy one. For the
 * layout, a non-null `layoutMode` on the screen is what says the wall has its
 * own canvas; otherwise it draws the shared default.
 *
 * Theme is deliberately not here: it is already resolved per screen further
 * along, in the manifest's `screen` block, and doing it twice would only
 * confuse which layer owns it.
 */
export function effectiveDisplay(
  household: HouseholdRow,
  screen: {
    readonly id?: string;
    readonly displayTodayEvents?: number | null;
    readonly displayNextDays?: number | null;
    readonly displayHorizonWeeks?: number | null;
    readonly displayBlocks?: string | null;
    readonly layoutMode?: string | null;
    readonly layoutAspect?: number | null;
  },
): {
  /** The household row with each field resolved to this wall's effective value. */
  readonly household: HouseholdRow;
  /** Whose widgets to read: this wall's id when it owns a canvas, else null. */
  readonly layoutOwner: string | null;
} {
  const ownsLayout = screen.layoutMode !== null && screen.layoutMode !== undefined;
  return {
    household: {
      ...household,
      displayTodayEvents: screen.displayTodayEvents ?? household.displayTodayEvents,
      displayNextDays: screen.displayNextDays ?? household.displayNextDays,
      displayHorizonWeeks: screen.displayHorizonWeeks ?? household.displayHorizonWeeks,
      displayBlocks: screen.displayBlocks ?? household.displayBlocks,
      layoutMode: screen.layoutMode ?? household.layoutMode,
      layoutAspect: screen.layoutAspect ?? household.layoutAspect,
    },
    layoutOwner: ownsLayout ? (screen.id ?? null) : null,
  };
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

export function readPeople(db: SqliteDatabase): PersonRow[] {
  return db
    .prepare(
      `SELECT id, name, color, has_shift_rotation AS hasShiftRotation,
              sort_order AS sortOrder, avatar_path AS avatarPath
         FROM people ORDER BY sort_order, name`,
    )
    .all() as PersonRow[];
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
              priority, person_id AS personId, anchor_date AS anchorDate, cycle,
              calendar_source_id AS calendarSourceId, matchers,
              consumes_events AS consumesEvents
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
        consumesEvents: record['consumesEvents'] === 1,
      } as unknown as ShiftPlan;
    });
}

export function readShiftOverrides(db: SqliteDatabase, from: string, to: string): ShiftOverride[] {
  return db
    .prepare(
      `SELECT date, person_id AS personId, shift_type_key AS shiftTypeKey, note
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

export interface PersonRecord {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly avatarPath: string | null;
  readonly sortOrder: number;
  readonly hasShiftRotation: number;
  /** How many calendars point at them, so a delete can say what it will do. */
  readonly sourceCount: number;
}

export function readPeopleAdmin(db: SqliteDatabase): PersonRecord[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.color, p.avatar_path AS avatarPath, p.sort_order AS sortOrder,
              p.has_shift_rotation AS hasShiftRotation,
              (SELECT COUNT(*) FROM calendar_sources s WHERE s.person_id = p.id) AS sourceCount
         FROM people p ORDER BY p.sort_order, p.name`,
    )
    .all() as PersonRecord[];
}

export function createPerson(db: SqliteDatabase, id: string, name: string, color: string): void {
  const at = Date.now();
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM people').get() as {
    n: number;
  };
  db.prepare(
    `INSERT INTO people (id, name, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, color, next.n, at, at);
}

export function setPersonAvatar(db: SqliteDatabase, id: string, path: string | null): boolean {
  return (
    db
      .prepare('UPDATE people SET avatar_path = ?, updated_at = ? WHERE id = ?')
      .run(path, Date.now(), id).changes > 0
  );
}

export function updatePerson(db: SqliteDatabase, id: string, name: string, color: string): boolean {
  return (
    db
      .prepare('UPDATE people SET name = ?, color = ?, updated_at = ? WHERE id = ?')
      .run(name, color, Date.now(), id).changes > 0
  );
}

/**
 * Remove a person.
 *
 * Their shift plans go with them — a rota with nobody on it means nothing — but
 * their calendars do not: `person_id` is set null, so a feed stays subscribed
 * and simply stops being attributed. Deleting somebody should not silently
 * unsubscribe the household from the school calendar.
 */
export function deletePerson(db: SqliteDatabase, id: string): boolean {
  const remove = db.transaction((personId: string): boolean => {
    db.prepare('UPDATE calendar_sources SET person_id = NULL WHERE person_id = ?').run(personId);
    return db.prepare('DELETE FROM people WHERE id = ?').run(personId).changes > 0;
  });
  return remove(id);
}

export interface SourceSettings {
  readonly name: string;
  readonly color: string;
  readonly personId: string | null;
  readonly enabled: boolean;
  readonly allowPrivateNetwork: boolean;
}

export function updateSource(db: SqliteDatabase, id: string, settings: SourceSettings): boolean {
  return (
    db
      .prepare(
        `UPDATE calendar_sources
            SET name = ?, color = ?, person_id = ?, enabled = ?, allow_private_network = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        settings.name,
        settings.color,
        settings.personId,
        settings.enabled ? 1 : 0,
        settings.allowPrivateNetwork ? 1 : 0,
        Date.now(),
        id,
      ).changes > 0
  );
}

export interface ShiftPlanRow {
  readonly id: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly name: string;
  readonly kind: string;
  readonly anchorDate: string | null;
  readonly cycle: string | null;
  readonly calendarSourceId: string | null;
  readonly sourceName: string | null;
  readonly matchers: string | null;
  readonly effectiveFrom: string;
}

export function readShiftPlansAdmin(db: SqliteDatabase): ShiftPlanRow[] {
  return db
    .prepare(
      `SELECT p.id, p.person_id AS personId, pe.name AS personName, p.name, p.kind,
              p.anchor_date AS anchorDate, p.cycle, p.calendar_source_id AS calendarSourceId,
              s.name AS sourceName, p.matchers, p.effective_from AS effectiveFrom
         FROM shift_plans p
         LEFT JOIN people pe ON pe.id = p.person_id
         LEFT JOIN calendar_sources s ON s.id = p.calendar_source_id
        ORDER BY pe.sort_order, p.name`,
    )
    .all() as ShiftPlanRow[];
}

/**
 * Every title in a source, with the dates it covers.
 *
 * The input to `analyseTitles`. Read straight from the event cache rather than
 * re-fetching: the point of the screen is to show what is genuinely in the feed
 * the household already subscribed to.
 */
export function readTitleObservations(
  db: SqliteDatabase,
  sourceId: string,
): { title: string; startDate: string; endDate: string; allDay: number; startsAt: number }[] {
  return db
    .prepare(
      `SELECT title, start_local_date AS startDate, end_local_date AS endDate,
              all_day AS allDay, starts_at AS startsAt
         FROM calendar_events_cache WHERE source_id = ?`,
    )
    .all(sourceId) as never;
}

/** Titles per local date, for resolving a calendar-derived plan. */
export function readTitlesByDate(db: SqliteDatabase, sourceId: string): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT title, start_local_date AS startDate, end_local_date AS endDate
         FROM calendar_events_cache WHERE source_id = ?`,
    )
    .all(sourceId) as { title: string; startDate: string; endDate: string }[];

  const byDate = new Map<string, string[]>();
  for (const row of rows) {
    let cursor = row.startDate;
    // Guarded, because a feed with a nonsense end date must not spin here.
    for (let guard = 0; cursor <= row.endDate && guard < 400; guard++) {
      const bucket = byDate.get(cursor) ?? [];
      bucket.push(row.title);
      byDate.set(cursor, bucket);
      cursor = new Date(new Date(`${cursor}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
  }
  return byDate;
}

export interface SaveShiftPlanInput {
  readonly id: string;
  readonly personId: string;
  readonly name: string;
  readonly kind: 'pattern' | 'calendar';
  readonly anchorDate: string | null;
  readonly cycle: (string | null)[] | null;
  readonly calendarSourceId: string | null;
  readonly matchers: unknown[] | null;
  readonly effectiveFrom: string;
}

/**
 * Store a rotation, replacing whatever that person had.
 *
 * One plan per person is the whole model here: two rotations for one person is
 * a layering question nobody has asked for, and letting it happen by accident
 * would make the wall's answer depend on `priority` values nothing in the
 * interface explains.
 */
export function saveShiftPlan(db: SqliteDatabase, input: SaveShiftPlanInput): void {
  const at = Date.now();
  const write = db.transaction((plan: SaveShiftPlanInput): void => {
    db.prepare('DELETE FROM shift_plans WHERE person_id = ?').run(plan.personId);
    db.prepare(
      `INSERT INTO shift_plans
         (id, person_id, name, kind, effective_from, priority, anchor_date, cycle,
          calendar_source_id, matchers, consumes_events, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      plan.id,
      plan.personId,
      plan.name,
      plan.kind,
      plan.effectiveFrom,
      plan.anchorDate,
      plan.cycle === null ? null : JSON.stringify(plan.cycle),
      plan.calendarSourceId,
      plan.matchers === null ? null : JSON.stringify(plan.matchers),
      at,
      at,
    );
    db.prepare('UPDATE people SET has_shift_rotation = 1, updated_at = ? WHERE id = ?').run(
      at,
      plan.personId,
    );
    // The feature switch follows the data: a household with a rotation wants
    // to see it, and having to turn it on separately is a step that only ever
    // gets missed.
    db.prepare(
      `UPDATE household_settings SET shift_enabled = 1, updated_at = ? WHERE id = 'singleton'`,
    ).run(at);
  });
  write(input);
}

export function deleteShiftPlan(db: SqliteDatabase, id: string): void {
  const at = Date.now();
  const remove = db.transaction((planId: string): void => {
    const row = db.prepare('SELECT person_id AS personId FROM shift_plans WHERE id = ?').get(planId) as
      | { personId: string | null }
      | undefined;
    db.prepare('DELETE FROM shift_plans WHERE id = ?').run(planId);
    if (row?.personId != null) {
      db.prepare('UPDATE people SET has_shift_rotation = 0, updated_at = ? WHERE id = ?').run(
        at,
        row.personId,
      );
    }
    const left = db.prepare('SELECT COUNT(*) AS n FROM shift_plans').get() as { n: number };
    if (left.n === 0) {
      db.prepare(
        `UPDATE household_settings SET shift_enabled = 0, updated_at = ? WHERE id = 'singleton'`,
      ).run(at);
    }
  });
  remove(id);
}

export interface AdminScreenRow extends ScreenRow {
  readonly lastSeenAt: number | null;
  readonly appVersion: string | null;
}

/** Every screen, revoked ones included, for the admin list. */
export function readAdminScreens(db: SqliteDatabase): AdminScreenRow[] {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, theme, revoked_at AS revokedAt,
              orientation, rotation, allow_dismiss AS allowDismiss, timezone,
              daytime_theme AS daytimeTheme,
              daytime_starts_at AS daytimeStartsAt, daytime_ends_at AS daytimeEndsAt,
              display_today_events AS displayTodayEvents,
              display_next_days AS displayNextDays,
              display_horizon_weeks AS displayHorizonWeeks,
              display_blocks AS displayBlocks,
              layout_mode AS layoutMode, layout_aspect AS layoutAspect,
              last_seen_at AS lastSeenAt, app_version AS appVersion
         FROM screens ORDER BY name`,
    )
    .all() as AdminScreenRow[];
}

export interface ScreenSettings {
  readonly name: string;
  readonly orientation: string;
  readonly rotation: number;
  /** Null on any of these means "follow the household". */
  readonly theme: string | null;
  readonly timezone: string | null;
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  /** Whether this screen offers a way to acknowledge an interrupt. */
  readonly allowDismiss: boolean;
  /** How much this wall shows; null on any follows the household default. */
  readonly displayTodayEvents: number | null;
  readonly displayNextDays: number | null;
  readonly displayHorizonWeeks: number | null;
}

export function writeScreenSettings(db: SqliteDatabase, id: string, s: ScreenSettings): boolean {
  return (
    db
      .prepare(
        `UPDATE screens
            SET name = ?, orientation = ?, rotation = ?, theme = ?, timezone = ?,
                daytime_theme = ?, daytime_starts_at = ?, daytime_ends_at = ?,
                allow_dismiss = ?,
                display_today_events = ?, display_next_days = ?, display_horizon_weeks = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        s.name, s.orientation, s.rotation, s.theme, s.timezone,
        s.daytimeTheme, s.daytimeStartsAt, s.daytimeEndsAt,
        s.allowDismiss ? 1 : 0,
        s.displayTodayEvents, s.displayNextDays, s.displayHorizonWeeks,
        Date.now(), id,
      ).changes > 0
  );
}

/** A new token for an existing screen. The old one stops working at once. */
/**
 * Create a screen, unpaired but for its freshly issued token.
 *
 * The same row the `add-screen` tool writes, so the CLI and the admin form
 * produce identical screens — one code path minted the token before, and a
 * second one that drifted would be a screen the display layer treated subtly
 * differently depending on which button made it.
 */
/**
 * What a freshly issued pairing carries: the token's hash, plus the short
 * code's hash and when that code stops being accepted. The code fields are
 * optional because the CLI path can pair without ever showing a code.
 */
export interface PairingSecret {
  readonly tokenHash: string;
  readonly pairingCodeHash: string | null;
  readonly pairingCodeExpiresAt: number | null;
}

export function createScreen(
  db: SqliteDatabase,
  id: string,
  name: string,
  pairing: PairingSecret,
): void {
  const at = Date.now();
  db.prepare(
    `INSERT INTO screens
       (id, name, token_hash, pairing_code_hash, pairing_code_expires_at,
        token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, pairing.tokenHash, pairing.pairingCodeHash, pairing.pairingCodeExpiresAt, at, at, at);
}

export function rotateScreenToken(db: SqliteDatabase, id: string, pairing: PairingSecret): boolean {
  const at = Date.now();
  return (
    db
      .prepare(
        `UPDATE screens
            SET token_hash = ?, pairing_code_hash = ?, pairing_code_expires_at = ?,
                token_issued_at = ?, revoked_at = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        pairing.tokenHash, pairing.pairingCodeHash, pairing.pairingCodeExpiresAt, at, at, id,
      ).changes > 0
  );
}

export interface PairableScreen {
  readonly id: string;
  readonly pairingCodeHash: string;
}

/**
 * Screens a pairing code could still claim: not revoked, with a code set, and
 * inside its window. The caller compares the presented code against these in
 * constant time rather than matching on the hash in SQL, so a wrong code takes
 * the same work whichever screen it was aimed at.
 */
export function readPairableScreens(db: SqliteDatabase, now: number): PairableScreen[] {
  return db
    .prepare(
      `SELECT id, pairing_code_hash AS pairingCodeHash
         FROM screens
        WHERE revoked_at IS NULL
          AND pairing_code_hash IS NOT NULL
          AND pairing_code_expires_at IS NOT NULL
          AND pairing_code_expires_at > ?`,
    )
    .all(now) as PairableScreen[];
}

/**
 * Claim a screen with its pairing code: rotate to a fresh token and spend the
 * code so it can never be reused.
 *
 * The write is conditional on the code still being present, so two submissions
 * of the same code race to a single winner — the second finds nothing to claim
 * and fails, rather than minting a second token for one screen.
 */
export function claimScreenPairing(
  db: SqliteDatabase,
  id: string,
  expectedCodeHash: string,
  newTokenHash: string,
): boolean {
  const at = Date.now();
  return (
    db
      .prepare(
        `UPDATE screens
            SET token_hash = ?, token_issued_at = ?,
                pairing_code_hash = NULL, pairing_code_expires_at = NULL,
                revoked_at = NULL, updated_at = ?
          WHERE id = ? AND pairing_code_hash = ?`,
      )
      .run(newTokenHash, at, at, id, expectedCodeHash).changes > 0
  );
}

/**
 * Revoke rather than delete.
 *
 * The row is what makes a token stop working. Deleting it would free the
 * pairing to be reissued and leave no record that a screen ever existed, which
 * is the wrong answer when somebody is trying to work out what is still on
 * their wall.
 */
export function revokeScreen(db: SqliteDatabase, id: string): boolean {
  return (
    db.prepare(`UPDATE screens SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(Date.now(), Date.now(), id).changes > 0
  );
}

export interface WeatherSettings {
  readonly enabled: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export function readWeatherSettings(db: SqliteDatabase): WeatherSettings {
  const row = db
    .prepare(
      `SELECT weather_enabled AS enabled, latitude, longitude
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as { enabled: number; latitude: number | null; longitude: number | null } | undefined;
  return {
    enabled: row?.enabled === 1,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
  };
}

/**
 * Save the weather settings, and clear the cache when the location moves.
 *
 * A forecast for where the household used to live is worse than no forecast:
 * it is wrong and looks right. The resolved gridpoint goes with it, since that
 * is what pins the old location.
 */
export function writeWeatherSettings(db: SqliteDatabase, settings: WeatherSettings): void {
  const previous = readWeatherSettings(db);
  const moved =
    previous.latitude !== settings.latitude || previous.longitude !== settings.longitude;

  const write = db.transaction(() => {
    db.prepare(
      `UPDATE household_settings
          SET weather_enabled = ?, latitude = ?, longitude = ?, updated_at = ?
        WHERE id = 'singleton'`,
    ).run(settings.enabled ? 1 : 0, settings.latitude, settings.longitude, Date.now());

    if (moved) db.prepare('DELETE FROM weather_cache').run();

    /*
     * Switching a module on puts its block on the wall.
     *
     * The block order is stored, so a block that did not exist when a
     * household first saved their order can never appear in it — they would
     * turn weather on, wait an hour, and see nothing. Enabling is the moment
     * they asked for it, so that is the moment to add it. The order is still
     * theirs to change afterwards, and turning it off leaves the list alone.
     */
    if (settings.enabled) {
      const row = db
        .prepare(`SELECT display_blocks AS blocks FROM household_settings WHERE id = 'singleton'`)
        .get() as { blocks: string | null } | undefined;
      const blocks = (row?.blocks ?? '').split(',').map((b) => b.trim()).filter((b) => b !== '');
      if (!blocks.includes('weather')) {
        // After today, which is where the design puts the strip.
        const at = blocks.indexOf('now');
        blocks.splice(at < 0 ? blocks.length : at + 1, 0, 'weather');
        db.prepare(
          `UPDATE household_settings SET display_blocks = ?, updated_at = ? WHERE id = 'singleton'`,
        ).run(blocks.join(','), Date.now());
      }
    }
    // Bring the refresh forward so the panel fills in without a wait.
    db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'weather-sync'`).run();
  });
  write();
}

export interface UpdateState {
  readonly enabled: boolean;
  readonly lastCheckedAt: number | null;
  readonly latestVersion: string | null;
  readonly lastError: string | null;
}

export function readUpdateState(db: SqliteDatabase): UpdateState {
  const row = db
    .prepare(
      `SELECT update_check_enabled AS enabled, update_last_checked_at AS lastCheckedAt,
              update_latest_version AS latestVersion, update_last_error AS lastError
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as
    | { enabled: number; lastCheckedAt: number | null; latestVersion: string | null; lastError: string | null }
    | undefined;
  return {
    enabled: row?.enabled === 1,
    lastCheckedAt: row?.lastCheckedAt ?? null,
    latestVersion: row?.latestVersion ?? null,
    lastError: row?.lastError ?? null,
  };
}

/**
 * Turn the check on or off.
 *
 * Turning it off forgets what it had learned. A household that changed their
 * mind should not keep finding a version number on the page from a request
 * they have since withdrawn consent for.
 */
export function setUpdateCheckEnabled(db: SqliteDatabase, enabled: boolean): void {
  db.prepare(
    `UPDATE household_settings
        SET update_check_enabled = ?,
            update_latest_version = CASE WHEN ? THEN update_latest_version ELSE NULL END,
            update_last_error = CASE WHEN ? THEN update_last_error ELSE NULL END,
            update_last_checked_at = CASE WHEN ? THEN update_last_checked_at ELSE NULL END,
            updated_at = ?
      WHERE id = 'singleton'`,
  ).run(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 1 : 0, Date.now());
}

export function recordUpdateCheck(
  db: SqliteDatabase,
  at: number,
  latestVersion: string | null,
  error: string | null,
): void {
  db.prepare(
    `UPDATE household_settings
        SET update_last_checked_at = ?, update_latest_version = ?, update_last_error = ?,
            updated_at = ?
      WHERE id = 'singleton'`,
  ).run(at, latestVersion, error, at);
}

export interface DisplaySettings {
  readonly theme: string;
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  readonly todayEvents: number;
  readonly nextDays: number;
  readonly horizonWeeks: number;
  readonly blocks: string;
}

/**
 * Save what the household chose for the wall.
 *
 * Values are already validated by the caller; this only writes. `null` for the
 * daylight theme means "one theme all day", which is a real choice rather than
 * a missing value, so it is stored rather than skipped.
 */
export function writeDisplaySettings(db: SqliteDatabase, settings: DisplaySettings): void {
  db.prepare(
    `UPDATE household_settings
        SET theme = ?, daytime_theme = ?, daytime_starts_at = ?, daytime_ends_at = ?,
            display_today_events = ?, display_next_days = ?, display_horizon_weeks = ?,
            display_blocks = ?, updated_at = ?
      WHERE id = 'singleton'`,
  ).run(
    settings.theme,
    settings.daytimeTheme,
    settings.daytimeStartsAt,
    settings.daytimeEndsAt,
    settings.todayEvents,
    settings.nextDays,
    settings.horizonWeeks,
    settings.blocks,
    Date.now(),
  );
}

export interface AdminSourceRow {
  readonly id: string;
  readonly name: string;
  readonly urlHost: string | null;
  readonly enabled: number;
  readonly lastSyncAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly eventCount: number;
  readonly allowPrivateNetwork: number;
  readonly allowLoopback: number;
  readonly allowHttp: number;
  readonly color: string;
  readonly personId: string | null;
  readonly kind: string;
  readonly haEntityId: string | null;
}

/**
 * Every source, including disabled ones and every failure detail.
 *
 * Separate from `readSources`, which feeds the display and deliberately shows
 * only what renders. A calendar that is failing is exactly what the admin
 * screen exists to surface, so hiding it here would defeat the point.
 */
export function readAdminSources(db: SqliteDatabase): AdminSourceRow[] {
  return db
    .prepare(
      `SELECT id, name, url_host AS urlHost, enabled,
              last_sync_at AS lastSyncAt, last_success_at AS lastSuccessAt,
              last_error AS lastError, consecutive_failures AS consecutiveFailures,
              event_count AS eventCount,
              allow_private_network AS allowPrivateNetwork,
              allow_loopback AS allowLoopback, allow_http AS allowHttp,
              color, person_id AS personId, kind, ha_entity_id AS haEntityId
         FROM calendar_sources
        ORDER BY name`,
    )
    .all() as AdminSourceRow[];
}

/**
 * Remove a source and everything that points at it.
 *
 * Cached events cascade — foreign keys are on — but the scheduler row does
 * not, because its key is a string rather than a reference. Left behind, it
 * would have the scheduler fetching a source that no longer exists on every
 * tick, failing quietly forever.
 */
export function deleteSource(db: SqliteDatabase, id: string): boolean {
  const remove = db.transaction((sourceId: string): boolean => {
    // Both kinds. A source only ever has one of these, but deleting by kind
    // would mean reading the row first to find out which — and getting that
    // wrong leaves a job fetching a source that no longer exists, on every
    // tick, forever.
    db.prepare('DELETE FROM job_state WHERE key = ?').run(`ics-sync:${sourceId}`);
    db.prepare('DELETE FROM job_state WHERE key = ?').run(`ha-calendar-sync:${sourceId}`);
    return db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(sourceId).changes > 0;
  });
  return remove(id);
}

/** Bring a source's next sync forward. The scheduler picks it up on its next tick. */
export function requestSyncNow(db: SqliteDatabase, id: string): void {
  db.prepare(
    `UPDATE job_state
        SET next_run_at = 0, consecutive_failures = 0, running_since = NULL
      WHERE key IN (?, ?)`,
  ).run(`ics-sync:${id}`, `ha-calendar-sync:${id}`);
}

/**
 * The one household account, for trusting a Home Assistant ingress session.
 *
 * Exactly one, or nobody. Zero means the wizard has not run yet; more than one
 * is ambiguous — there is no mapping from a Home Assistant user to a particular
 * account here — and both fail closed to the normal login rather than guess
 * which account an ingress visitor should become.
 */
export function readHouseholdUser(
  db: SqliteDatabase,
): { readonly id: string; readonly email: string; readonly name: string } | undefined {
  try {
    const rows = db.prepare('SELECT id, email, name FROM user LIMIT 2').all() as {
      id: string;
      email: string;
      name: string;
    }[];
    return rows.length === 1 ? rows[0] : undefined;
  } catch {
    return undefined;
  }
}

export function readSetupState(db: SqliteDatabase): SetupState {
  const hasUsers = countUsers(db) > 0;
  let complete = false;
  try {
    const row = db
      .prepare(`SELECT setup_completed_at AS setupCompletedAt FROM household_settings WHERE id = 'singleton'`)
      .get() as { setupCompletedAt: number | null } | undefined;
    complete = row?.setupCompletedAt != null;
  } catch {
    complete = false;
  }
  return { hasUsers, complete };
}

export interface ScreenRow {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly theme: string | null;
  readonly revokedAt: number | null;
  readonly orientation: string;
  readonly rotation: number;
  readonly timezone: string | null;
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  readonly allowDismiss: number;
  /** Per-screen display overrides; null follows the household. */
  readonly displayTodayEvents: number | null;
  readonly displayNextDays: number | null;
  readonly displayHorizonWeeks: number | null;
  readonly displayBlocks: string | null;
  readonly layoutMode: string | null;
  readonly layoutAspect: number | null;
}

export function readScreens(db: SqliteDatabase): ScreenRow[] {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, theme, revoked_at AS revokedAt,
              orientation, rotation, allow_dismiss AS allowDismiss, timezone,
              daytime_theme AS daytimeTheme,
              daytime_starts_at AS daytimeStartsAt, daytime_ends_at AS daytimeEndsAt,
              display_today_events AS displayTodayEvents,
              display_next_days AS displayNextDays,
              display_horizon_weeks AS displayHorizonWeeks,
              display_blocks AS displayBlocks,
              layout_mode AS layoutMode, layout_aspect AS layoutAspect
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
