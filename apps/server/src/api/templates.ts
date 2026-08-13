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
    theme: z.enum(['household', 'blueprint', 'panels', 'almanac']).optional(),
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
