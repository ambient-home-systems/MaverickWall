import { z } from '../validation.js';
import { WIDGET_TYPES } from './manifest.js';

/**
 * The shared shape of a free-form widget and its options.
 *
 * One schema, used by both the editor's save route (`/admin/layout`) and the
 * baked-in templates (RFC 005), so a template can place nothing a household
 * could not place by hand — the invariant that keeps a template from being a
 * back door. It lives here rather than in `http/admin.ts` precisely so the
 * template source can reuse it without a page importing from a page.
 *
 * `WIDGET_TYPES` is where rule three is enforced: a `website`, `iframe` or
 * `video` is rejected here, never reaching the database or the wall.
 */

/**
 * A widget's stored options.
 *
 * One shape for every type rather than a discriminated union: the keys a type
 * ignores are simply not read by its renderer, and a single strict object is
 * easier to reason about than five. `.strict()` rejects an unknown key rather
 * than coercing it away (rule five) — a typo in a saved config is a 400, not a
 * silently dropped option. Selections are by identifiers already in the
 * manifest: calendar `source id`s and Home Assistant reading `label`s, never an
 * entity id, which the manifest deliberately does not carry.
 */
export const widgetConfigBody = z
  .object({
    // Calendar
    calendars: z.array(z.string().max(64)).max(50).optional(),
    // month (grid), week (day columns), or list (agenda). RFC 005 added week.
    mode: z.enum(['month', 'week', 'list']).optional(),
    // How a month cell draws its events: quiet dots (default) or Skylight-style
    // labelled pills. Absent means dots, so an existing wall is unchanged.
    cellEvents: z.enum(['dots', 'pills']).optional(),
    count: z.number().int().min(1).max(50).optional(),
    showTimes: z.boolean().optional(),
    showLocations: z.boolean().optional(),
    // Home Assistant
    readings: z.array(z.string().max(80)).max(50).optional(),
    // Countdown — a target date (YYYY-MM-DD); the label rides in `title`.
    target: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'A countdown date has to be YYYY-MM-DD.')
      .optional(),
    // External module widget — which registered module's panel to draw (its id).
    module: z.string().max(64).optional(),
    // Format (every widget) — box-level, so it applies whatever the type draws.
    title: z.string().max(60).optional(),
    showTitle: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    // A six-digit hex, the only colour shape `<input type=color>` submits, and
    // the only one the renderer will honour — rejected here, not coerced.
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'A background colour has to be a #rrggbb hex.')
      .optional(),
    opacity: z.number().int().min(0).max(100).optional(),
    corners: z.enum(['square', 'rounded']).optional(),
    shadow: z.boolean().optional(),
  })
  .strict();

/** The coordinate and size bounds a widget shares wherever it is placed. */
const box = {
  type: z.enum(WIDGET_TYPES),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  // A widget cannot be nudged off the wall or shrunk to nothing.
  w: z.number().min(0.02).max(1),
  h: z.number().min(0.02).max(1),
  config: widgetConfigBody.optional(),
};
const zOrder = z.number().int().min(0).max(9999);

/** A placed widget as the editor posts it — it carries a stable id and z. */
export const layoutWidgetBody = z.object({ id: z.string().min(1).max(64), ...box, z: zOrder });

/**
 * A widget as a template ships it — the same shape, minus the id, with z
 * optional (a template's stacking is its array order unless it says otherwise).
 *
 * A template is arrangement, not identity: ids are minted when it is applied to
 * a wall (`applyTemplate`), so two displays started from one template do not
 * share widget ids. Everything else is the *same* validation the editor's save
 * goes through, which is the whole point — a template is a saved arrangement of
 * options a household could set by hand, and nothing more.
 */
export const templateWidgetSchema = z.object({ ...box, z: zOrder.optional() });
