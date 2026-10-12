import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from '../db/open.js';
import { canvasGutterStep } from '../gutter.js';
import { z } from '../validation.js';
import { WIDGET_GROUNDS } from '../wallpapers.js';
import { CUSTOM_CSS_MAX_BYTES, sanitiseCustomCss, type CssScope } from './custom-css.js';
import { isHhmm, MAX_LAYOUT_SLOTS, MAX_SCHEDULE_ROWS, SLOT_NAME } from './layout-slots.js';
import { DAYLIGHT_ENTITY_PATTERN } from './daylight.js';
import { readDaylightChoice, writeDaylightChoice, type DaylightChoice } from './queries.js';
import { isValidThemeRef } from './themes.js';
import { backgroundSchema, layoutWidgetBody, widgetTreeIssues } from './widget-schema.js';
import { widgetStyleBody } from './widget-style.js';

/**
 * Everything a browser wall *looks like*, as one document (plan items
 * M8.4–M8.6).
 *
 * Three features read and write a wall whole — a snapshot taken before every
 * save, a file a household exports and imports, and a duplicate — and they
 * are one shape on purpose: a snapshot that could restore something an
 * import could not carry, or a duplicate that copied a column the snapshot
 * forgot, is three answers to "what is this wall". So this file is the one
 * list of what a wall's look is, and each feature is a few lines around it.
 *
 * **What is in it**: every canvas (both orientations, the default layout and
 * every named one), each orientation's aspect and background, the schedule,
 * the theme and its daylight window, the gutter, the wall's default style
 * lane, the widget ground, the Motion switch, the wall's and every widget's
 * own CSS *as typed*, the clock and the three calendar amounts.
 *
 * **What is not, and why**: the name, the pairing token and every `allow_*`
 * switch — what a person standing at the wall may press is a decision about
 * that wall's room, never something a file or a copy should hand it — and
 * every fact about the hardware: orientation, rotation, the panel's size and
 * read distance, the timezone, the last report. A duplicate is hung somewhere
 * else, and an import may come from another house.
 *
 * **CSS is carried as the household typed it, never as scoped.** The scoped
 * text names the widget's id, and every widget a duplicate or an import
 * writes gets a fresh one; so the source is put back through the sanitiser
 * on the way in, against the id the widget ends up with, and nothing a file
 * says is trusted as scoped CSS.
 */

export const WALL_STATE_VERSION = 1;

/** How many snapshots a wall keeps. Older ones are deleted as new ones are taken. */
export const SNAPSHOTS_KEPT = 20;

/**
 * A save within this long of the last snapshot takes no new one.
 *
 * The editor's Save is several requests — a canvas per orientation and named
 * layout, then the hours — and a snapshot before each would keep the wall
 * half saved four times and push the version a household wants back out of
 * the twenty. The first request of a burst is the one worth keeping: it is
 * what the wall was before the household pressed Save.
 */
export const SNAPSHOT_COALESCE_MS = 10_000;

const orientation = z.enum(['portrait', 'landscape']);

/**
 * A widget as a wall state carries it: the editor's own shape, refused
 * rather than stripped of a key it does not know, plus its CSS as typed.
 */
const stateWidget = layoutWidgetBody
  .extend({ customCss: z.string().max(CUSTOM_CSS_MAX_BYTES * 2).optional() })
  .strict();

const stateCanvas = z
  .object({
    orientation,
    slot: z.string().regex(SLOT_NAME, 'A layout name is a short word: letters, digits and dashes.').nullable(),
    widgets: z.array(stateWidget).max(50),
  })
  .strict()
  .superRefine((canvas, ctx) => {
    for (const message of widgetTreeIssues(canvas.widgets, (w) => w.id, (w) => w.parentId)) {
      ctx.addIssue({ code: 'custom', message });
    }
  });

const stateSide = z
  .object({
    aspect: z.number().min(0.2).max(5).nullable(),
    background: backgroundSchema.nullable(),
  })
  .strict();

const hhmm = z.string().refine(isHhmm, 'A time is HH:MM.');

export const wallStateSchema = z
  .object({
    canvases: z.array(stateCanvas).max(2 * (MAX_LAYOUT_SLOTS + 1)),
    portrait: stateSide,
    landscape: stateSide,
    schedule: z
      .array(z.object({ slot: z.string().regex(SLOT_NAME), from: hhmm, to: hhmm }).strict())
      .max(MAX_SCHEDULE_ROWS),
    theme: z.string().min(1).max(80),
    daytimeTheme: z.string().min(1).max(80).nullable(),
    daytimeStartsAt: hhmm.nullable(),
    daytimeEndsAt: hhmm.nullable(),
    /*
     * What switches the daytime theme (plan item M8.7): 'clock' for the hours,
     * 'sun', or 'entity:<id>'. Optional, so a file or a snapshot from before
     * it existed still opens, and leaves the wall's choice as it is.
     */
    daylightBy: z
      .string()
      .max(220)
      .refine(
        (v) => v === 'clock' || v === 'sun' || (v.startsWith('entity:') && DAYLIGHT_ENTITY_PATTERN.test(v.slice(7))),
        'That is not something the daytime theme can switch by.',
      )
      .optional(),
    gutter: z.number().int().refine((n) => canvasGutterStep(n) !== undefined, 'That spacing is not one of the steps.').nullable(),
    style: widgetStyleBody.nullable(),
    widgetGround: z.enum(WIDGET_GROUNDS).nullable(),
    motion: z.boolean().nullable(),
    customCss: z.string().max(CUSTOM_CSS_MAX_BYTES * 2).nullable(),
    clock24: z.boolean().nullable(),
    todayEvents: z.number().int().min(1).max(20).nullable(),
    nextDays: z.number().int().min(0).max(14).nullable(),
    horizonWeeks: z.number().int().min(1).max(8).nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    const seen = new Set<string>();
    const named = new Set<string>();
    const ids = new Set<string>();
    for (const canvas of state.canvases) {
      const key = `${canvas.orientation}/${canvas.slot ?? ''}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'The same layout appears twice.' });
      seen.add(key);
      if (canvas.slot !== null) named.add(canvas.slot);
      for (const widget of canvas.widgets) {
        if (ids.has(widget.id)) ctx.addIssue({ code: 'custom', message: `Two widgets share the id "${widget.id}".` });
        ids.add(widget.id);
      }
    }
    if (named.size > MAX_LAYOUT_SLOTS) {
      ctx.addIssue({ code: 'custom', message: `A wall holds at most ${MAX_LAYOUT_SLOTS} timed layouts.` });
    }
    for (const rule of state.schedule) {
      if (!named.has(rule.slot)) ctx.addIssue({ code: 'custom', message: `A time names a layout called "${rule.slot}" that is not in the file.` });
      if (rule.from === rule.to) ctx.addIssue({ code: 'custom', message: 'A time window has to start and end at different times.' });
    }
    const window = [state.daytimeTheme, state.daytimeStartsAt, state.daytimeEndsAt].filter((v) => v !== null).length;
    if (window !== 0 && window !== 3) {
      ctx.addIssue({ code: 'custom', message: 'A daylight theme needs both of its times.' });
    }
  });

export type WallState = z.infer<typeof wallStateSchema>;

/** The file a household downloads: the state, and enough to recognise it by. */
export const wallFileSchema = z
  .object({
    format: z.literal('maverick-wall-layout'),
    version: z.literal(WALL_STATE_VERSION),
    name: z.string().max(80).optional(),
    exportedAt: z.string().max(40).optional(),
    state: wallStateSchema,
  })
  .strict();

function json(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A stored value read back through its own schema, or null: a row nobody can read is no value. */
function readAs<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

interface ScreenStateRow {
  theme: string | null;
  daytimeTheme: string | null;
  daytimeStartsAt: string | null;
  daytimeEndsAt: string | null;
  clock24: number | null;
  todayEvents: number | null;
  nextDays: number | null;
  horizonWeeks: number | null;
  portraitAspect: number | null;
  landscapeAspect: number | null;
  portraitBackground: string | null;
  landscapeBackground: string | null;
  gutter: number | null;
  style: string | null;
  widgetGround: string | null;
  motion: number | null;
  customCss: string | null;
  kind: string | null;
}

/**
 * A browser wall's look, read whole; undefined for a screen that does not
 * exist or is an e-paper panel, which draws a frame rather than a canvas.
 *
 * Every column is read back through the schema the file is checked with, so
 * a state read here always passes `wallStateSchema` — what a snapshot keeps
 * is something a restore will take, and a value no schema accepts (a
 * wallpaper a later catalogue dropped) is read as none rather than carried.
 */
export function readWallState(db: SqliteDatabase, screenId: string): WallState | undefined {
  const row = db
    .prepare(
      `SELECT theme, daytime_theme AS daytimeTheme, daytime_starts_at AS daytimeStartsAt,
              daytime_ends_at AS daytimeEndsAt, clock_24 AS clock24,
              display_today_events AS todayEvents, display_next_days AS nextDays,
              display_horizon_weeks AS horizonWeeks,
              layout_aspect AS portraitAspect, layout_landscape_aspect AS landscapeAspect,
              layout_background AS portraitBackground, layout_landscape_background AS landscapeBackground,
              layout_gutter AS gutter, layout_style AS style, widget_ground AS widgetGround,
              motion, custom_css AS customCss, kind
         FROM screens WHERE id = ?`,
    )
    .get(screenId) as ScreenStateRow | undefined;
  if (row === undefined || row.kind === 'epaper') return undefined;

  const widgets = db
    .prepare(
      `SELECT id, orientation, slot, type, x, y, w, h, z, config, parent_id AS parentId, custom_css AS customCss
         FROM layout_widgets WHERE screen_id = ?
        ORDER BY orientation DESC, (slot IS NOT NULL), slot, (parent_id IS NOT NULL), z, created_at`,
    )
    .all(screenId) as {
    id: string;
    orientation: string;
    slot: string | null;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    config: string | null;
    parentId: string | null;
    customCss: string | null;
  }[];

  const canvases = new Map<string, WallState['canvases'][number]>();
  for (const widget of widgets) {
    const side = widget.orientation === 'landscape' ? 'landscape' : 'portrait';
    const key = `${side}/${widget.slot ?? ''}`;
    let canvas = canvases.get(key);
    if (canvas === undefined) {
      canvas = { orientation: side, slot: widget.slot, widgets: [] };
      canvases.set(key, canvas);
    }
    const config = json(widget.config);
    canvas.widgets.push({
      id: widget.id,
      type: widget.type as never,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      z: widget.z,
      ...(config !== null ? { config: config as never } : {}),
      ...(widget.parentId !== null ? { parentId: widget.parentId } : {}),
      ...(widget.customCss !== null && widget.customCss !== '' ? { customCss: widget.customCss } : {}),
    });
  }

  const schedule = db
    .prepare('SELECT slot, from_hhmm AS "from", to_hhmm AS "to" FROM layout_schedule WHERE screen_id = ? ORDER BY position')
    .all(screenId) as { slot: string; from: string; to: string }[];

  const window = row.daytimeTheme !== null && row.daytimeStartsAt !== null && row.daytimeEndsAt !== null;
  return {
    canvases: [...canvases.values()],
    portrait: {
      aspect: readAs(z.number().min(0.2).max(5), row.portraitAspect),
      background: readAs(backgroundSchema, json(row.portraitBackground)),
    },
    landscape: {
      aspect: readAs(z.number().min(0.2).max(5), row.landscapeAspect),
      background: readAs(backgroundSchema, json(row.landscapeBackground)),
    },
    schedule,
    theme: row.theme ?? 'panels',
    daytimeTheme: window ? row.daytimeTheme : null,
    daytimeStartsAt: window ? row.daytimeStartsAt : null,
    daytimeEndsAt: window ? row.daytimeEndsAt : null,
    daylightBy: daylightByOf(readDaylightChoice(db, screenId)),
    gutter: canvasGutterStep(row.gutter) ?? null,
    style: readAs(widgetStyleBody, json(row.style)),
    widgetGround: readAs(z.enum(WIDGET_GROUNDS), row.widgetGround),
    motion: row.motion === null ? null : row.motion === 1,
    customCss: row.customCss === '' ? null : row.customCss,
    clock24: row.clock24 === null ? null : row.clock24 === 1,
    todayEvents: row.todayEvents,
    nextDays: row.nextDays,
    horizonWeeks: row.horizonWeeks,
  };
}

/** One canonical string per state, so two snapshots of the same wall compare equal. */
export function serialiseWallState(state: WallState): string {
  return JSON.stringify(state);
}

/** Where a block of CSS in a state could not be put back, named for a sentence. */
export interface CssProblem {
  /** `wall`, or the widget's type. */
  readonly where: string;
  readonly reason: string;
}

/**
 * Put every block of CSS in a state back through the sanitiser, against the
 * ids the widgets will have once written, without writing anything.
 *
 * Import calls this first and refuses the whole file on any problem (rule
 * five); a restore and a duplicate write what passes and drop what does not,
 * because the source was this wall's own and a sanitiser that has grown
 * stricter since must not stop a household getting their layout back.
 */
export function checkStateCss(state: WallState, ids: ReadonlyMap<string, string> = new Map()): CssProblem[] {
  const problems: CssProblem[] = [];
  const check = (source: string | null | undefined, scope: CssScope, where: string): void => {
    if (source === null || source === undefined || source.trim() === '') return;
    const outcome = sanitiseCustomCss(source, scope);
    if (!outcome.ok) problems.push({ where, reason: `Line ${outcome.line}: ${outcome.reason}` });
  };
  check(state.customCss, { kind: 'wall' }, 'wall');
  for (const canvas of state.canvases) {
    for (const widget of canvas.widgets) {
      check(widget.customCss, { kind: 'widget', id: ids.get(widget.id) ?? widget.id }, widget.type);
    }
  }
  return problems;
}

/** What applying a state could not carry over, for the sentence after it. */
export interface ApplyOutcome {
  /** The theme the state named is not on this install, so the wall kept its own. */
  readonly themeKept: boolean;
  /** The daylight theme the state named is not on this install, so it was left off. */
  readonly daytimeDropped: boolean;
  /** Blocks of CSS the sanitiser refused, and so did not write. */
  readonly cssDropped: number;
}

const BUILTIN_THEMES = ['household', 'blueprint', 'panels', 'almanac', 'swiss'] as const;

/**
 * Make a browser wall's look exactly a state, in one transaction.
 *
 * Replace, never merge: every canvas and every schedule row the wall had is
 * deleted and the state's written, so "restore" means the wall as it was and
 * not that wall with today's extra named layout still on it. `freshIds` mints
 * a new id for every widget and re-links each child to its group's new id —
 * an import or a duplicate must, because a widget id is unique across the
 * whole house, and a restore need not, because the ids are this wall's own.
 *
 * A theme this install does not hold keeps the wall's own, and a daylight
 * theme it does not hold is left off, each said in the outcome: a file from
 * another house names its own custom themes, and a wall with no theme is the
 * one state the `screens` CHECK refuses.
 */
export function applyWallState(
  db: SqliteDatabase,
  screenId: string,
  state: WallState,
  options: { readonly freshIds: boolean },
): ApplyOutcome {
  const ids = new Map<string, string>();
  for (const canvas of state.canvases) {
    for (const widget of canvas.widgets) ids.set(widget.id, options.freshIds ? randomUUID() : widget.id);
  }
  const scoped = (source: string | null | undefined, scope: CssScope): { source: string | null; scoped: string | null } | 'refused' => {
    if (source === null || source === undefined || source.trim() === '') return { source: null, scoped: null };
    const outcome = sanitiseCustomCss(source, scope);
    if (!outcome.ok) return 'refused';
    return { source, scoped: outcome.css === '' ? null : outcome.css };
  };

  let cssDropped = 0;
  const themeOk = isValidThemeRef(db, state.theme, BUILTIN_THEMES);
  const daytimeOk = state.daytimeTheme === null || isValidThemeRef(db, state.daytimeTheme, BUILTIN_THEMES);
  const at = Date.now();

  const tx = db.transaction(() => {
    if (state.daylightBy !== undefined) writeDaylightChoice(db, screenId, daylightChoiceOf(state.daylightBy));
    const wallCss = scoped(state.customCss, { kind: 'wall' });
    if (wallCss === 'refused') cssDropped++;
    const window = daytimeOk && state.daytimeTheme !== null;
    db.prepare(
      `UPDATE screens SET
         theme = COALESCE(?, theme),
         daytime_theme = ?, daytime_starts_at = ?, daytime_ends_at = ?,
         clock_24 = ?, display_today_events = ?, display_next_days = ?, display_horizon_weeks = ?,
         layout_mode = 'freeform', layout_follows = NULL,
         layout_aspect = ?, layout_landscape_aspect = ?,
         layout_background = ?, layout_landscape_background = ?,
         layout_gutter = ?, layout_style = ?, widget_ground = ?, motion = ?,
         custom_css = ?, custom_css_scoped = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      themeOk ? state.theme : null,
      window ? state.daytimeTheme : null,
      window ? state.daytimeStartsAt : null,
      window ? state.daytimeEndsAt : null,
      state.clock24 === null ? null : state.clock24 ? 1 : 0,
      state.todayEvents,
      state.nextDays,
      state.horizonWeeks,
      state.portrait.aspect,
      state.landscape.aspect,
      state.portrait.background === null ? null : JSON.stringify(state.portrait.background),
      state.landscape.background === null ? null : JSON.stringify(state.landscape.background),
      state.gutter,
      state.style === null ? null : JSON.stringify(state.style),
      state.widgetGround,
      state.motion === null ? null : state.motion ? 1 : 0,
      wallCss === 'refused' ? null : wallCss.source,
      wallCss === 'refused' ? null : wallCss.scoped,
      at,
      screenId,
    );

    db.prepare('DELETE FROM layout_widgets WHERE screen_id = ?').run(screenId);
    const insert = db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, slot, type, x, y, w, h, z, config, parent_id,
                                   custom_css, custom_css_scoped, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const canvas of state.canvases) {
      for (const widget of canvas.widgets) {
        const id = ids.get(widget.id) as string;
        const css = scoped(widget.customCss, { kind: 'widget', id });
        if (css === 'refused') cssDropped++;
        insert.run(
          id,
          screenId,
          canvas.orientation,
          canvas.slot,
          widget.type,
          widget.x,
          widget.y,
          widget.w,
          widget.h,
          widget.z,
          widget.config === undefined ? null : JSON.stringify(widget.config),
          widget.parentId === undefined ? null : (ids.get(widget.parentId) ?? null),
          css === 'refused' ? null : css.source,
          css === 'refused' ? null : css.scoped,
          at,
          at,
        );
      }
    }

    db.prepare('DELETE FROM layout_schedule WHERE screen_id = ?').run(screenId);
    const rule = db.prepare(
      `INSERT INTO layout_schedule (id, screen_id, position, slot, from_hhmm, to_hhmm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    state.schedule.forEach((row, position) => {
      rule.run(randomUUID(), screenId, position, row.slot, row.from, row.to, at, at);
    });
  });
  tx();
  return { themeKept: !themeOk, daytimeDropped: !daytimeOk, cssDropped };
}

/**
 * A state with what must never leave the house taken out of it.
 *
 * A guest network's password is the one credential a widget's config holds
 * (the QR code's `wifiPassword`); it is drawn on the glass on purpose, and a
 * file is a different matter — it is attached to messages, posted when
 * somebody asks for help, and kept. Taken out, the code is a network with no
 * password, which the schema accepts and the editor shows as an empty field.
 */
export function exportableState(state: WallState): { state: WallState; removed: number } {
  let removed = 0;
  const canvases = state.canvases.map((canvas) => ({
    ...canvas,
    widgets: canvas.widgets.map((widget) => {
      const config = widget.config as Record<string, unknown> | undefined;
      if (config === undefined || !('wifiPassword' in config)) return widget;
      removed++;
      const { wifiPassword: _dropped, ...rest } = config;
      return { ...widget, config: rest as never };
    }),
  }));
  return { state: { ...state, canvases }, removed };
}

export interface SnapshotRow {
  readonly id: string;
  readonly reason: string;
  readonly createdAt: number;
}

/**
 * Keep the wall as it is now, before something changes it.
 *
 * Skipped when the wall is exactly what the last snapshot holds — a save that
 * changed nothing is not a version — and, unless `force`, when the last one
 * is under `SNAPSHOT_COALESCE_MS` old (one Save is several requests). Pruned
 * to the newest `SNAPSHOTS_KEPT` in the same transaction. Returns whether a
 * snapshot was taken.
 */
export function snapshotWall(
  db: SqliteDatabase,
  screenId: string,
  reason: string,
  now: number,
  options: { readonly force?: boolean } = {},
): boolean {
  const state = readWallState(db, screenId);
  if (state === undefined) return false;
  const text = serialiseWallState(state);
  const last = db
    .prepare('SELECT state, created_at AS createdAt FROM layout_snapshots WHERE screen_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(screenId) as { state: string; createdAt: number } | undefined;
  if (last !== undefined) {
    if (last.state === text) return false;
    if (options.force !== true && now - last.createdAt >= 0 && now - last.createdAt < SNAPSHOT_COALESCE_MS) return false;
  }
  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO layout_snapshots (id, screen_id, reason, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), screenId, reason, text, now, now);
    db.prepare(
      `DELETE FROM layout_snapshots WHERE screen_id = ? AND id NOT IN (
         SELECT id FROM layout_snapshots WHERE screen_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(screenId, screenId, SNAPSHOTS_KEPT);
  });
  tx();
  return true;
}

/** A wall's snapshots, newest first. */
export function readSnapshots(db: SqliteDatabase, screenId: string): SnapshotRow[] {
  return db
    .prepare(
      `SELECT id, reason, created_at AS createdAt FROM layout_snapshots
        WHERE screen_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(screenId) as SnapshotRow[];
}

/**
 * One snapshot's state, read back through the schema; undefined for an id
 * that is not this wall's, or a row a later release cannot read.
 */
export function readSnapshotState(db: SqliteDatabase, screenId: string, snapshotId: string): WallState | undefined {
  const row = db
    .prepare('SELECT state FROM layout_snapshots WHERE id = ? AND screen_id = ?')
    .get(snapshotId, screenId) as { state: string } | undefined;
  if (row === undefined) return undefined;
  const parsed = wallStateSchema.safeParse(json(row.state));
  return parsed.success ? parsed.data : undefined;
}

function daylightByOf(choice: DaylightChoice): string {
  return choice.source === 'entity' ? `entity:${choice.entity ?? ''}` : (choice.source ?? 'clock');
}

function daylightChoiceOf(value: string): DaylightChoice {
  if (value === 'sun') return { source: 'sun', entity: null };
  if (value.startsWith('entity:')) return { source: 'entity', entity: value.slice(7) };
  return { source: null, entity: null };
}
