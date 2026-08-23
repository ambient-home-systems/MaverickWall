import { z } from '../validation.js';
import { WIDGET_TYPES } from './manifest.js';

/**
 * A stored image's own name — 64 hex plus a known extension, the shape
 * `media.ts` mints from a content hash. A traversal cannot be spelled in that
 * alphabet, so an image reference is validated as this and never a path.
 */
export const storedImageName = z
  .string()
  .regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/, 'That is not a stored image name.');

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
    // `skyweek` and `skymonth` are the same two shapes drawn edge to edge, with
    // hairline dividers instead of gaps and cards — every pixel spent on the
    // calendar rather than on the space around it.
    // `people` is the Chores widget's by-person board; `week` is shared with the
    // calendar's day columns and means the same thing on both — seven days
    // across. One key for every type's view, because the editor's View picker is
    // generic and writes this for all of them.
    mode: z.enum(['month', 'week', 'list', 'skyweek', 'skymonth', 'people']).optional(),
    // How a month cell draws its events: quiet dots (default) or Skylight-style
    // labelled pills. Absent means dots, so an existing wall is unchanged.
    cellEvents: z.enum(['dots', 'pills']).optional(),
    count: z.number().int().min(1).max(50).optional(),
    // The day's high and low beside its date in the agenda (RFC 007 phase 3).
    // Absent means off, so a wall that already carries a weather strip does not
    // suddenly say it twice — this is the household choosing to spend the strip.
    showWeather: z.boolean().optional(),
    // The week of the year: a column beside the month grid, a line above the
    // week columns. Absent means off (RFC 007 phase 4).
    showWeekNumbers: z.boolean().optional(),
    /*
     * The rota's colours on the calendar — the cell tint on a month, the rule
     * down an agenda row, the shift's own name and hours.
     *
     * The one config key here whose *absence means on*, because it has been on
     * since the wall was first drawn and a household who arranged a canvas
     * around those colours must not lose them to a schema change. So the only
     * value ever stored is `false`.
     */
    showShifts: z.boolean().optional(),
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
    // Image widget — a stored image's own name (RFC 005 Phase 3b). Served from
    // the household's media store, never an external URL (rule three).
    image: storedImageName.optional(),
    // Notes — free text the household typed, drawn as written (line breaks kept).
    text: z.string().max(2000).optional(),
    // Chores — whose to show, by person name (the manifest carries no person id
    // on a chore, so a selection can only be by the name the household sees).
    // None ticked shows everybody, which is what a bare widget draws.
    people: z.array(z.string().max(60)).max(20).optional(),
    // To-do — a static checklist. Each item is a line the household typed; the
    // wall is read-only, so items are shown, not ticked (edited in the admin).
    items: z.array(z.string().max(200)).max(40).optional(),
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

/**
 * A canvas background (RFC 005 Phase 3): a solid colour or a two-stop gradient.
 *
 * Colours are the same `#rrggbb` hex the format controls use, rejected not
 * coerced (rule five). A first-party image background is Phase 3b and adds a
 * variant here. Shared so the editor's save route and the templates validate it
 * the same way — a template can set no background a household could not.
 */
const hex6 = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour has to be a #rrggbb hex.');

export const backgroundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('solid'), color: hex6 }).strict(),
  z
    .object({
      type: z.literal('gradient'),
      from: hex6,
      to: hex6,
      angle: z.number().int().min(0).max(359).optional(),
    })
    .strict(),
  // An uploaded image, by its stored name (RFC 005 Phase 3b). The wall covers the
  // canvas with it; no external URL, ever (rule three) — it is served from the
  // household's own media store through the SSRF boundary that already exists.
  z.object({ type: z.literal('image'), image: storedImageName }).strict(),
]);

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
