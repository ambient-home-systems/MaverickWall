import { randomBytes } from 'node:crypto';
import { z } from '../validation.js';
import { templateWidgetSchema, backgroundSchema } from './widget-schema.js';
import {
  readLayoutWidgets,
  replaceLayout,
  readHousehold,
  readScreens,
  setOwnerTheme,
  type LayoutWidgetInput,
} from './queries.js';
import type { SqliteDatabase } from '../db/open.js';
import { TEMPLATES } from '../templates/index.js';
import { CLASSIC_VARIANTS, classicFor } from '../templates/classic.js';
import type { HouseholdSetUp } from './manifest.js';

/**
 * A starting layout a household picks from (RFC 005).
 *
 * A template is a saved arrangement of the same widgets the editor places, for
 * both orientations — nothing a household could not build by hand. That is the
 * whole safety story: a template is validated through the *same*
 * `templateWidgetSchema`/`widgetConfigBody` a `/admin/layout` save is, so it can
 * place no type the wall cannot draw and set no option the editor cannot.
 *
 * They are baked-in source, one file per template under `src/templates/`, the
 * same posture as the Store: a directory of source, not a document fetched over
 * the network, so it works on a wall with no internet and is maintained as part
 * of the project. `test/templates.test.ts` validates the whole list, so a
 * malformed template fails the build, never a household's wall.
 */

/** One orientation's canvas: the aspect it was drawn at and its widgets. */
export const templateCanvasSchema = z.object({
  // Portrait phone through wide television, and nothing degenerate.
  aspect: z.number().min(0.2).max(5),
  // A wall is a few widgets, not a dashboard. The cap is a guard, not a target.
  widgets: z.array(templateWidgetSchema).max(50),
  // An optional canvas background (RFC 005 Phase 3); templates gain them in 3c.
  background: backgroundSchema.optional(),
});

export const templateSchema = z
  .object({
    /** Stable, kebab-case. Referenced by the apply deep-link. */
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens only'),
    name: z.string().min(1).max(60),
    category: z.enum(['home', 'office']),
    /** A one-line description of what the template shows. */
    blurb: z.string().min(1).max(200),
    /**
     * The built-in theme this template was designed for (RFC 005 Phase 3c).
     * Applying the template sets it, so the theme and the canvas backgrounds land
     * together — a white background under a dark theme would be unreadable. Only
     * the four built-ins; a household's custom theme is theirs to choose.
     */
    theme: z.enum(['household', 'blueprint', 'panels', 'almanac', 'swiss']).optional(),
    // Both orientations are always authored (RFC 005's "require both"), so a
    // template-started display is never in the letterbox-one-side case.
    portrait: templateCanvasSchema,
    landscape: templateCanvasSchema,
  })
  .strict();

export type DisplayTemplate = z.infer<typeof templateSchema>;
export type TemplateCanvas = z.infer<typeof templateCanvasSchema>;

const ORIENTATIONS = ['portrait', 'landscape'] as const;

/** A widget id that will not collide across a household's handful. Not a secret. */
function widgetId(): string {
  return 'w' + randomBytes(6).toString('hex');
}

/**
 * Apply a template to a display, writing both canvases.
 *
 * Ids are minted here, not carried by the template — a template is arrangement,
 * not identity, so two displays started from one template do not share widget
 * ids. Each orientation is one `replaceLayout` transaction, so a wall polling
 * mid-apply reads the old canvas or the new one, never half; `mode` becomes
 * `freeform` because the household just asked for this layout.
 */
export function applyTemplate(
  db: SqliteDatabase,
  owner: string | null,
  template: DisplayTemplate,
): void {
  // Set the designed theme first, so it and the canvas backgrounds are
  // consistent — a template's light background must not land under a dark theme.
  if (template.theme !== undefined) setOwnerTheme(db, owner, template.theme);
  for (const orientation of ORIENTATIONS) {
    const canvas = template[orientation];
    replaceLayout(db, owner, orientation, {
      mode: 'freeform',
      aspect: canvas.aspect,
      widgets: canvas.widgets.map((widget, index) => ({
        id: widgetId(),
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: widget.z ?? index,
        ...(widget.config !== undefined ? { config: widget.config } : {}),
      })),
      // A template may carry a background (RFC 005 Phase 3); JSON-stringified for
      // storage, or null when it has none.
      background: canvas.background !== undefined ? JSON.stringify(canvas.background) : null,
    });
  }
}

/**
 * One-shot migration of every "auto" wall onto the Classic template.
 *
 * The responsive stacked layout was retired; every wall draws a free-form canvas
 * now. A wall that never arranged one (the old default, and every screen that
 * inherited it) has no `layout_widgets`, so on the first boot after the upgrade
 * this seeds it with Classic — the same kitchen calendar it drew before, now as
 * widgets it can rearrange. A wall that already arranged its own canvas has
 * widgets and is left completely untouched. Guarded by
 * `household_settings.layout_backfilled` so it runs exactly once and never
 * re-seeds a wall the household later cleared.
 *
 * Runs at boot, after migrations and the default seed, inside the same file lock
 * (see `main.ts`). It reuses `applyTemplate` — the same transactional writer the
 * gallery uses — rather than hand-written SQL, so the riskiest kind of change in
 * this codebase (rewriting every household's layout) goes through code that is
 * already tested and clamps every value.
 */
export function backfillClassic(db: SqliteDatabase, setUp: HouseholdSetUp): void {
  const row = db
    .prepare(`SELECT layout_backfilled AS done FROM household_settings WHERE id = 'singleton'`)
    .get() as { done: number } | undefined;
  // No settings row yet (setup has not run) or already backfilled: nothing to do.
  if (row === undefined || row.done === 1) return;

  // Classic for *this* household, not the fully-equipped one (`classicFor`).
  // A wall seeded with boxes the manifest will drop is a wall with holes in it.
  const seed = classicFor(setUp);
  const seedIfEmpty = (owner: string | null): void => {
    const hasWidgets =
      readLayoutWidgets(db, owner, 'portrait').length > 0 ||
      readLayoutWidgets(db, owner, 'landscape').length > 0;
    if (!hasWidgets) applyTemplate(db, owner, seed);
  };

  seedIfEmpty(null);
  for (const screen of readScreens(db)) {
    if (screen.revokedAt === null) seedIfEmpty(screen.id);
  }

  db.prepare(`UPDATE household_settings SET layout_backfilled = 1, updated_at = ? WHERE id = 'singleton'`).run(
    Date.now(),
  );
}

/**
 * Six decimal places, as a string. Far finer than any control that writes these
 * — the editor snaps to a twenty-fourth (0.041667) and its number fields take
 * whole percent — and coarse enough that no float noise can make a canvas look
 * like one somebody moved.
 */
const six = (value: number): string => (Number.isFinite(value) ? value.toFixed(6) : 'x');

/** JSON with object keys in a fixed order, so two equal configs print equal. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * One canvas as a single comparable string: its aspect, its background and
 * every box.
 *
 * Sorted, so it says nothing about the order rows came back in — two canvases
 * print the same exactly when they would draw the same. `z` is inside a box's
 * own print, so stacking is still compared; only the *read* order is discarded.
 */
function canvasPrint(
  aspect: number,
  background: string | null,
  widgets: readonly {
    readonly type: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly z?: number | undefined;
    readonly config?: unknown;
  }[],
): string {
  const boxes = widgets
    .map((widget, index) =>
      [
        widget.type,
        six(widget.x),
        six(widget.y),
        six(widget.w),
        six(widget.h),
        String(Math.trunc(widget.z ?? index)),
        canonical(widget.config),
      ].join('|'),
    )
    .sort();
  return [six(aspect), background ?? '', ...boxes].join('\n');
}

/** Both canvases of a template, printed the way a stored layout prints. */
function templatePrint(template: DisplayTemplate): string {
  return ORIENTATIONS.map((orientation) => {
    const canvas = template[orientation];
    const background = canvas.background !== undefined ? JSON.stringify(canvas.background) : null;
    return canvasPrint(canvas.aspect, background, canvas.widgets);
  }).join('\n==\n');
}

/**
 * What this owner has stored, printed the same way — or `undefined` when it is
 * not a canvas of its own at all.
 *
 * Its **own** columns, never the household's. `ownerLayout` resolves a screen's
 * nulls against the household because that is what a *drawing* screen follows;
 * here the question is whether anybody has touched this particular canvas, and
 * an inherited value would answer for somebody else's.
 */
function ownerPrint(db: SqliteDatabase, owner: string | null): string | undefined {
  const row =
    owner === null
      ? (db
          .prepare(
            `SELECT layout_mode AS mode, layout_aspect AS portraitAspect,
                    layout_landscape_aspect AS landscapeAspect,
                    layout_background AS portraitBackground,
                    layout_landscape_background AS landscapeBackground
               FROM household_settings WHERE id = 'singleton'`,
          )
          .get() as OwnLayoutRow | undefined)
      : (db
          .prepare(
            `SELECT layout_mode AS mode, layout_aspect AS portraitAspect,
                    layout_landscape_aspect AS landscapeAspect,
                    layout_background AS portraitBackground,
                    layout_landscape_background AS landscapeBackground
               FROM screens WHERE id = ? AND revoked_at IS NULL`,
          )
          .get(owner) as OwnLayoutRow | undefined);
  // A screen with no canvas of its own draws the household's, and a panel set
  // to `follow` draws a wall's. Neither is this owner's to re-seed.
  if (row === undefined || row.mode !== 'freeform') return undefined;
  if (row.portraitAspect === null || row.landscapeAspect === null) return undefined;
  return [
    canvasPrint(row.portraitAspect, row.portraitBackground, readLayoutWidgets(db, owner, 'portrait')),
    canvasPrint(row.landscapeAspect, row.landscapeBackground, readLayoutWidgets(db, owner, 'landscape')),
  ].join('\n==\n');
}

interface OwnLayoutRow {
  readonly mode: string | null;
  readonly portraitAspect: number | null;
  readonly landscapeAspect: number | null;
  readonly portraitBackground: string | null;
  readonly landscapeBackground: string | null;
}

/**
 * Every arrangement this build seeds, as prints. A canvas equal to one of these
 * is a canvas nobody has arranged.
 *
 * It reaches back one release as well as forward, and that is not luck: the
 * Classic that every earlier build seeded *is* the `ws` variant, unchanged, so
 * a wall backfilled by an earlier release and never touched since prints as one
 * of these and is adapted. A wall carrying an *older* Classic than that — the
 * pre-rebalance proportions, or the `cellEvents: 'pills'` a pre-0.53 backfill
 * stored — prints as none of them and is left exactly where it is. That is the
 * same line this repository already draws around a stored canvas: correcting a
 * default is one decision and rewriting somebody's arrangement is another.
 */
const SEEDED_PRINTS: readonly string[] = CLASSIC_VARIANTS.map(templatePrint);

/**
 * Move a still-seeded wall onto the Classic variant matching what the household
 * has set up now.
 *
 * The problem this closes: a canvas is chosen once, at seeding, and a fresh
 * install is seeded before the household has configured anything. Add a
 * location a week later and the forecast has nowhere to go, because the box
 * that would have held it was never placed. So the choice is re-made on boot —
 * but only for a wall that is *provably still the one we seeded*.
 *
 * **The gate is the whole of this function, and it is a proof rather than a
 * marker.** A stored canvas is ours only if it prints byte-identical to one of
 * `CLASSIC_VARIANTS` — same aspect, same background, same boxes to six decimal
 * places, same configs, same stacking. Drag one box a pixel, change the aspect,
 * set a background, add or remove a widget, apply any other template, or empty
 * the canvas, and it matches nothing and is never written to again. There is no
 * "probably untouched": when in doubt, do nothing.
 *
 * It runs only after `layout_backfilled` — the one-shot marker that says this
 * database has been seeded at all. Before that, seeding is `backfillClassic`'s
 * job and this must not run ahead of it.
 *
 * Boot is the moment, deliberately. A household changing a setting is looking
 * at an admin screen, not at the wall, and rewriting a canvas under somebody
 * mid-edit is the one thing worse than a hole; `POST /admin/screens` and Reset
 * layout already seed from the current set-up, so the ordinary path never waits
 * for a restart.
 */
export function reseedClassicForSetUp(db: SqliteDatabase, setUp: HouseholdSetUp): void {
  const flag = db
    .prepare(`SELECT layout_backfilled AS done FROM household_settings WHERE id = 'singleton'`)
    .get() as { done: number } | undefined;
  if (flag === undefined || flag.done !== 1) return;

  const want = classicFor(setUp);
  const wantPrint = templatePrint(want);
  const owners: (string | null)[] = [null, ...readScreens(db).map((screen) => screen.id)];
  for (const owner of owners) {
    const current = ownerPrint(db, owner);
    if (current === undefined) continue;
    // Already the right arrangement: nothing to write, and a write would mint
    // fresh widget ids for no reason.
    if (current === wantPrint) continue;
    if (!SEEDED_PRINTS.includes(current)) continue;
    applyTemplate(db, owner, want);
  }
}

/** The mode, per-orientation aspect and background a display owns, for copy. */
function ownerLayout(
  db: SqliteDatabase,
  owner: string | null,
): {
  mode: string;
  portraitAspect: number;
  landscapeAspect: number;
  portraitBackground: string | null;
  landscapeBackground: string | null;
} {
  const household = readHousehold(db);
  const screen = owner === null ? undefined : readScreens(db).find((s) => s.id === owner);
  return {
    mode: screen?.layoutMode ?? household.layoutMode,
    portraitAspect: screen?.layoutAspect ?? household.layoutAspect,
    landscapeAspect: screen?.layoutLandscapeAspect ?? household.layoutLandscapeAspect,
    portraitBackground: screen?.layoutBackground ?? household.layoutBackground,
    landscapeBackground: screen?.layoutLandscapeBackground ?? household.layoutLandscapeBackground,
  };
}

/**
 * Copy one display's whole layout onto another — the "start from another wall"
 * convenience the hybrid model gives instead of shared layout profiles.
 *
 * Both canvases and the mode are read from the source and written to the target;
 * widget ids are re-minted so the two displays' rows stay distinct. A one-shot
 * copy into the target's own storage, not a live link — changing the source
 * later does not change the target.
 */
export function copyLayout(db: SqliteDatabase, from: string | null, to: string | null): void {
  const source = ownerLayout(db, from);
  for (const orientation of ORIENTATIONS) {
    const widgets: LayoutWidgetInput[] = readLayoutWidgets(db, from, orientation).map((widget) => ({
      id: widgetId(),
      type: widget.type,
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      z: widget.z,
      ...(widget.config !== undefined ? { config: widget.config } : {}),
    }));
    replaceLayout(db, to, orientation, {
      mode: source.mode,
      aspect: orientation === 'landscape' ? source.landscapeAspect : source.portraitAspect,
      widgets,
      background: orientation === 'landscape' ? source.landscapeBackground : source.portraitBackground,
    });
  }
}

/** A template by id, or undefined — the apply route validates the id this way. */
export function findTemplate(id: string): DisplayTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
