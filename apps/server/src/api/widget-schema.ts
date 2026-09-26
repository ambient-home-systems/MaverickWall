import { z } from '../validation.js';
import { WIDGET_TYPES } from './manifest.js';
import { widgetStyleBody } from './widget-style.js';
import { EMOJI_KEYS } from '../emoji.js';
import { isWallpaperId } from '../wallpapers.js';

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
    /*
     * Which renderer draws the widget: month (grid), week (day columns) or list
     * (agenda) for a calendar. RFC 005 added week.
     *
     * `people` is the Chores widget's by-person board; `week` is shared with the
     * calendar's day columns and means the same thing on both — seven days
     * across. One key for every type's view, because the editor's View picker is
     * generic and writes this for all of them.
     *
     * **`skyweek` and `skymonth` are accepted and never written.** They were the
     * same week and the same month drawn edge to edge, offered as two more
     * views — which made a density choice look like a fourth and fifth thing to
     * draw. `density` below is that choice on its own axis now, and the old
     * values map to (view, compact) at the read boundary: `calendarView`, in
     * `apps/display/src/widget-views.ts` and transcribed into
     * `epaper/calendar-view.ts`. They stay in this enum for ever, because a
     * canvas hanging in somebody's kitchen holds one and must keep validating
     * — no migration rewrites a stored arrangement.
     */
    mode: z.enum(['month', 'week', 'list', 'skyweek', 'skymonth', 'people']).optional(),
    /*
     * How much room the calendar spends on itself: `comfortable` (cards, gaps,
     * breathing room) or `compact` (hairlines, edge to edge, more of the week
     * in the same box). **Absent means comfortable**, the way every default in
     * this schema is an absence — so a wall saved before this key existed sends
     * a byte-identical config and no stored ETag churns.
     *
     * Read only by the wall. A 1-bit panel is already edge to edge and has no
     * padding to reclaim, so it draws one density; `PANEL_IGNORES` is where a
     * household is told that, beside the control they set.
     */
    density: z.enum(['comfortable', 'compact']).optional(),
    // How a month cell draws its events: flat names (`text`, the default),
    // quiet `dots`, Skylight-style labelled `pills`, or `swiss` — the same flat
    // names inside the full Swiss typographic grid. `text` and `swiss` wrap to
    // two lines, draw a title whole or not at all, and put a muted +N under
    // what is left out.
    //
    // **Absent means `text`**, and that is a change of meaning rather than a
    // new option: it used to mean `dots`. Measured on a 1080x1920 wall with
    // three ordinary family calendars, pills clipped 32 of 37 event names, so
    // the default became the treatment that can show one. `dots` is stored
    // explicitly now, which is what keeps it choosable.
    cellEvents: z.enum(['dots', 'pills', 'swiss', 'text']).optional(),
    count: z.number().int().min(1).max(50).optional(),
    // The day's high and low beside its date in the agenda (RFC 010 phase 3).
    // Absent means off, so a wall that already carries a weather strip does not
    // suddenly say it twice — this is the household choosing to spend the strip.
    showWeather: z.boolean().optional(),
    // The week of the year: a column beside the month grid, a line above the
    // week columns. Absent means off (RFC 010 phase 4).
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
     * `people` is a list of person ids, shared with the Chores widget's "whose
     * chores" picker — one key, one meaning. Chores first filtered by *name*,
     * which collided here on a merge: two declarations of one key, the later
     * silently winning. Ids are also simply better, since renaming somebody no
     * longer empties the widget that was filtering on them.
     *
     * None chosen means everyone on a rota,
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
     * A designed variant of the widget (RFC 014 §4.2): the same reading drawn
     * a different way on purpose, the Swiss month grid's shape one widget
     * along. **One enum for every type**, the way `mode` is, because the
     * editor's Look picker is generic and a key per widget would be six names
     * for one idea — so each renderer filters to its own allowlist and a value
     * a type does not know is "not for me", drawn as that type's default.
     *
     * The clock was the first: `plain` (the clock every wall has drawn),
     * `stacked` (the time over the weekday over the date) and `analogue` (a
     * filled face with two hands). **Absent means `plain`**, like every
     * default in this schema, so a canvas saved before this key existed sends
     * a byte-identical config and no stored ETag churns. `plain` is still a
     * member rather than only an absence, because the ink lane has to be able
     * to say "plain on the panel" beside a wall that says `stacked`.
     *
     * The September household review added a list per type (plan item P4.1),
     * each with its default first: weather (`strip`, `today`, `range`,
     * `colour`, `playful`), countdown (`number`, `page`, `ticket`,
     * `occasion`, `progress`, `month`), Home Assistant (`list`, `tile`) and
     * the calendar (`planner`, `bold`, its own look being an absence with no
     * name). Which type draws which value is `VARIANTS` in
     * `apps/display/src/variants.ts` and its transcription in
     * `epaper/variants.ts`; `variants-parity.test.ts` holds this enum to be
     * exactly their union. **Only the clock's draw anything yet** — every
     * other value is stored, accepted and drawn as its type's default until
     * the session that designs it.
     */
    variant: z
      .enum([
        // clock
        'plain', 'stacked', 'analogue',
        // weather
        'strip', 'today', 'range', 'colour', 'playful',
        // countdown
        'number', 'page', 'ticket', 'occasion', 'progress', 'month',
        // homeassistant
        'list', 'tile',
        // calendar
        'planner', 'bold',
      ])
      .optional(),
    /*
     * Group (RFC 014 §5.1) — how a group lays its children out inside its own
     * box: a `row` divides the group's inner box equally across its children in
     * `z` order, a `column` divides it down, a `grid` fills `columns` across and
     * as many rows as the children need, and `free` places each child at its
     * own stored fractions of the group's box. **Absent means `row`**, like
     * every default here, and `columns` absent means two; it is read on `grid`
     * alone.
     *
     * The children keep their own stored `x`/`y`/`w`/`h`, as fractions of the
     * group's box. A group in any of the three *ordered* layouts **ignores
     * them** and places from order — there they are kept so an ungroup later
     * can put the boxes back where they were. A `free` group is the one the
     * editor's Group action makes, precisely because it reads them: the
     * children stay exactly where they were on the wall, so grouping moves
     * nothing on the glass until the household picks an ordered layout. Either
     * way a group's geometry is a function of the arrangement alone and never
     * of the events: `reflow-stability.test.ts` holds two walls with the same
     * arrangement and different events to identical child rectangles.
     *
     * Only a `group` reads either key; on any other type both are "not for
     * me", exactly as `variant` is. A group carries no `whenEmpty` of its own —
     * its children are boxes and each resolves its own — and is dropped whole
     * when none of them has anything to say (`keepWidgetsWithSomethingToSay`).
     */
    layout: z.enum(['row', 'column', 'grid', 'free']).optional(),
    columns: z.number().int().min(2).max(4).optional(),
    /*
     * Weather. `count` is shared with the calendar's agenda above — one strict
     * object for every type, and a key a type does not read is simply not read.
     *
     * `showIcon` is the wall's: the panel's bitmap font is 0x20–0x7E and a
     * forecast glyph is not in it, so a 1-bit frame has no icon to hide.
     */
    showLow: z.boolean().optional(),
    showIcon: z.boolean().optional(),
    /*
     * The `playful` look's advice line (plan item P5.1) — "Umbrella day" when
     * today calls for one. Absence means on, like `showFace`: only `playful`
     * reads it, so a wall that has not picked that look is unchanged whatever
     * this says.
     */
    advice: z.boolean().optional(),
    /*
     * Home Assistant — which watched readings this widget shows, **by entity
     * id** (P1.3); absent or empty is all of them. It held labels until then,
     * so a rename took a reading off every widget that had picked it, and a
     * widget saved before is still read correctly: `readingHandlesFor` treats
     * an entry that is a current reading's label as that reading. The entity
     * id never reaches a wall — `displayConfig` sends the handle in its place.
     * 255 rather than the 80 a label needed, because that is what an entity id
     * may be (`watchBody` accepts it) and a picker offering an id the save
     * then refused would be a choice that cannot be made.
     */
    readings: z.array(z.string().max(255)).max(50).optional(),
    // Countdown — a target date (YYYY-MM-DD); the label rides in `title`.
    target: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'A countdown date has to be YYYY-MM-DD.')
      .optional(),
    /*
     * Countdown, since plan item P5.2 — three more, every one absent by
     * default and every absence exactly what a countdown drew before:
     *
     *  - `unitWords` counts in `days` or in `sleeps` ("12 sleeps until
     *    Christmas"). Absent is days. Sleeps count forward only: a date that
     *    has passed reads "3 days ago" whichever is chosen.
     *  - `emoji` is a **key** from the bundled set (P4.2), drawn beside the
     *    label as an `<img>` — never a code point, so every wall draws the same
     *    picture (D6). A key outside the set is refused rather than dropped.
     *    A panel draws none of them; `asciiTitle` is still its guard.
     *  - `celebrate` plays confetti on the day. **Absent is on**, the one
     *    default here that does anything, and the day is the only time it
     *    does: a burst the first time the day is drawn and at most once an
     *    hour after. Only `false` switches it off.
     */
    unitWords: z.enum(['days', 'sleeps']).optional(),
    emoji: z.enum(EMOJI_KEYS).optional(),
    celebrate: z.boolean().optional(),
    /*
     * Countdown, the item's second half (P5.2):
     *
     *  - `occasion` dresses the `occasion` look for Christmas, a birthday,
     *    Halloween, a holiday, the end of term, New Year, or something else.
     *    Absent is `custom` — the theme's own accent and the household's own
     *    picture — which is the wall's reading and the panel's (where the look
     *    is drawn as the number anyway).
     *  - `from` is the start date a `progress` bar counts its days gone from.
     *    **Refused, never coerced, when it is not before `target`**: a bar from
     *    a start after its own end has no honest length, and quietly swapping
     *    the two or clamping one to the other would draw a number the household
     *    did not choose. The check is on the whole config rather than here,
     *    because it is a fact about two fields (`startBeforeTarget`).
     */
    occasion: z
      .enum(['christmas', 'birthday', 'halloween', 'vacation', 'schools-out', 'new-year', 'custom'])
      .optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'A countdown start date has to be YYYY-MM-DD.')
      .optional(),
    // External module widget — which registered module's panel to draw (its id).
    module: z.string().max(64).optional(),
    // Image widget — a stored image's own name (RFC 005 Phase 3b). Served from
    // the household's media store, never an external URL (rule three).
    image: storedImageName.optional(),
    // Notes — free text the household typed, drawn as written (line breaks kept).
    text: z.string().max(2000).optional(),
    // To-do — a static checklist. Each item is a line the household typed, and
    // it is edited in the admin: these lines are not a Home Assistant list, so
    // there is nothing a tick could write back to and the box stays a marker
    // whatever the wall is allowed to do. The `list` key below is the other
    // case, and it *does* tick (RFC 012 phase 2) — the two are deliberately one
    // widget, and which source a box draws is the one thing that decides it.
    items: z.array(z.string().max(200)).max(40).optional(),
    /*
     * To-do, from Home Assistant (RFC 012 phase 1) — which watched list the
     * widget draws, by entity id. **Absent means the typed `items` above**,
     * exactly as today, so a widget saved before this key existed sends a
     * byte-identical config; present, the items are the list's and the typed
     * ones are left where they are, untouched. The entity id is stored here
     * and never reaches a wall: `displayConfig` in `manifest.ts` turns it into
     * the handle the to-do panel keys its lists by.
     *
     * `showDone` draws the completed items too, struck through. Off by default
     * because a shopping list ticked on a phone and never cleared grows for
     * ever, and the wall is a place to read the list rather than the place it
     * is administered (RFC 012 §7.5).
     *
     * Whether a box on that list can be *ticked* is not here and never will be:
     * it is `screens.allow_todo`, a fact about the hardware a wall is rather
     * than about the widget, set on the wall's own settings page beside alert
     * dismissal and the chore tick. One widget on two walls is a control on one
     * of them and a marker on the other, which is exactly the distinction a
     * per-widget key could not express.
     */
    list: z
      .string()
      .regex(/^todo\.[a-z0-9_]+$/, 'That is not a Home Assistant to-do list.')
      .max(255)
      .optional(),
    showDone: z.boolean().optional(),
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
    unitWords: true,
    variant: true,
  })
  .strict();

/**
 * The style lane (RFC 014 §4.1): this widget's own colours, faces, weight,
 * tracking and inset, resolved server-side and carried to the wall as
 * `styleTokens` — see `widget-style.ts`, which owns the shape. Beside `ink`
 * rather than inside `widgetConfigFields`, for the same reason `ink` is: it
 * is a lane over the widget rather than one of its options, and it must not
 * be pickable *into* the ink lane (`ink.style` is a rejected key).
 */
const laneConfigFields = widgetConfigFields.extend({
  ink: inkOverrideBody.optional(),
  style: widgetStyleBody.optional(),
});

/**
 * What a box draws when it has nothing to say (RFC 014 §5.3): another widget,
 * in the same rectangle.
 *
 * `config` is the widget's own config *less* `whenEmpty` and `ink` — omitted
 * from the lanes above rather than declared again, so a fallback is validated
 * by exactly the rule a placed widget of its type is, and the shape stops one
 * level down the way `ink.ink` does: `whenEmpty.config.whenEmpty` is a
 * rejected key, not a recursion anybody has to bound. `ink` goes with it
 * because a fallback is the wall's substitution, and a panel following that
 * wall draws the same fallback — an override on it would be a panel saying
 * something the wall does not, one level further in than the ink lane allows.
 *
 * The style lane stays: a note standing in for a forecast is still a box on
 * this wall, and may be dressed like one.
 */
/**
 * The sentence a countdown's start date on or after its target is refused
 * with (plan item P5.2) — written for somebody choosing two dates, and the
 * editor says it beside the field before the save is tried
 * (`START_AFTER_TARGET` in the display's `countdown.ts`, the same words).
 */
export const START_AFTER_TARGET = 'The start date has to be before the date it counts down to.';

/**
 * A countdown's start date comes before its target, or the config is refused
 * with a sentence (plan item P5.2). Only when both are set: a start with no
 * target yet is a household halfway through filling the form in, and the wall
 * already says "Set a date" for that.
 *
 * Compared as civil dates, which as `YYYY-MM-DD` strings sort as they read.
 * On the whole config rather than on `from`, because a field cannot see its
 * neighbour; attached to each schema that is *parsed* rather than to the
 * fields they are built from, since zod refuses to extend or pick from an
 * object that carries a refinement.
 */
function startBeforeTarget(config: { from?: string | undefined; target?: string | undefined }, ctx: z.RefinementCtx): void {
  if (config.from === undefined || config.target === undefined) return;
  if (config.from < config.target) return;
  ctx.addIssue({ code: 'custom', path: ['from'], message: START_AFTER_TARGET });
}

export const whenEmptyConfigBody = laneConfigFields.omit({ ink: true }).strict().superRefine(startBeforeTarget);

export const whenEmptyBody = z
  .object({ type: z.enum(WIDGET_TYPES), config: whenEmptyConfigBody.optional() })
  .strict();

export const widgetConfigBody = laneConfigFields
  .extend({ whenEmpty: whenEmptyBody.optional() })
  .strict()
  .superRefine(startBeforeTarget);

/**
 * A canvas background, of four kinds: a solid colour, a two-stop gradient, a
 * first-party uploaded image (RFC 005 Phases 3 and 3b), or a bundled wallpaper
 * by its catalogue id (plan item P6.1).
 *
 * Colours are the same `#rrggbb` hex the format controls use, rejected not
 * coerced (rule five). Shared so the editor's save route and the templates validate it
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
  // A bundled wallpaper (plan item P6.1), by its id in `wallpapers.ts` and by
  // nothing else — never a file name, which is the server's to resolve and
  // which changes whenever the picture does. An id the catalogue does not name
  // is refused here (rule five); one that stops being named after it was
  // saved is dropped by `parseBackground` and the canvas draws its theme.
  z
    .object({
      type: z.literal('wallpaper'),
      id: z.string().max(64).refine(isWallpaperId, 'That is not one of the wallpapers.'),
    })
    .strict(),
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

/**
 * A placed widget as the editor posts it — it carries a stable id and z.
 *
 * `parentId` names the group this widget sits inside (RFC 014 §5.1): its box
 * is then fractions of that group's, and its `z` is relative to it. Optional
 * and absent for every widget on the canvas itself, which is every widget an
 * editor that predates groups posts. The link is checked across the whole
 * posted canvas by `placedWidgetsBody` below — a widget alone cannot say
 * whether the id it names is a group on the same canvas.
 */
export const layoutWidgetBody = z.object({
  id: z.string().min(1).max(64),
  ...box,
  z: zOrder,
  parentId: z.string().min(1).max(64).optional(),
});

/**
 * What a list of placed widgets has to get right about its groups, stated once
 * for every boundary that takes one (RFC 014 §5.1).
 *
 * Three refusals, each a 400 rather than a row the wall would have to explain:
 *
 *  - **A group never has a parent.** Nesting is one level, and it is bounded
 *    here the way `ink.ink` is — refused at the boundary rather than clamped
 *    somewhere a renderer has to remember. `placeCanvas` refuses it a second
 *    time, because a row can reach the database by more than one door.
 *  - **A parent is a group on the same canvas.** A child naming a stranger's
 *    id, a widget of another type, or nothing at all is refused, never
 *    orphaned onto the canvas at fractions that were of somebody else's box.
 *  - **Ids are unique**, or a parent link could name two rows at once.
 *
 * Generic over the two spellings of the link — the editor's save names a
 * parent by *id* and a template by a local *key* (ids are minted at apply
 * time, so a template cannot carry one) — so one rule serves both and cannot
 * be updated on one side only.
 */
export function widgetTreeIssues<T extends { readonly type: string }>(
  widgets: readonly T[],
  idOf: (widget: T, index: number) => string | undefined,
  parentOf: (widget: T) => string | undefined,
): string[] {
  const issues: string[] = [];
  const groups = new Set<string>();
  const seen = new Set<string>();
  widgets.forEach((widget, index) => {
    const id = idOf(widget, index);
    if (id === undefined) return;
    if (seen.has(id)) issues.push(`Two widgets share the id "${id}".`);
    seen.add(id);
    if (widget.type === 'group') groups.add(id);
  });
  widgets.forEach((widget, index) => {
    const parent = parentOf(widget);
    if (parent === undefined) return;
    if (widget.type === 'group') {
      issues.push('A group cannot sit inside another group.');
      return;
    }
    if (!groups.has(parent)) {
      issues.push(`Widget ${idOf(widget, index) ?? index} names a parent that is not a group on this layout.`);
    }
  });
  return issues;
}

/**
 * A whole canvas of placed widgets, as every save and preview route takes it.
 *
 * A wall is a few widgets, not a dashboard: the cap is a guard, not a target.
 * The tree rule is applied here rather than per widget because it is a
 * property of the list — `layoutWidgetBody` alone cannot see the row a
 * `parentId` names.
 */
export const placedWidgetsBody = z
  .array(layoutWidgetBody)
  .max(50)
  .superRefine((widgets, ctx) => {
    for (const message of widgetTreeIssues(widgets, (w) => w.id, (w) => w.parentId)) {
      ctx.addIssue({ code: 'custom', message });
    }
  });

/** A template's local name for a widget, so another can name it as its group. */
const templateKey = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens only');

/**
 * A widget as a template ships it — the same shape, minus the id, with z
 * optional (a template's stacking is its array order unless it says otherwise).
 *
 * A template is arrangement, not identity: ids are minted when it is applied to
 * a wall (`applyTemplate`), so two displays started from one template do not
 * share widget ids. Everything else is the *same* validation the editor's save
 * goes through, which is the whole point — a template is a saved arrangement of
 * options a household could set by hand, and nothing more.
 *
 * A group is named by a local **`key`** and its children name it as `parent`
 * (RFC 014 §5.1). A key rather than an index into the array, because a
 * template is edited by hand and an index breaks the moment a widget is added
 * above it; a key reads as what it is. `applyTemplate` mints an id for every
 * parent first, then writes each child with the id its key resolved to — so
 * the stored rows carry `parent_id` and the template never does. The same
 * tree rule a save is held to is applied per canvas in `templateCanvasSchema`.
 */
export const templateWidgetSchema = z.object({
  ...box,
  z: zOrder.optional(),
  key: templateKey.optional(),
  parent: templateKey.optional(),
});
