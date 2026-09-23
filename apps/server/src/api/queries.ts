import { randomBytes, randomUUID } from 'node:crypto';
import type { ShiftOverride, ShiftPlan, ShiftType } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import { DEFAULT_TIMEZONE } from '../timezone.js';
import { nextPersonColor } from './palette.js';
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
  // The shared fallback, not a literal. This used to say `America/New_York`
  // while the wizard preselected `Etc/UTC`, so the boot log and the screen that
  // chooses the zone disagreed on a fresh install. See `src/timezone.ts`.
  timezone: DEFAULT_TIMEZONE,
  // No theme here, and none in the row (RFC 015 phase 2): a wall names its own.
  shiftEnabled: 0,
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  clock24: 1,
  weekStart: 'sunday',
  layoutMode: 'auto',
  layoutAspect: 0.5625,
  layoutLandscapeAspect: 1.7778,
  layoutBackground: null,
  layoutLandscapeBackground: null,
};

export function readHousehold(db: SqliteDatabase): HouseholdRow {
  const row = db
    .prepare(
      `SELECT timezone,
              shift_enabled AS shiftEnabled,
              display_today_events AS displayTodayEvents,
              display_next_days AS displayNextDays,
              display_horizon_weeks AS displayHorizonWeeks,
              display_blocks AS displayBlocks,
              clock_24 AS clock24,
              week_start AS weekStart,
              layout_mode AS layoutMode,
              layout_aspect AS layoutAspect,
              layout_landscape_aspect AS layoutLandscapeAspect,
              layout_background AS layoutBackground,
              layout_landscape_background AS layoutLandscapeBackground
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as HouseholdRow | undefined;
  // Defaults rather than an error. A missing settings row means setup has not
  // run, and the display should still boot and say so.
  return row ?? HOUSEHOLD_DEFAULTS;
}

/**
 * The placed widgets for one canvas — a wall's own, or the shared default, on
 * one orientation.
 *
 * `screenId` null reads the default layout (rows with no owner); a screen id
 * reads that wall's own. `orientation` picks the portrait or landscape canvas —
 * a display authors both (RFC 005). The `config` column is JSON this process
 * wrote, parsed leniently because a row that will not parse is one missing
 * widget, never a manifest that fails to build — rule nine. `buildLayout` clamps
 * the coordinates and checks the type; this only turns rows into the shape it
 * expects.
 */
export function readLayoutWidgets(
  db: SqliteDatabase,
  screenId: string | null = null,
  orientation: 'portrait' | 'landscape' = 'portrait',
  /*
   * Which of the wall's scheduled canvases (RFC 014 §5.2). Null — the default
   * — is what every caller that does not name one reads, and that default is
   * the whole compatibility story: the panel following a wall, the template
   * writer, the copy and the seed all read and write the default slot and
   * never see a named one, so a battery panel cannot be handed a schedule it
   * could not honour.
   */
  slot: string | null = null,
): PlacedWidgetRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, x, y, w, h, z, config
         FROM layout_widgets
        WHERE screen_id IS ? AND orientation = ? AND slot IS ?
        ORDER BY z, created_at`,
    )
    .all(screenId, orientation, slot) as {
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
 * Save one canvas at once — for one wall, or the shared default, one orientation.
 *
 * `screenId` null writes the default: the mode on the household, the widgets with
 * no owner. A screen id writes that wall: the mode on the screen row (a non-null
 * `layout_mode` there is what marks the wall as having its own canvas), the
 * widgets owned by it. `mode` is per display (shared across the two canvases);
 * `orientation` says which canvas's widgets and which aspect column to write, so
 * saving the portrait canvas never disturbs the landscape one (RFC 005).
 *
 * Replace rather than diff, because the editor sends the canvas it has and the
 * simplest correct thing is to make the database match it. One transaction per
 * owner-and-orientation, so a wall polling mid-save reads the old canvas or the
 * new one, never half of either — and only that owner's rows on that orientation
 * are touched. The rows are trusted here because the boundary validated them; the
 * display clamps again in `buildLayout` regardless.
 */
/**
 * Clear a screen's free-form canvas back to nothing — both orientations, the
 * stored aspects and backgrounds, and the freeform flag. This is the reset an
 * e-paper panel wants: with no canvas the frame renderer falls back to the
 * built-in fixed layout, which is what the panel drew before anyone arranged
 * it. Wall displays never come here — their reset re-applies the Classic
 * template instead, because a wall with no canvas would draw the "nothing
 * yet" note rather than a calendar (rule nine).
 */
export function clearLayout(db: SqliteDatabase, screenId: string): void {
  const at = Date.now();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE screens SET layout_mode = NULL, layout_follows = NULL, layout_aspect = NULL,
        layout_landscape_aspect = NULL, layout_background = NULL,
        layout_landscape_background = NULL, updated_at = ? WHERE id = ?`,
    ).run(at, screenId);
    db.prepare('DELETE FROM layout_widgets WHERE screen_id IS ?').run(screenId);
    // Every slot went with the rows above; a schedule naming them would be a
    // schedule for canvases that no longer exist.
    db.prepare('DELETE FROM layout_schedule WHERE screen_id = ?').run(screenId);
  });
  tx();
}

/**
 * The named canvases a screen holds, in name order (RFC 014 §5.2).
 *
 * A slot exists by having a widget on it, in either orientation; the default
 * canvas is not in this list because it has no name. Read off the rows rather
 * than off a table of slots, so a slot whose last widget was removed simply
 * stops existing, and the schedule form stops offering it.
 */
export function readLayoutSlots(db: SqliteDatabase, screenId: string | null): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT slot FROM layout_widgets
        WHERE screen_id IS ? AND slot IS NOT NULL ORDER BY slot`,
    )
    .all(screenId) as { slot: string }[];
  return rows.map((row) => row.slot);
}

export interface LayoutScheduleRow {
  readonly slot: string;
  readonly from: string;
  readonly to: string;
}

/** The screen's schedule, in the order the household wrote it. */
export function readLayoutSchedule(db: SqliteDatabase, screenId: string | null): LayoutScheduleRow[] {
  if (screenId === null) return [];
  return db
    .prepare(
      `SELECT slot, from_hhmm AS "from", to_hhmm AS "to"
         FROM layout_schedule WHERE screen_id = ? ORDER BY position`,
    )
    .all(screenId) as LayoutScheduleRow[];
}

/**
 * Replace the screen's schedule whole.
 *
 * Whole rather than row by row, for the reason `replaceLayout` is: the form
 * posts every row it renders, so what it posts *is* the schedule, and a
 * partial write would leave a row nobody can see on the page. The rows are
 * trusted here because the handler validated them against `layout-slots.ts`.
 */
export function replaceLayoutSchedule(
  db: SqliteDatabase,
  screenId: string,
  rows: readonly LayoutScheduleRow[],
): void {
  const at = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM layout_schedule WHERE screen_id = ?').run(screenId);
    const insert = db.prepare(
      `INSERT INTO layout_schedule (id, screen_id, position, slot, from_hhmm, to_hhmm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((row, position) => {
      insert.run(randomUUID(), screenId, position, row.slot, row.from, row.to, at, at);
    });
  });
  tx();
}

/**
 * Remove one named canvas: its widgets on both orientations, and every
 * schedule row that named it — a window pointing at a canvas that is gone
 * would draw the default anyway, and a row the settings page cannot explain
 * is worse than no row.
 */
export function deleteLayoutSlot(db: SqliteDatabase, screenId: string, slot: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM layout_widgets WHERE screen_id IS ? AND slot = ?').run(screenId, slot);
    db.prepare('DELETE FROM layout_schedule WHERE screen_id = ? AND slot = ?').run(screenId, slot);
  });
  tx();
}

/**
 * Set what an e-paper panel draws (RFC 005, direction B).
 *
 * The three states of `panelCanvasOwner`, written: `null` mode is the built-in
 * layout, `freeform` is the panel's own canvas, `follow` is a wall's — with
 * `follows` naming it, or null for the Default display.
 *
 * The panel's own widgets are deliberately *left alone* when it starts
 * following. A household who tries the wall's arrangement and goes back should
 * find what they arranged still there; deleting it would make an experiment
 * cost them their work, and the rows are simply not read while it follows.
 */
export function setPanelSource(
  db: SqliteDatabase,
  screenId: string,
  mode: 'builtin' | 'own' | 'follow',
  follows: string | null,
): void {
  db.prepare(`UPDATE screens SET layout_mode = ?, layout_follows = ?, updated_at = ? WHERE id = ?`).run(
    mode === 'builtin' ? null : mode === 'own' ? 'freeform' : 'follow',
    mode === 'follow' ? follows : null,
    Date.now(),
    screenId,
  );
}

/** Toggle Option C's LAN-only restriction on an eInk screen's frame endpoint. */
export function setScreenLanOnly(db: SqliteDatabase, screenId: string, lanOnly: boolean): void {
  db.prepare(`UPDATE screens SET lan_only = ?, updated_at = ? WHERE id = ?`).run(
    lanOnly ? 1 : 0,
    Date.now(),
    screenId,
  );
}

/**
 * Record whether the last frame request could be traced to a real visitor.
 *
 * Its own writer rather than a fifth argument to `touchScreen`, and the reason
 * is the difference between the two absences: `touchScreen` runs *after* a
 * successful render, and this has to run on a **refused** request too, since a
 * panel that has gone dark because of `lan_only` is exactly when a household
 * needs to be told what the guard could see. Deliberately not defaulted —
 * `null` clears the note, so a proxy that goes away stops being reported.
 *
 * `updated_at` is left alone: nobody edited this screen, and moving it would
 * report an observation about the network as a change the household made.
 */
export function recordFrameForwarding(
  db: SqliteDatabase,
  screenId: string,
  note: string | null,
): void {
  db.prepare(`UPDATE screens SET last_seen_forwarding = ? WHERE id = ?`).run(note, screenId);
}

export function replaceLayout(
  db: SqliteDatabase,
  screenId: string | null,
  orientation: 'portrait' | 'landscape',
  layout: {
    readonly mode: string;
    readonly aspect: number;
    readonly widgets: readonly LayoutWidgetInput[];
    /** The canvas background as JSON, or null for none (RFC 005 Phase 3). */
    readonly background: string | null;
  },
  /** Which scheduled canvas (RFC 014 §5.2); null is the default. */
  slot: string | null = null,
): void {
  const at = Date.now();
  // The aspect and background columns depend on which canvas is being written.
  const aspectCol = orientation === 'landscape' ? 'layout_landscape_aspect' : 'layout_aspect';
  const bgCol = orientation === 'landscape' ? 'layout_landscape_background' : 'layout_background';
  const tx = db.transaction(() => {
    if (screenId === null) {
      db.prepare(
        `UPDATE household_settings SET layout_mode = ?, ${aspectCol} = ?, ${bgCol} = ?, updated_at = ?
          WHERE id = 'singleton'`,
      ).run(layout.mode, layout.aspect, layout.background, at);
    } else {
      db.prepare(
        `UPDATE screens SET layout_mode = ?, ${aspectCol} = ?, ${bgCol} = ?, updated_at = ? WHERE id = ?`,
      ).run(layout.mode, layout.aspect, layout.background, at, screenId);
    }

    // One canvas: this orientation, this slot. The other slots' rows on the
    // same orientation are somebody else's arrangement and are left alone.
    db.prepare(
      'DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = ? AND slot IS ?',
    ).run(screenId, orientation, slot);
    const insert = db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, slot, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    layout.widgets.forEach((widget, index) => {
      insert.run(
        widget.id,
        screenId,
        orientation,
        slot,
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
 * Whose canvas an e-paper panel draws, and whether it is somebody else's.
 *
 * A panel is not a wall, and this is deliberately not `effectiveDisplay`. A wall
 * with no canvas of its own follows the household; a panel with none draws its
 * *built-in* fixed layout, because that layout was designed for the medium and
 * a colour arrangement inherited by accident would be a worse panel, not a
 * better one. So there are three states rather than two, and the third is the
 * one direction B needed to exist:
 *
 * - `layout_mode` null (or anything else) — the built-in layout. `undefined`.
 * - `freeform` — the panel's own canvas, arranged in its own designer.
 * - `follow` — a wall's canvas, live: move a box on the wall and the panel
 *   moves with it. `layout_follows` names the wall, or is null for the Default
 *   display's canvas.
 *
 * Following is what makes `config.ink` worth having. Copying a wall's canvas
 * onto a panel was always possible and gives two canvases that drift apart the
 * first time somebody moves a box; following gives one canvas on two media, and
 * the per-widget ink override is how the one canvas says something different in
 * black and white.
 *
 * This reads the panel's own row and nothing else, so it cannot see whether
 * the wall a `follow` names is still paired. It used to claim here that such
 * a follow "reads as a canvas with no widgets" — false, since revoking leaves
 * the widgets in place. `livePanelCanvasOwner` below is what a frame renderer
 * asks.
 */
export function panelCanvasOwner(screen: {
  readonly id?: string;
  readonly layoutMode?: string | null;
  readonly layoutFollows?: string | null;
}): string | null | undefined {
  if (screen.layoutMode === 'freeform') return screen.id ?? null;
  if (screen.layoutMode === 'follow') return screen.layoutFollows ?? null;
  return undefined;
}

/**
 * `panelCanvasOwner`, asked of the database as well: a follow whose target is
 * revoked, or gone, is no canvas (RFC 016 §3.5).
 *
 * The pure resolver above reads only the panel's own row, and its docstring
 * claimed that a `follow` pointing at a revoked wall "reads as a canvas with no
 * widgets, which falls back to the built-in layout". It did not. Revoking a
 * wall leaves its widgets where they are — that is the whole point of revoking
 * rather than deleting — so a panel following a revoked wall went on drawing
 * that wall's arrangement, and a household who unpaired a wall and expected it
 * gone found it still on the hall panel. And a target that has been *deleted*
 * would read as `[]`, which is the Blank frame now rather than the built-in
 * one. Both are `undefined` here — the built-in view — which is the answer a
 * panel with no owner has always had.
 *
 * Every renderer of a panel's frame asks this one rather than the pure
 * function, so the glass and the design page cannot disagree about it. The
 * pure function stays for the callers that ask the question the other way
 * round (which panels follow *this* wall), where the wall is one being edited
 * and is live by construction.
 */
export function livePanelCanvasOwner(
  db: SqliteDatabase,
  screen: {
    readonly id?: string;
    readonly layoutMode?: string | null;
    readonly layoutFollows?: string | null;
  },
): string | null | undefined {
  const owner = panelCanvasOwner(screen);
  if (screen.layoutMode !== 'follow' || typeof owner !== 'string') return owner;
  const target = db.prepare('SELECT revoked_at AS revokedAt FROM screens WHERE id = ?').get(owner) as
    | { revokedAt: number | null }
    | undefined;
  return target === undefined || target.revokedAt !== null ? undefined : owner;
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
 *
 * **`layoutOwner: null` is a belt now, not a mechanism.** It used to be the
 * common case — a wall with no canvas drew the shared Default wall's — and that
 * canvas is retired: `retireDefaultWall` copied it onto every screen that was
 * inheriting it, and every path that creates a screen seeds one. So a screen
 * reaching this branch is a row nothing in this codebase writes. The household's
 * own widgets are left in place rather than deleted precisely so that row still
 * draws something if one ever appears, which is rule nine and costs nothing.
 */
export function effectiveDisplay(
  household: HouseholdRow,
  screen: {
    readonly id?: string;
    readonly displayTodayEvents?: number | null;
    readonly displayNextDays?: number | null;
    readonly displayHorizonWeeks?: number | null;
    readonly displayBlocks?: string | null;
    readonly clock24?: number | null;
    readonly layoutMode?: string | null;
    readonly layoutAspect?: number | null;
    readonly layoutLandscapeAspect?: number | null;
    readonly layoutBackground?: string | null;
    readonly layoutLandscapeBackground?: string | null;
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
      clock24: screen.clock24 ?? household.clock24,
      layoutMode: screen.layoutMode ?? household.layoutMode,
      layoutAspect: screen.layoutAspect ?? household.layoutAspect,
      layoutLandscapeAspect: screen.layoutLandscapeAspect ?? household.layoutLandscapeAspect,
      // A wall with its own canvas owns its background too; otherwise the
      // household's. `undefined` (screen has none) falls through to the household;
      // `null` cannot occur here because only a canvas-owning screen is read.
      layoutBackground: screen.layoutBackground ?? household.layoutBackground,
      layoutLandscapeBackground: screen.layoutLandscapeBackground ?? household.layoutLandscapeBackground,
    },
    layoutOwner: ownsLayout ? (screen.id ?? null) : null,
  };
}

export function readSources(db: SqliteDatabase): SourceRow[] {
  return db
    .prepare(
      `SELECT id, name, color, visible, show_in_grid AS showInGrid, person_id AS personId,
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

/** A shift type as the admin edits it — the id and sort order the core type omits. */
export interface ShiftTypeRow extends ShiftType {
  readonly id: string;
  readonly sortOrder: number;
}

export function readShiftTypes(db: SqliteDatabase): ShiftTypeRow[] {
  return db
    .prepare(
      `SELECT id, key, label, short_code AS shortCode, color_token AS colorToken,
              color, start_time AS startTime, end_time AS endTime,
              is_working AS isWorking, sort_order AS sortOrder
         FROM shift_types ORDER BY sort_order, key`,
    )
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      const opt = (value: unknown): string | undefined =>
        typeof value === 'string' && value !== '' ? value : undefined;
      const color = opt(record['color']);
      const startTime = opt(record['startTime']);
      const endTime = opt(record['endTime']);
      return {
        id: String(record['id']),
        key: String(record['key']),
        label: String(record['label']),
        shortCode: String(record['shortCode']),
        colorToken: String(record['colorToken']),
        ...(color !== undefined ? { color } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        isWorking: record['isWorking'] === 1,
        sortOrder: Number(record['sortOrder'] ?? 0),
      };
    });
}

/** A new or edited shift type. `key` is stable once set — only the rest changes. */
export interface ShiftTypeInput {
  readonly label: string;
  readonly shortCode: string;
  readonly colorToken: string;
  readonly color: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly isWorking: boolean;
}

/** Create a shift type. `key` is derived from the label, made unique. */
export function createShiftType(db: SqliteDatabase, input: ShiftTypeInput): void {
  const at = Date.now();
  const id = randomBytes(8).toString('hex');
  const key = uniqueShiftKey(db, input.label);
  const next =
    (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM shift_types').get() as { n: number }).n + 1;
  db.prepare(
    `INSERT INTO shift_types
       (id, key, label, short_code, color_token, color, start_time, end_time, is_working, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, key, input.label, input.shortCode, input.colorToken, input.color, input.startTime, input.endTime, input.isWorking ? 1 : 0, next, at, at);
}

/** Update everything about a type but its stable key. */
export function updateShiftType(db: SqliteDatabase, id: string, input: ShiftTypeInput): void {
  db.prepare(
    `UPDATE shift_types SET label = ?, short_code = ?, color_token = ?, color = ?,
        start_time = ?, end_time = ?, is_working = ?, updated_at = ? WHERE id = ?`,
  ).run(input.label, input.shortCode, input.colorToken, input.color, input.startTime, input.endTime, input.isWorking ? 1 : 0, Date.now(), id);
}

/**
 * Remove a shift type — unless a rotation still references its key, which would
 * leave those days pointing at nothing. The caller surfaces the refusal.
 */
export function deleteShiftType(db: SqliteDatabase, id: string): { ok: true } | { ok: false; message: string } {
  const row = db.prepare('SELECT key FROM shift_types WHERE id = ?').get(id) as { key: string } | undefined;
  if (row === undefined) return { ok: true };
  const used = db
    .prepare(
      `SELECT COUNT(*) AS n FROM shift_plans WHERE cycle LIKE ? OR matchers LIKE ?`,
    )
    .get(`%"${row.key}"%`, `%"${row.key}"%`) as { n: number };
  if (used.n > 0) {
    return { ok: false, message: 'A rotation still uses this type. Change or remove those rotations first.' };
  }
  db.prepare('DELETE FROM shift_types WHERE id = ?').run(id);
  return { ok: true };
}

/** Nudge a person up or down in the order the wall lists them and the legend. */
export function movePerson(db: SqliteDatabase, id: string, direction: 'up' | 'down'): void {
  const rows = db
    .prepare('SELECT id, sort_order AS sortOrder FROM people ORDER BY sort_order, name')
    .all() as { id: string; sortOrder: number }[];
  const index = rows.findIndex((r) => r.id === id);
  if (index < 0) return;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= rows.length) return;
  const at = Date.now();
  const a = rows[index]!;
  const b = rows[swapWith]!;
  const tx = db.transaction(() => {
    db.prepare('UPDATE people SET sort_order = ?, updated_at = ? WHERE id = ?').run(b.sortOrder, at, a.id);
    db.prepare('UPDATE people SET sort_order = ?, updated_at = ? WHERE id = ?').run(a.sortOrder, at, b.id);
  });
  tx();
}

/** Nudge a type up or down in the order the wall lists them. */
export function moveShiftType(db: SqliteDatabase, id: string, direction: 'up' | 'down'): void {
  const rows = db
    .prepare('SELECT id, sort_order AS sortOrder FROM shift_types ORDER BY sort_order, key')
    .all() as { id: string; sortOrder: number }[];
  const index = rows.findIndex((r) => r.id === id);
  if (index < 0) return;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= rows.length) return;
  const at = Date.now();
  const a = rows[index]!;
  const b = rows[swapWith]!;
  const tx = db.transaction(() => {
    db.prepare('UPDATE shift_types SET sort_order = ?, updated_at = ? WHERE id = ?').run(b.sortOrder, at, a.id);
    db.prepare('UPDATE shift_types SET sort_order = ?, updated_at = ? WHERE id = ?').run(a.sortOrder, at, b.id);
  });
  tx();
}

/** A stable, unique key from a label: lower-kebab, suffixed if taken. */
function uniqueShiftKey(db: SqliteDatabase, label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shift';
  let key = base;
  let n = 1;
  const exists = db.prepare('SELECT 1 FROM shift_types WHERE key = ?');
  while (exists.get(key) !== undefined) key = `${base}-${++n}`;
  return key;
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

/**
 * Add a person.
 *
 * `color` is optional and an absent one rotates the shared palette rather than
 * repeating one fixed blue — see `palette.ts`. The People form still sends a
 * colour and is still authoritative when it does; what it sends is the same
 * rotated value, pre-filled into its picker, so what the household is shown
 * before they press Add is what they get.
 */
export function createPerson(db: SqliteDatabase, id: string, name: string, color?: string): void {
  const at = Date.now();
  const hue = color ?? nextPersonColor(db);
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM people').get() as {
    n: number;
  };
  db.prepare(
    `INSERT INTO people (id, name, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, hue, next.n, at, at);
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

/**
 * What a household may change about a stored feed, as opposed to where it
 * points.
 *
 * Deliberately no `url`: a changed address is a different feed, and "remove it
 * and add it again" is the right journey for that. A changed *credential* is
 * the opposite — an app password expires, is revoked, is reissued termly by a
 * school office — so it belongs here, and the two fields carrying it read the
 * way `undefined` reads everywhere else in this codebase: nothing to say.
 */
export interface SourceSettings {
  readonly name: string;
  readonly color: string;
  readonly personId: string | null;
  readonly enabled: boolean;
  readonly showInGrid: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly allowLoopback: boolean;
  readonly allowHttp: boolean;
  /** The account to sign in as. `undefined` leaves it alone; `null` clears it. */
  readonly authUsername?: string | null;
  /**
   * A new password, already sealed. `undefined` **keeps what is stored** and
   * `null` removes it.
   *
   * Those have to be two different values and neither can be the empty string,
   * which is the whole shape of §4.5: the row holds an envelope rather than
   * plaintext, so there is nothing to prefill an edit form with, and blank is
   * the form's only honest reading of "I did not touch this field". Blank
   * cannot *also* mean "delete it" — that is indistinguishable from having
   * nothing to say — so removing a credential a feed no longer needs is its own
   * control rather than an inferred one.
   */
  readonly authPasswordEncrypted?: string | null;
}

export function updateSource(db: SqliteDatabase, id: string, settings: SourceSettings): boolean {
  const before = db
    .prepare(
      `SELECT auth_username AS authUsername,
              auth_password_encrypted AS authPasswordEncrypted
         FROM calendar_sources WHERE id = ?`,
    )
    .get(id) as { authUsername: string | null; authPasswordEncrypted: string | null } | undefined;
  if (before === undefined) return false;

  const username = settings.authUsername === undefined ? before.authUsername : settings.authUsername;
  const password =
    settings.authPasswordEncrypted === undefined
      ? before.authPasswordEncrypted
      : settings.authPasswordEncrypted;

  const changed =
    db
      .prepare(
        `UPDATE calendar_sources
            SET name = ?, color = ?, person_id = ?, enabled = ?, show_in_grid = ?,
                allow_private_network = ?, allow_loopback = ?, allow_http = ?,
                auth_username = ?, auth_password_encrypted = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        settings.name,
        settings.color,
        settings.personId,
        settings.enabled ? 1 : 0,
        settings.showInGrid ? 1 : 0,
        settings.allowPrivateNetwork ? 1 : 0,
        settings.allowLoopback ? 1 : 0,
        settings.allowHttp ? 1 : 0,
        username,
        password,
        Date.now(),
        id,
      ).changes > 0;

  /*
   * A changed credential brings the next sync forward, and that is the *other*
   * half of not retrying a refused sign-in (RFC 013 §4.6).
   *
   * `ics-sync` holds a feed whose password was refused for a week rather than
   * hammering the household's own account with a wrong password on a
   * fifteen-minute interval. What makes that a hold rather than a wall is this:
   * entering a new password is the thing that actually recovers it, so it has
   * to be the thing that re-arms the job. Without it, a household would fix
   * their password and watch nothing happen for a week — the acknowledgement
   * bug one screen along, where pressing OK cleared a rule and promoted the
   * next one.
   *
   * Only on an actual change, so saving a colour does not drag every feed's
   * sync forward.
   */
  if (
    changed &&
    (username !== before.authUsername || password !== before.authPasswordEncrypted)
  ) {
    requestSyncNow(db, id);
  }

  return changed;
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
  /** Who last used this screen's token — a household's own detective control. */
  readonly lastSeenIp: string | null;
  /**
   * Whether `lan_only` could see past a proxy on the last frame request — a
   * `ForwardingNote` from `http/lan-guard.ts`, or null when there is nothing
   * to say. Read by the panel's settings page, which cannot observe it itself.
   */
  readonly lastSeenForwarding: string | null;
  readonly appVersion: string | null;
  /** The canvas gutter step, 0-4; null is today's spacing (RFC 014 §4.4). */
  readonly layoutGutter: number | null;
  /** The wall's default style lane as stored JSON; null is none (RFC 014 §4.1). */
  readonly layoutStyle: string | null;
  /** The viewport this screen last reported, for the editor's "match" (RFC 005). */
  readonly reportW: number | null;
  readonly reportH: number | null;
}

/** Every screen, revoked ones included, for the admin list. */
export function readAdminScreens(db: SqliteDatabase): AdminScreenRow[] {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, theme, revoked_at AS revokedAt,
              orientation, rotation, allow_dismiss AS allowDismiss, allow_chores AS allowChores,
              allow_todo AS allowTodo,
              lan_only AS lanOnly, timezone,
              kind, panel_width AS panelWidth, panel_height AS panelHeight,
              panel_colour AS panelColour,
              panel_width_mm AS panelWidthMm, panel_height_mm AS panelHeightMm,
              read_distance_mm AS readDistanceMm,
              daytime_theme AS daytimeTheme,
              daytime_starts_at AS daytimeStartsAt, daytime_ends_at AS daytimeEndsAt,
              display_today_events AS displayTodayEvents,
              display_next_days AS displayNextDays,
              display_horizon_weeks AS displayHorizonWeeks,
              display_blocks AS displayBlocks,
              clock_24 AS clock24,
              layout_mode AS layoutMode, layout_follows AS layoutFollows,
              layout_aspect AS layoutAspect,
              layout_landscape_aspect AS layoutLandscapeAspect,
              layout_background AS layoutBackground,
              layout_landscape_background AS layoutLandscapeBackground,
              layout_gutter AS layoutGutter, layout_style AS layoutStyle,
              report_w AS reportW, report_h AS reportH,
              last_seen_at AS lastSeenAt, last_seen_ip AS lastSeenIp,
              last_seen_forwarding AS lastSeenForwarding, app_version AS appVersion
         FROM screens ORDER BY name COLLATE NOCASE`,
    )
    .all() as AdminScreenRow[];
}

export interface ScreenSettings {
  readonly name: string;
  readonly orientation: string;
  readonly rotation: number;
  /**
   * The wall's own theme, always (RFC 015 phase 2). There is no household
   * theme to follow, and the `CHECK` on `screens` refuses a null here.
   */
  readonly theme: string;
  /** Null on any of these means "follow the household". */
  readonly timezone: string | null;
  /** Null is the same theme all day — a real answer, not a fallback. */
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  /** Whether this screen offers a way to acknowledge an interrupt. */
  readonly allowDismiss: boolean;
  /** Whether this screen offers a way to tick a chore off (RFC 008 phase 3). */
  readonly allowChores: boolean;
  /**
   * Whether this screen offers a way to tick a Home Assistant to-do item off
   * (RFC 012 phase 2). Its own switch, because it is its own risk: a chore is
   * a claim recorded in this database and a to-do item is data on a list the
   * household's phones are synced to.
   */
  readonly allowTodo: boolean;
  /** How much this wall shows; null on any follows the household default. */
  readonly displayTodayEvents: number | null;
  readonly displayNextDays: number | null;
  readonly displayHorizonWeeks: number | null;
  /** 24-hour override: 1 forces 24-hour, 0 forces 12-hour, null follows household. */
  readonly clock24: number | null;
  /**
   * The physical facts, in millimetres, or null on all three.
   *
   * All-or-nothing rather than three independent overrides: a size with no
   * reading distance derives nothing, so two of the three set is the same
   * state as none, and keeping "unmeasured" a single state is what makes
   * absence mean unchanged everywhere downstream.
   */
  readonly panelWidthMm: number | null;
  readonly panelHeightMm: number | null;
  readonly readDistanceMm: number | null;
  /**
   * The canvas gutter step, 0-4, or null for "never asked" (RFC 014 §4.4).
   *
   * The form always renders one segment checked — null and step 4 draw the
   * identical wall, so the control can honestly check `Normal` on a wall that
   * has never been asked, where a grid with nothing chosen would read as "this
   * wall has no spacing" (RFC 015 §3.5's rule for the theme cards, one row
   * along). So a save from a page rendered since this shipped always carries a
   * step.
   *
   * Null is what a page rendered *before* it posts, and the handler resolves
   * that to whatever the column already holds rather than to a guess — so a
   * stale tab saving a timezone cannot quietly write a spacing nobody chose,
   * and a wall that has never been saved keeps the null that makes its
   * manifest byte-identical to the document it sent before this column
   * existed.
   */
  readonly layoutGutter: number | null;
  /**
   * The wall's default style lane, as JSON — the colours, faces, weight,
   * tracking and inset every widget starts from (RFC 014 §4.1). Null is
   * "follow the theme", which is what every wall drew before the column
   * existed; the handler resolves an absent field the way it resolves the
   * gutter's, to whatever the column already holds, so a page rendered before
   * the row existed cannot clear a lane nobody touched.
   */
  readonly layoutStyle: string | null;
}

export function writeScreenSettings(db: SqliteDatabase, id: string, s: ScreenSettings): boolean {
  return (
    db
      .prepare(
        `UPDATE screens
            SET name = ?, orientation = ?, rotation = ?, theme = ?, timezone = ?,
                daytime_theme = ?, daytime_starts_at = ?, daytime_ends_at = ?,
                allow_dismiss = ?, allow_chores = ?, allow_todo = ?,
                display_today_events = ?, display_next_days = ?, display_horizon_weeks = ?,
                clock_24 = ?,
                panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ?,
                layout_gutter = ?, layout_style = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        s.name, s.orientation, s.rotation, s.theme, s.timezone,
        s.daytimeTheme, s.daytimeStartsAt, s.daytimeEndsAt,
        s.allowDismiss ? 1 : 0, s.allowChores ? 1 : 0, s.allowTodo ? 1 : 0,
        s.displayTodayEvents, s.displayNextDays, s.displayHorizonWeeks,
        s.clock24, s.panelWidthMm, s.panelHeightMm, s.readDistanceMm,
        s.layoutGutter, s.layoutStyle,
        Date.now(), id,
      ).changes > 0
  );
}

/**
 * The facts about the hardware a screen is, written on their own.
 *
 * The add pages collect the mounting and the physical size *before* a screen
 * has a name to change, a theme to inherit or a density to override, so they
 * need a writer that touches those four columns and nothing else.
 * `writeScreenSettings` is the settings form's, and it writes the whole row —
 * calling it here would mean inventing values for a dozen fields the household
 * has not been asked about yet, and every one of those inventions would be a
 * default this code, rather than the settings page, had chosen.
 *
 * Null is a real answer on the three millimetre columns and means "not
 * measured", exactly as it does everywhere else: a wall with no size draws as
 * it always has (`physicalWall` refuses two of three), so an add form somebody
 * skipped writes three nulls rather than a guess.
 */
export function writeScreenHardware(
  db: SqliteDatabase,
  id: string,
  hardware: {
    readonly rotation: number;
    readonly panelWidthMm: number | null;
    readonly panelHeightMm: number | null;
    readonly readDistanceMm: number | null;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE screens
            SET rotation = ?, panel_width_mm = ?, panel_height_mm = ?,
                read_distance_mm = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        hardware.rotation,
        hardware.panelWidthMm,
        hardware.panelHeightMm,
        hardware.readDistanceMm,
        Date.now(),
        id,
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

/**
 * Create a browser wall.
 *
 * `theme` is required and **deliberately not defaulted** — `addCalendarSource`'s
 * rule for its clock, verbatim: a default is precisely how the household
 * fallback this retires would come back, one door at a time. Every caller has
 * to answer, and the compiler is what walks the doors (RFC 015 §4.1). The
 * value is a built-in key or a `custom:<id>`, validated by the caller; the
 * `CHECK` on `screens` refuses a null regardless of who forgot.
 */
export function createScreen(
  db: SqliteDatabase,
  id: string,
  name: string,
  pairing: PairingSecret,
  theme: string,
): void {
  const at = Date.now();
  db.prepare(
    `INSERT INTO screens
       (id, name, token_hash, pairing_code_hash, pairing_code_expires_at, theme,
        token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, pairing.tokenHash, pairing.pairingCodeHash, pairing.pairingCodeExpiresAt, theme, at, at, at);
}

/**
 * Create an e-paper screen: a screen with a panel and no browser (RFC 006).
 *
 * Separate from `createScreen` because it sets `kind` and the panel geometry,
 * and — unlike a browser wall — it is *not* seeded with a layout template, as an
 * e-paper frame is server-rendered and never uses the free-form canvas.
 */
export function createEpaperScreen(
  db: SqliteDatabase,
  id: string,
  name: string,
  pairing: PairingSecret,
  panel: { width: number; height: number; colour: string; rotation: number },
): void {
  const at = Date.now();
  db.prepare(
    `INSERT INTO screens
       (id, name, token_hash, pairing_code_hash, pairing_code_expires_at,
        kind, panel_width, panel_height, panel_colour, rotation,
        token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'epaper', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    pairing.tokenHash,
    pairing.pairingCodeHash,
    pairing.pairingCodeExpiresAt,
    panel.width,
    panel.height,
    panel.colour,
    panel.rotation,
    at,
    at,
    at,
  );
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

/**
 * Forget a revoked screen: the first hard delete of a screen this application
 * has ever made (RFC 016 phase 1).
 *
 * `revokeScreen`'s argument for keeping the row still stands — a token that
 * stops working is a record somebody reads while working out what is still on
 * their wall — and this does not overrule it: **only a revoked row may go**.
 * The Walls list offers Forget for revoked walls alone, but the list is a
 * convenience and the POST is the boundary, so the refusal is here, inside the
 * transaction, rather than in the handler that happens to call it today.
 *
 * Two things have to go with the row, because neither is held by a foreign
 * key — `layout_widgets.screen_id` and `screens.layout_follows` are plain
 * columns, and `db/schema.ts` says why at each declaration:
 *
 *  - **Its widgets, in both orientations.** A wall authors a portrait and a
 *    landscape canvas; deleting one of them leaves rows nothing can reach.
 *  - **A panel following it goes back to its built-in view.** `layout_mode`
 *    and `layout_follows` are cleared together on every panel in `follow`
 *    mode that names this wall — cleared rather than left, because a `follow`
 *    whose target is gone would read as `[]`, and since the gallery grew a
 *    Blank card an empty canvas is a *frame*, not a fallback: the panel would
 *    draw blank where the household expects the view it drew before it
 *    followed anything. A panel in some other mode with a stale
 *    `layout_follows` naming this wall only loses the stale name, never its
 *    mode: nulling `layout_mode` there would take a panel off its own canvas
 *    for a value `panelCanvasOwner` was already ignoring.
 *
 * One transaction, so a crash between the sweep and the delete cannot leave a
 * row whose canvas is gone. Answers `false` for an id that does not exist or
 * is still paired, and writes nothing on either.
 */
export function deleteScreen(db: SqliteDatabase, id: string): boolean {
  const remove = db.transaction((screenId: string): boolean => {
    const row = db.prepare('SELECT revoked_at AS revokedAt FROM screens WHERE id = ?').get(screenId) as
      | { revokedAt: number | null }
      | undefined;
    if (row === undefined || row.revokedAt === null) return false;
    const at = Date.now();
    db.prepare(
      `UPDATE screens SET layout_mode = NULL, layout_follows = NULL, updated_at = ?
        WHERE layout_mode = 'follow' AND layout_follows = ?`,
    ).run(at, screenId);
    db.prepare(`UPDATE screens SET layout_follows = NULL, updated_at = ? WHERE layout_follows = ?`).run(
      at,
      screenId,
    );
    // No orientation clause: both canvases go — and every slot, and the
    // schedule that picked between them.
    db.prepare('DELETE FROM layout_widgets WHERE screen_id = ?').run(screenId);
    db.prepare('DELETE FROM layout_schedule WHERE screen_id = ?').run(screenId);
    return db.prepare('DELETE FROM screens WHERE id = ?').run(screenId).changes > 0;
  });
  return remove(id);
}

/**
 * Forget every revoked screen at once, through `deleteScreen` for each so the
 * sweep is the same sweep. One outer transaction, so "Forget all" either
 * forgets all of them or none. Answers how many went.
 */
export function deleteRevokedScreens(db: SqliteDatabase): number {
  const removeAll = db.transaction((): number => {
    const ids = db.prepare('SELECT id FROM screens WHERE revoked_at IS NOT NULL').all() as { id: string }[];
    let gone = 0;
    for (const { id } of ids) if (deleteScreen(db, id)) gone += 1;
    return gone;
  });
  return removeAll();
}

export interface WeatherSettings {
  readonly enabled: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** `nws` (US only) or `openmeteo` (worldwide, key-less). */
  readonly provider: 'nws' | 'openmeteo';
  /** `imperial` (°F) or `metric` (°C). */
  readonly units: 'imperial' | 'metric';
}

export function readWeatherSettings(db: SqliteDatabase): WeatherSettings {
  const row = db
    .prepare(
      `SELECT weather_enabled AS enabled, latitude, longitude,
              weather_provider AS provider, weather_units AS units
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as
    | {
        enabled: number;
        latitude: number | null;
        longitude: number | null;
        provider: string | null;
        units: string | null;
      }
    | undefined;
  return {
    enabled: row?.enabled === 1,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
    provider: row?.provider === 'openmeteo' ? 'openmeteo' : 'nws',
    units: row?.units === 'metric' ? 'metric' : 'imperial',
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
  // Move, provider swap or a units change all make the cached forecast wrong —
  // it is for the old place, the old service, or the old scale. Drop it so the
  // wall never shows the previous answer while the new one is on its way.
  const invalidated =
    previous.latitude !== settings.latitude ||
    previous.longitude !== settings.longitude ||
    previous.provider !== settings.provider ||
    previous.units !== settings.units;
  /*
   * A move is more than a stale forecast: the alert zones are derived from the
   * coordinates and then never re-derived, because `resolveZones` only runs
   * when there are none. So a household who corrects a longitude they typed
   * wrong went on watching the county they typed by mistake for ever — and
   * since a watched zone is now what arms the ladder (RFC 009 Phase 2), every
   * screen would have reported that as working.
   *
   * Retired, not deleted, and the difference is the whole care here. "Use my
   * Home Assistant home location" on a box whose `zone.home` is still Home
   * Assistant's shipped default fills in Amsterdam — an ordinary misclick, and
   * a delete would take the household's real zones *and any warning in force*
   * with it before anything knows a replacement is obtainable. Disabling them
   * costs the same thing where it should (they are not polled and, per
   * `countWatchedZones`, they arm nothing) and costs nothing where it should
   * not: `/points` resolving the corrected location swaps them back, alerts
   * intact, and `replaceZones` deletes the ones that are genuinely wrong along
   * with their alerts — which it already did, atomically, on an answer it had.
   */
  const moved =
    previous.latitude !== settings.latitude || previous.longitude !== settings.longitude;

  /*
   * "Usable" is on *and* located: with no coordinates there is nothing to draw
   * and the wall omits the widget entirely (RFC 009 Phase 2). Two things key
   * off the transition into it — putting the strip on the wall, and asking the
   * provider now rather than on the next tick.
   */
  const wasUsable = previous.enabled && previous.latitude !== null && previous.longitude !== null;
  const isUsable = settings.enabled && settings.latitude !== null && settings.longitude !== null;

  const write = db.transaction(() => {
    db.prepare(
      `UPDATE household_settings
          SET weather_enabled = ?, latitude = ?, longitude = ?,
              weather_provider = ?, weather_units = ?, updated_at = ?
        WHERE id = 'singleton'`,
    ).run(
      settings.enabled ? 1 : 0,
      settings.latitude,
      settings.longitude,
      settings.provider,
      settings.units,
      Date.now(),
    );

    if (invalidated) db.prepare('DELETE FROM weather_cache').run();
    if (moved) {
      db.prepare(
        `UPDATE alert_zones SET enabled = 0, updated_at = ? WHERE provider = 'nws'`,
      ).run(Date.now());
      /*
       * And asked for again at once, not at the next scheduled poll.
       *
       * Retiring the zones un-arms every weather rule until one comes back, so
       * the gap between the two is a gap in the one feature with a life-safety
       * disclaimer on it — and under the job's backoff that gap can be half an
       * hour. A household correcting a coordinate, or pressing "Use my Home
       * Assistant home location", may well be doing it *because* of a warning
       * they can see. The alerts screen brings the poll forward for exactly
       * this reason when the switch is turned on; a move deserves it more.
       */
      db.prepare(`UPDATE job_state SET next_run_at = 0, consecutive_failures = 0
                   WHERE kind = 'alerts-sync'`).run();
    }

    /*
     * Switching a module on puts its block on the wall.
     *
     * The block order is stored, so a block that did not exist when a
     * household first saved their order can never appear in it — they would
     * turn weather on, wait an hour, and see nothing. Enabling is the moment
     * they asked for it, so that is the moment to add it. The order is still
     * theirs to change afterwards, and turning it off leaves the list alone.
     *
     * The moment is when weather becomes *usable*, which is not the same as
     * when the switch moves — and getting that wrong is a fault in each
     * direction. Written as `if (settings.enabled)` it fired on every save, so
     * a household who took the strip off their wall got it put back by any
     * later save with the switch on (and, once the alerts switch joined that
     * form in RFC 009 Phase 3.1, by toggling alerts). Written as the switch's
     * off→on transition it fires on almost no install at all: `weather_enabled`
     * ships as 1 while `display_blocks` ships without `weather`, so `previous`
     * is already enabled the first time anybody saves and the strip would never
     * appear — and this is the only writer of `'weather'` into that list.
     *
     * Usable is on *and* located: with no coordinates there is nothing to draw
     * and the wall omits the widget entirely (Phase 2). So the moment a
     * household types a location — on the wizard's fourth step, on the Weather
     * screen, or through "Use my Home Assistant home location" — is the moment
     * they asked for it, and every save after that leaves their order alone.
     */
    if (isUsable && !wasUsable) {
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
    /*
     * Bring the refresh forward so the panel fills in without a wait — when
     * there is something new to fetch.
     *
     * Unconditional, this reset the job's backoff on *any* save through here,
     * and since the alerts switch joined the forecast's form (RFC 009 Phase
     * 3.1) that includes toggling alerts, or pressing Enter on an untouched
     * page. A household fiddling with the Weather screen would then hammer the
     * provider while it was having a bad morning — the same hazard the
     * `alerts-sync` bring-forward above is careful about, on the job right
     * beside it.
     *
     * `invalidated` is the cache being wrong (a move, a provider swap, a units
     * change) and the usable transition is the household asking to see it at
     * all. Anything else already has the answer it needs.
     */
    if (invalidated || (isUsable && !wasUsable)) {
      db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'weather-sync'`).run();
    }
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
  readonly todayEvents: number;
  readonly nextDays: number;
  readonly horizonWeeks: number;
  readonly blocks: string;
  readonly clock24: number;
  readonly weekStart: string;
}

/**
 * Save what the household chose for every wall's content and clock.
 *
 * Values are already validated by the caller; this only writes. No theme and
 * no daylight schedule: those were the household default every wall inherited
 * and are retired (RFC 015 phase 2) — a wall names its own on its own page.
 */
export function writeDisplaySettings(db: SqliteDatabase, settings: DisplaySettings): void {
  db.prepare(
    `UPDATE household_settings
        SET display_today_events = ?, display_next_days = ?, display_horizon_weeks = ?,
            display_blocks = ?, clock_24 = ?, week_start = ?, updated_at = ?
      WHERE id = 'singleton'`,
  ).run(
    settings.todayEvents,
    settings.nextDays,
    settings.horizonWeeks,
    settings.blocks,
    settings.clock24,
    settings.weekStart,
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
  /** 1 when this calendar draws on the month grid and the week columns. */
  readonly showInGrid: number;
  readonly color: string;
  readonly personId: string | null;
  readonly kind: string;
  readonly haEntityId: string | null;
  /** The CalDAV account this collection is reached through, or null (§6.2.1). */
  readonly caldavAccountId: string | null;
  /** The account an `ics` feed signs in as, in clear. Null for most feeds. */
  readonly authUsername: string | null;
  /**
   * Whether a password is stored, as a 1 or a 0 — **never the envelope**.
   *
   * The settings row has to say that there is one to replace, and it has no
   * business holding the value to say it: `api/feed-credentials.ts` is the one
   * thing in the server that reads that column, and a projection feeding a
   * page is not it.
   */
  readonly hasAuthPassword: number;
  /**
   * When the household added it. Read so the row can tell a calendar that has
   * *not yet* had its first sync from one that has been failing to sync since
   * it was added — the two are identical in every other column, and the admin
   * reported both as "synced never".
   */
  readonly createdAt: number;
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
              show_in_grid AS showInGrid,
              color, person_id AS personId, kind, ha_entity_id AS haEntityId,
              caldav_account_id AS caldavAccountId,
              auth_username AS authUsername,
              CASE WHEN auth_password_encrypted IS NULL THEN 0 ELSE 1 END AS hasAuthPassword,
              created_at AS createdAt
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
    /*
     * The account this calendar was reached through, read **before** the row
     * goes, because afterwards there is nothing left to ask (RFC 013 §6.2.1).
     */
    const owner = db
      .prepare('SELECT caldav_account_id AS accountId FROM calendar_sources WHERE id = ?')
      .get(sourceId) as { accountId: string | null } | undefined;

    // Every kind. A source only ever has one of these, but deleting by kind
    // would mean reading the row first to find out which — and getting that
    // wrong leaves a job fetching a source that no longer exists, on every
    // tick, forever.
    db.prepare('DELETE FROM job_state WHERE key = ?').run(`ics-sync:${sourceId}`);
    db.prepare('DELETE FROM job_state WHERE key = ?').run(`ha-calendar-sync:${sourceId}`);
    db.prepare('DELETE FROM job_state WHERE key = ?').run(`caldav-sync:${sourceId}`);
    const gone = db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(sourceId).changes > 0;

    /*
     * **Removing an account's last calendar removes the account and its
     * credential** (§6.2.1, settled in the same commit as the schema rather
     * than left to be discovered): an orphaned credential is a stored secret
     * nothing uses, which is the spirit of rule six. A household wanting a
     * calendar back temporarily has `enabled` and `visible`; removal is
     * removal.
     *
     * It lives here rather than in a second CalDAV-aware remover for the reason
     * this function already deletes three job keys it mostly does not need:
     * **one writer**. Two functions that both remove a calendar are two places
     * to forget the account, and the one that forgets is the one a household
     * reaches from a screen nobody re-read.
     *
     * Deleted in code rather than by the constraint, which is not a choice:
     * drizzle-kit drops the FK action from an `ALTER TABLE ADD COLUMN`, so the
     * declared `ON DELETE CASCADE` reaches SQLite as `NO ACTION` — measured
     * against a real `better-sqlite3`, not read off the schema. `deletePerson`
     * has the identical problem with `person_id` and solves it identically.
     */
    if (gone && owner?.accountId != null) {
      const left = db
        .prepare('SELECT count(*) AS n FROM calendar_sources WHERE caldav_account_id = ?')
        .get(owner.accountId) as { n: number };
      if (left.n === 0) {
        db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(owner.accountId);
      }
    }
    return gone;
  });
  return remove(id);
}

/** Bring a source's next sync forward. The scheduler picks it up on its next tick. */
export function requestSyncNow(db: SqliteDatabase, id: string): void {
  db.prepare(
    `UPDATE job_state
        SET next_run_at = 0, consecutive_failures = 0, running_since = NULL
      WHERE key IN (?, ?, ?)`,
  ).run(`ics-sync:${id}`, `ha-calendar-sync:${id}`, `caldav-sync:${id}`);
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
  /** 'browser' or 'epaper' (RFC 006). */
  readonly kind: string;
  /** Panel geometry, device pixels, native landscape; null on a browser screen. */
  readonly panelWidth: number | null;
  readonly panelHeight: number | null;
  readonly panelColour: string | null;
  /**
   * How large this screen is and how far away it is read from, in millimetres.
   *
   * Not the pair above: those are device pixels in the panel's own scan
   * orientation, these are the physical picture as it is mounted. Null on all
   * three until a household says, which is the common case.
   */
  readonly panelWidthMm: number | null;
  readonly panelHeightMm: number | null;
  readonly readDistanceMm: number | null;
  readonly timezone: string | null;
  readonly daytimeTheme: string | null;
  readonly daytimeStartsAt: string | null;
  readonly daytimeEndsAt: string | null;
  readonly allowDismiss: number;
  readonly allowChores: number;
  /**
   * Whether this screen may tick an item off a Home Assistant to-do list
   * (RFC 012 phase 2).
   *
   * Selected here rather than left to the schema alone, which is the fault
   * `readScreens` already shipped once: the new e-paper columns were declared,
   * typed and never named in this query, so `panelWidth` was `undefined` at
   * runtime while the types swore otherwise. A missing column in a `SELECT` is
   * a silent `undefined`, and `undefined !== 1` reads exactly like a household
   * who left the switch off.
   */
  readonly allowTodo: number;
  /** Whether `/d/epaper/:file` refuses a connection from off the LAN (Option C). */
  readonly lanOnly: number;
  /** Per-screen display overrides; null follows the household. */
  readonly displayTodayEvents: number | null;
  readonly displayNextDays: number | null;
  readonly displayHorizonWeeks: number | null;
  readonly displayBlocks: string | null;
  readonly clock24: number | null;
  readonly layoutMode: string | null;
  /** Whose canvas to draw when `layoutMode` is `follow`; null is the Default. */
  readonly layoutFollows: string | null;
  readonly layoutAspect: number | null;
  readonly layoutLandscapeAspect: number | null;
  readonly layoutBackground: string | null;
  readonly layoutLandscapeBackground: string | null;
  /**
   * The canvas gutter step, 0-4; null is what the wall drew before the column
   * existed (RFC 014 §4.4). Named in the `SELECT` below for the reason
   * `allowTodo` above spells out at length — a column the types swear is there
   * and the query never asks for is a silent `undefined` at runtime.
   */
  readonly layoutGutter: number | null;
  /**
   * The wall's default style lane as stored JSON, or null (RFC 014 §4.1).
   * Named in the `SELECT` for the reason the gutter above is.
   */
  readonly layoutStyle: string | null;
}

export function readScreens(db: SqliteDatabase): ScreenRow[] {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, theme, revoked_at AS revokedAt,
              orientation, rotation, allow_dismiss AS allowDismiss, allow_chores AS allowChores,
              allow_todo AS allowTodo,
              lan_only AS lanOnly, timezone,
              kind, panel_width AS panelWidth, panel_height AS panelHeight,
              panel_colour AS panelColour,
              panel_width_mm AS panelWidthMm, panel_height_mm AS panelHeightMm,
              read_distance_mm AS readDistanceMm,
              daytime_theme AS daytimeTheme,
              daytime_starts_at AS daytimeStartsAt, daytime_ends_at AS daytimeEndsAt,
              display_today_events AS displayTodayEvents,
              display_next_days AS displayNextDays,
              display_horizon_weeks AS displayHorizonWeeks,
              display_blocks AS displayBlocks,
              clock_24 AS clock24,
              layout_mode AS layoutMode, layout_follows AS layoutFollows,
              layout_aspect AS layoutAspect,
              layout_landscape_aspect AS layoutLandscapeAspect,
              layout_background AS layoutBackground,
              layout_landscape_background AS layoutLandscapeBackground,
              layout_gutter AS layoutGutter, layout_style AS layoutStyle
         FROM screens WHERE revoked_at IS NULL`,
    )
    .all() as ScreenRow[];
}

/**
 * Set a wall's theme — used when applying a template that names one so its
 * backgrounds are readable (RFC 005 Phase 3c). A screen id only: the household
 * row has no theme to set any more (RFC 015 phase 2), so the branch that wrote
 * one is gone rather than left writing to a column that does not exist. A
 * built-in key or `custom:<id>`, validated by the caller.
 */
export function setOwnerTheme(db: SqliteDatabase, owner: string, theme: string): void {
  db.prepare('UPDATE screens SET theme = ?, updated_at = ? WHERE id = ?').run(theme, Date.now(), owner);
}

/**
 * Stamp a screen as seen, on the caller's clock.
 *
 * `at` is required and deliberately not defaulted — the rule
 * `addCalendarSource` and `equipHousehold` already state, and for the same
 * fault. The stamp was a bare `Date.now()` while every page that reads it
 * compares against the app's injected `now`: one clock in production, and hours
 * apart under `browser-harness`, which pins that `now` to `HARNESS_HOUR`. A wall
 * polled a second ago read "not seen for 9 hours" there. A default is exactly
 * how the second clock comes back, so every caller answers.
 */
export function touchScreen(
  db: SqliteDatabase,
  id: string,
  ip: string | null,
  agent: string | null,
  at: number,
): void {
  db.prepare(
    `UPDATE screens SET last_seen_at = ?, last_seen_ip = ?, last_seen_user_agent = ?
      WHERE id = ?`,
  ).run(at, ip, agent, id);
}

/**
 * Record the viewport a wall reported on its poll (RFC 005).
 *
 * A convenience for the layout editor's "match this screen's size" — never
 * depended on to draw. Bounds are enforced by the caller (the manifest route),
 * so a rubbish query string cannot write a rubbish size; only sane pixel
 * dimensions reach here.
 */
export function recordScreenViewport(db: SqliteDatabase, id: string, w: number, h: number): void {
  db.prepare('UPDATE screens SET report_w = ?, report_h = ? WHERE id = ?').run(w, h, id);
}
