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
const widgetConfigFields = z
  .object({
    // Calendar
    calendars: z.array(z.string().max(64)).max(50).optional(),
    // month (grid), week (day columns), or list (agenda). RFC 005 added week.
    // `skyweek` and `skymonth` are the same two shapes drawn edge to edge, with
    // hairline dividers instead of gaps and cards — every pixel spent on the
    // calendar rather than on the space around it.
    mode: z.enum(['month', 'week', 'list', 'skyweek', 'skymonth']).optional(),
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
    /*
     * Shift — whose rota the badge draws, and which of its lines.
     *
     * `people` is a list of person ids; none chosen means everyone on a rota,
     * the same "empty selection means all" the calendar and reading pickers
     * use. It is what makes a two-worker household expressible: before it, the
     * wall drew the first person sorted and nothing could say otherwise.
     *
     * The three `show…` keys follow `showShifts` above — *absence means on*,
     * because the face, the hours and the run have been drawn since the badge
     * existed and a household who arranged a canvas around them must not lose
     * them to a schema change. The only value ever stored is `false`.
     */
    people: z.array(z.string().max(64)).max(20).optional(),
    /*
     * The field ladder: which rows the badge draws, in the order they matter.
     *
     * The order is the drop order too — when the box cannot hold them all the
     * renderer gives them up from the bottom — so one list carries both what is
     * shown and what is sacrificed. An *ordered allowlist*, deliberately, and
     * not a template: there is no expression here and no household-authored
     * string that reaches a renderer, which is the same argument the recipe
     * engine's transform makes.
     *
     * Absent means the ladder the widget always drew, minus whatever its own
     * switches turned off (`showHours`/`showRun` for a shift badge,
     * `showIcon`/`showLow` for a forecast strip, and each entity's own
     * `display_mode` for a Home Assistant reading) — so a widget saved before
     * this existed is untouched. Present, it is the complete list and those switches
     * no longer apply to it; the editor clears them when it writes this.
     *
     * One enum for every widget with a ladder, because the config is one strict
     * object for every type: each resolver filters to its own allowlist, so a
     * Weather widget carrying a shift field reads as "not for me" rather than as
     * a row nothing can render. The alternative — a key per widget — would be
     * four names for one idea.
     */
    fields: z
      .array(
        z.enum([
          'person', 'shift', 'hours', 'run',
          'name', 'icon', 'high', 'low',
          'label', 'value',
        ]),
      )
      .max(10)
      .optional(),
    shiftName: z.enum(['label', 'code']).optional(),
    showFace: z.boolean().optional(),
    showHours: z.boolean().optional(),
    showRun: z.boolean().optional(),
    /*
     * Clock.
     *
     * `clockFormat` absent means "follow the household", which is what every
     * clock on every wall has drawn until now — so it is an absence and not a
     * third enum member that would have to be stored to mean the default.
     * `showDate` is absence-means-on like the shift switches above.
     *
     * There is deliberately no "show seconds": the wall redraws every fifteen
     * seconds, so a seconds field would be wrong far more often than right.
     */
    clockFormat: z.enum(['12', '24']).optional(),
    showDate: z.boolean().optional(),
    /*
     * Weather. `count` is shared with the calendar's agenda above — one strict
     * object for every type, and a key a type does not read is simply not read.
     *
     * `showIcon` is the wall's: the panel's bitmap font is 0x20–0x7E and a
     * forecast glyph is not in it, so a 1-bit frame has no icon to hide.
     */
    showLow: z.boolean().optional(),
    showIcon: z.boolean().optional(),
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
  });

/**
 * The ink lane: what this widget does differently on a black-and-white panel
 * (RFC 005, direction B).
 *
 * *Picked* from the fields above rather than declared again, so an ink override
 * is validated by exactly the rule its wall twin is — a `count` that is out of
 * range on the wall is out of range here, with the same message, for ever,
 * without anybody remembering to change two places.
 *
 * The pick is what makes "one level deep" a fact about the shape rather than a
 * promise in a comment: `ink` is not among the picked keys, so `ink.ink` is a
 * rejected key and not a recursion anybody has to bound. It is also why the
 * lane cannot carry a title, a note's text, an image or a module — a panel says
 * *less* than the wall it follows, never something else. `INK_KEYS` in
 * `epaper/honours.ts` is the same list from the renderer's side, and
 * `epaper-ink.test.ts` holds the two to each other.
 *
 * Strict, like everything else: an unknown key here is a 400 and never a
 * silently dropped option (rule five).
 */
export const inkOverrideBody = widgetConfigFields
  .pick({
    align: true,
    calendars: true,
    cellEvents: true,
    clockFormat: true,
    count: true,
    fields: true,
    mode: true,
    people: true,
    readings: true,
    shiftName: true,
    showDate: true,
  })
  .strict();

export const widgetConfigBody = widgetConfigFields
  .extend({ ink: inkOverrideBody.optional() })
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
