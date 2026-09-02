/**
 * Density tiers for the six widgets that were scaled to fit.
 *
 * `tiers.ts` did this for the calendar and this is the same table one widget
 * along, for weather, shift, homeassistant, notes, todo and chores. What it
 * replaces is `fitToBox`, and the difference is worth stating once here because
 * every threshold below is an answer to it.
 *
 * **A uniform transform is photographic enlargement.** `fitToBox` laid a
 * section out at one size and wrote `transform: scale(f)` on it, so it could
 * change a widget's *apparent* size and could never change what the widget
 * *said*. Measured on the shipped Classic wall, that is one number down a
 * column: the forecast drew five days at 480x800 and five days at 2560x1440,
 * the shift badge three rows at both, and the agenda six events over two days
 * at every size in a 3.7-megapixel range. The floors bolted on top of it
 * (`MIN_CALENDAR_SCALE`, `MIN_CHORE_SCALE`) were correct bandages on the wrong
 * mechanism, and `density.ts`'s own comment stated the bill: *a wall that drew
 * six days now draws two*. Trading content for legibility is only necessary
 * when the layout cannot reflow.
 *
 * So nothing is scaled any more. A widget's type is its role — the reader's
 * own angle on a measured wall, the canvas-relative rem on one nobody has
 * measured — and the **box picks a form**: how many things are drawn, and how
 * much each of them says.
 *
 * **The thresholds are in `ch` and `em` of the widget's own primary text
 * role**, exactly as `CALENDAR_TIERS` is, and for the same reason: the role is
 * already distance-corrected, so "12ch wide" means twelve characters of the
 * size that household can read from where they stand. Which role is "primary"
 * is a judgement per widget and it is written down at each table — a forecast's
 * primary text is its *temperatures* rather than its day names, which is the
 * fault `epaper-proportional` already recorded once (a threshold measured with
 * the tallest run of text cannot see the shortest one collapse).
 *
 * **The ladder is where two of these tables already existed.** `ladder.ts` is
 * "an ordered list of fields, given up from the bottom when the box cannot hold
 * them" — a tier is that threshold made explicit. `rungs` below is the ladder's
 * length at each tier, so the wall stops *dropping and re-measuring* (fit,
 * overflow?, drop a rung, fit again) and reads the answer off a table instead.
 * The ladder's own rule survives untouched and is stated here as well as there:
 * **at one rung a badge draws a line rather than a word**, because a box with
 * room for one row spending it on "Amy" when "Amy: Days · 07:00–19:00" fits is
 * the same room spent on strictly less.
 *
 * **How many, and how much, are two different questions and only one of them
 * is measured.** `rungs` is the tier's own number and nothing else: a taller
 * box reaches a higher tier and the higher tier says more. `items` is the
 * tier's number as a *floor*, with the height (or, for a strip of days, the
 * width) buying more — the rule `namesAt` states, for the reason it states it:
 * a table that capped at its own threshold would be a table about boxes that
 * land exactly on one, and a 20em column drawing what a 10em one draws is the
 * fault this file exists to remove. What one item *costs* is measured off the
 * drawn item rather than declared, because the cost is a fact about markup that
 * changes whenever a row does — the correction `agendaEventsAt` already had to
 * make when a progress bar and a current-time rule each moved it.
 *
 * **Pure, and no DOM.** The caller measures the box and the type and hands both
 * over as numbers — `widget-options.ts`, `ink.ts`, `ladder.ts`, `placement.ts`,
 * `omission.ts`, `inspector.ts` and `tiers.ts` are all here for that reason.
 *
 * **The panel keeps no twin of this table, deliberately.** `epaper/widgets.ts`
 * already predicts rather than measures — it owns its line heights, so
 * `dropToFit` is arithmetic there and always has been, which is precisely the
 * thing the wall did not have and this supplies. No e-paper pixel moves for
 * this change, so `EPAPER_RENDERER_VERSION` is untouched. `tiers.ts` has a twin
 * because the *calendar* draws on both media from one stored value; these six
 * do not share a decision with anything on a panel.
 */

/** The rungs, smallest first. Stable once shipped: read back off the DOM in tests. */
export const WIDGET_TIER_NAMES = ['T0', 'T1', 'T2', 'T3'] as const;
export type WidgetTierName = (typeof WIDGET_TIER_NAMES)[number];

export interface WidgetTier {
  readonly tier: WidgetTierName;
  /** The inner width this tier needs, in `ch` of the widget's primary role. */
  readonly minCh: number;
  /** The inner height this tier needs, in `em` of that role. */
  readonly minEm: number;
  /** How many things this tier draws — a floor, not a cap. See `itemsAt`. */
  readonly items: number;
  /**
   * How much each of them says: the ladder's length at this tier, from the top.
   *
   * `0` for a widget with no ladder (a note is lines of one thing), and the
   * caller reads it as "not my question". `1` is the line form — see
   * `laddersToOneLine`.
   */
  readonly rungs: number;
}

/**
 * A whisker, so a box exactly at a threshold reads as reaching it.
 *
 * `TIER_EPSILON` in `tiers.ts` carries the argument: both terms are a division
 * of two measured pixel counts and a browser reports those to sub-pixel
 * precision, so a box built to be exactly 9ch wide lands at 8.99999 about half
 * the time, and a tier that flickers between two draws of the identical wall is
 * the font race in a different costume.
 */
export const WIDGET_TIER_EPSILON = 0.001;

/**
 * The forecast: a strip of days, whose ladder applies inside each column.
 *
 * **Primary role: the temperature** (`.wx-temp`), because that is what a
 * forecast is for, and because measuring this widget with its *tallest* run of
 * text is a mistake this project has already made and written down — the day
 * names stay tall while the numbers beside them collapse, so only the shortest
 * run can see it (`epaper-proportional`, CLAUDE.md).
 *
 *     tier        needs           columns  rungs  what one column says
 *     T0 Number   4ch x 1.7em     1+       1      the day's name alone
 *     T1 Pair     6ch x 3.6em     1+       2      name and glyph
 *     T2 Strip    9ch x 4.7em     1+       3      name, glyph, high
 *     T3 Full    11ch x 4.7em     1+       4      the whole ladder
 *
 * The `em` figures are measured off the drawn strip rather than derived: on the
 * 1080x1920 Classic seed the temperature role is 32.6px and a column's rows are
 * 28, 60 and 38px — 0.86em for the name, 1.84em for the glyph (its own
 * `line-height: 1.5`, which is a glyph's breathing room rather than a type
 * size) and 1.16em for the temperatures — with the strip's own step-3 padding
 * at 0.85em on top.
 *
 * **T2 and T3 differ in width and not in height, which looks like a mistake and
 * is the table being honest.** The high and the low share a line while they are
 * adjacent (`pairsTemperatures`), so giving up the low buys no height at all —
 * it buys *room across the column*, which is the only thing that was ever short
 * when "24° 13°C" does not fit where "24°" does. A height threshold there would
 * be a rung the table pretends to charge for and does not.
 *
 * **Width buys days rather than a tier**, which is the shape a strip has and a
 * card has not. `WEATHER_COLUMN_CH` is one constant instead of a `minCh` per
 * rung, because how much a column *says* is a fact about its height and how
 * many of them there are is a fact about the strip's width; conflating them
 * would make a wide short box draw one enormous day.
 */
export const WEATHER_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 4, minEm: 1.7, items: 1, rungs: 1 },
  { tier: 'T1', minCh: 6, minEm: 3.6, items: 1, rungs: 2 },
  { tier: 'T2', minCh: 9, minEm: 4.7, items: 1, rungs: 3 },
  { tier: 'T3', minCh: 11, minEm: 4.7, items: 1, rungs: 4 },
];

/**
 * The width one day of the forecast needs, in `ch` of the temperature role.
 *
 * Nine, because the string a column has to hold is a *range* — "24° 13°C" is
 * nine characters, and it is the widest thing in the column whatever the day
 * is called (a weekday name is abbreviated by the model, a temperature is not).
 * A strip narrower than nine characters a column has stopped being a forecast
 * and become a row of ditto marks, which is `MIN_WEEK_COLUMN_REM`'s middle row
 * one widget along: tidy, and carrying nothing.
 *
 * Nine here against T3's eleven is not a disagreement: this is the width below
 * which a column is not worth *drawing*, and that is the width at which a
 * column can hold **both** temperatures. Between them a strip packs more days
 * and each of them says the high alone, which is the trade a household makes by
 * asking for more days than their box is wide.
 */
export const WEATHER_COLUMN_CH = 9;

/**
 * The rota badge: one card of rows, per person on a rota today.
 *
 * **Primary role: the shift's own name** (`.shift-badge .what`) — the headline,
 * and the thing `display.css` calls the single most important element on the
 * wall.
 *
 *     tier        needs           badges  rungs  what one badge says
 *     T0 Line     7ch x 1.8em     1+      1      one line: the household's own order, in a row
 *     T1 Card     9ch x 2.6em     1+      2      the person, then the shift
 *     T2 Hours    9ch x 3.3em     1+      3      and the hours
 *     T3 Full    11ch x 4.0em     1+      4      and where in the run they are
 *
 * Summed from `display.css` in `em` of the 3.6rem headline: the badge's own
 * padding is 0.64em, the person's row 0.70em (it carries a 2.4rem avatar, which
 * is 0.67em on its own and is what makes that row taller than its type), the
 * headline 1.13em with its margin, the hours 0.65em and the run 0.67em.
 *
 * **T0 is the line form and it is not a smaller card.** `shiftLineBadge` draws
 * the same parts in the household's own order on one line — the ladder's rule,
 * kept word for word: a box with room for one row spending it on "Amy" when
 * "Amy: Days · 07:00–19:00" fits is the same room spent on strictly less.
 */
export const SHIFT_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 7, minEm: 1.7, items: 1, rungs: 1 },
  { tier: 'T1', minCh: 9, minEm: 2.0, items: 1, rungs: 2 },
  { tier: 'T2', minCh: 9, minEm: 2.5, items: 1, rungs: 3 },
  { tier: 'T3', minCh: 11, minEm: 3.0, items: 1, rungs: 4 },
];

/**
 * The house: readings from Home Assistant, drawn typographically.
 *
 * **Primary role: the reading's value** (`.hs-value`) — "19.4 °C", "Open". The
 * label beside it is a kicker and the icon is a glyph; the value is the reading.
 *
 *     tier        needs           readings  rungs  what one reading says
 *     T0 Value    5ch x 1.2em     1+        1      the value alone
 *     T1 Named    9ch x 1.3em     1+        2      label and value
 *     T2 Marked  13ch x 1.4em     1+        3      the whole ladder
 *     T3 Marked  18ch x 1.4em     2+        3      the same, in a box with room for more of them
 *
 * The rungs cost almost nothing in height here and that is the widget's shape
 * rather than a slack table: a reading is one *baseline-aligned row* — the icon,
 * the label and the value sit beside each other, not stacked — so what a rung
 * costs is **width**, which is why the thresholds climb in `ch` and barely move
 * in `em`. Height buys more readings, and `.house` wraps them.
 *
 * A stored per-widget `fields` list still overrides the ladder outright, and a
 * per-entity `display_mode` still resolves it when there is none
 * (`houseLadder`). The tier can only ever take rungs *off* what those resolved
 * to, never add one — a household who asked for the value alone does not get a
 * label back because their box got bigger.
 *
 * **This is the one table whose rungs are given up by role rather than by
 * position, and the reason is why the house was never in the wall's drop loop
 * in the first place.** Everywhere else the ladder's order is both the drawing
 * order and the sacrifice order, and `dropToFit` takes the last entry — which
 * is right for a stack of rows and right on the panel, so the two renderers
 * agree. A house reading is not a stack: it is one baseline-aligned row read
 * left to right, `icon label value`, and `HOUSE_MODE_LADDERS` puts the value
 * **last** in every one of its four shapes. Taking the last entry there takes
 * the reading away and leaves its label, which is a widget that says "Front
 * door" and not what the front door is doing. So `rungsByPriority` is what this
 * table is read through, with the value kept first, then the label, then the
 * icon. Nothing on a panel drops a house rung at all, so there is no second
 * reader for this to disagree with.
 */
export const HOUSE_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 5, minEm: 1.2, items: 1, rungs: 1 },
  { tier: 'T1', minCh: 9, minEm: 1.2, items: 1, rungs: 2 },
  { tier: 'T2', minCh: 13, minEm: 1.2, items: 1, rungs: 3 },
  { tier: 'T3', minCh: 18, minEm: 2.4, items: 2, rungs: 3 },
];

/**
 * A note the household typed: lines of one thing, and no ladder at all.
 *
 * **Primary role: the line** (`.nt-line`). `rungs` is `0` throughout, which the
 * caller reads as "not my question" rather than as "draw nothing".
 *
 *     tier        needs           lines
 *     T0 Line     6ch x 1.4em     1
 *     T1 Few      9ch x 3.0em     2
 *     T2 Note    14ch x 5.6em     4
 *     T3 Page    20ch x 9.6em     7
 *
 * A line is 1.35em (its own `line-height`), so each rung is that many lines and
 * the height buys more from there. **Never zero**: a note whose box is too small
 * for one line still draws its first line and clips it, which is the ladder's
 * head-always-survives rule and rule nine — a household who dragged a box too
 * small should see the thing at the top of it rather than an empty rectangle.
 */
export const NOTES_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 6, minEm: 1.4, items: 1, rungs: 0 },
  { tier: 'T1', minCh: 9, minEm: 2.8, items: 2, rungs: 0 },
  { tier: 'T2', minCh: 14, minEm: 5.5, items: 4, rungs: 0 },
  { tier: 'T3', minCh: 20, minEm: 9.6, items: 7, rungs: 0 },
];

/**
 * The checklist: a static list the household typed, one box per row.
 *
 * **Primary role: the item's text** (`.td-text`). The same shape as a note with
 * a wider floor, because every row carries a 1.5rem box and a 1rem gap before
 * its words start — so the same string needs more `ch` here than it does there.
 *
 *     tier        needs           items
 *     T0 One      8ch x 1.4em     1
 *     T1 Few     11ch x 3.4em     2
 *     T2 List    16ch x 6.6em     4
 *     T3 Board   22ch x 11.6em    7
 */
export const TODO_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 8, minEm: 1.4, items: 1, rungs: 0 },
  { tier: 'T1', minCh: 11, minEm: 2.9, items: 2, rungs: 0 },
  { tier: 'T2', minCh: 16, minEm: 5.9, items: 4, rungs: 0 },
  { tier: 'T3', minCh: 22, minEm: 10.5, items: 7, rungs: 0 },
];

/**
 * The chore board: rows on the two list views, whole days on the week board.
 *
 * **Primary role: the chore's name** (`.ch-name`).
 *
 *     tier        needs           rows / days
 *     T0 One      8ch x 1.4em     1
 *     T1 Few     11ch x 3.2em     2
 *     T2 List    15ch x 6.2em     4
 *     T3 Board   21ch x 10.8em    7
 *
 * **The week board's unit is a whole day, and that is this table's own second
 * reading rather than a second table.** `density.ts` already recorded what
 * happens without one: a week of four daily chores is 28 rows, `fitToBox` shrank
 * the names to 8.1px on a 1280px wall — "not small, gone" — and once a floor
 * stopped that, the box clipped *through* a row, which reads as a broken
 * renderer rather than as a list that ran out of room. The board's answer was to
 * trim to whole days and fit again; under a tier it draws whole days in the
 * first place. What keeps the clip between rows on every view is not this table
 * at all but the renderer's one geometric belt, which is a fact about the box
 * and not about the words.
 */
export const CHORE_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 8, minEm: 1.3, items: 1, rungs: 0 },
  { tier: 'T1', minCh: 11, minEm: 2.8, items: 2, rungs: 0 },
  { tier: 'T2', minCh: 15, minEm: 5.8, items: 4, rungs: 0 },
  { tier: 'T3', minCh: 21, minEm: 9.7, items: 7, rungs: 0 },
];

/** Every table, by the widget type that reads it — one lookup, two callers. */
export const WIDGET_TIERS: Readonly<Record<string, readonly WidgetTier[]>> = {
  weather: WEATHER_TIERS,
  shift: SHIFT_TIERS,
  homeassistant: HOUSE_TIERS,
  notes: NOTES_TIERS,
  todo: TODO_TIERS,
  chores: CHORE_TIERS,
};

/**
 * What this box affords, from its inner size and the primary role's metrics.
 *
 * `innerW`/`innerH` are the content box, padding already taken off, because
 * padding is not room a word can be drawn in. `chPx` is the mean advance of the
 * role's own face (`TYPE_SPECIMEN` in `tiers.ts`, never the CSS `ch` unit,
 * which is the advance of a figure and 21% too wide) and `emPx` is its size.
 *
 * Walks up rather than down, so the answer is the highest rung both dimensions
 * reach and a box that is wide and short is held to its height.
 */
export function widgetTierFor(
  table: readonly WidgetTier[],
  innerW: number,
  innerH: number,
  chPx: number,
  emPx: number,
): WidgetTier {
  const floor = table[0] as WidgetTier;
  if (!(chPx > 0) || !(emPx > 0) || !(innerW > 0) || !(innerH > 0)) return floor;
  const widthCh = innerW / chPx;
  const heightEm = innerH / emPx;
  let found = floor;
  for (const tier of table) {
    if (widthCh + WIDGET_TIER_EPSILON >= tier.minCh && heightEm + WIDGET_TIER_EPSILON >= tier.minEm) {
      found = tier;
    }
  }
  return found;
}

/**
 * How many things this tier draws in a box that holds `capacity` of them.
 *
 * The tier's number is the **floor** and the measured capacity is what a box
 * with more room buys, which is the rule `namesAt` states and the sentence this
 * whole file exists to make true. Never fewer than one, whatever the arithmetic
 * says: a widget that resolves to nothing is the one outcome rule nine forbids.
 *
 * `capacity` is measured off the drawn item rather than divided out of a
 * declared row height — see the file docstring. A caller that cannot measure
 * one yet (an empty widget, a detached node) passes `Infinity` and gets the
 * tier's own number, which is the honest answer for a box nothing has been
 * drawn in.
 */
export function itemsAt(tier: WidgetTier, capacity: number): number {
  if (!Number.isFinite(capacity)) return Math.max(1, tier.items);
  return Math.max(1, tier.items, Math.floor(capacity));
}

/**
 * How many columns a strip of days draws across a box this wide.
 *
 * The one axis in this file where width is the question rather than the tier:
 * `columnCh` is the width one column needs, so a wider strip is more days and
 * never a wider day. Never fewer than one.
 */
export function columnsAt(innerW: number, chPx: number, columnCh: number): number {
  if (!(innerW > 0) || !(chPx > 0) || !(columnCh > 0)) return 1;
  return Math.max(1, Math.floor(innerW / (columnCh * chPx) + WIDGET_TIER_EPSILON));
}

/**
 * The ladder, cut to what this tier has room for.
 *
 * Never empty and never longer than the household asked for: the tier can take
 * rungs off a resolved ladder and can never add one, because the ladder is the
 * household's own list and the box is not entitled to a say in what is on it.
 */
export function rungsAt<F extends string>(
  tier: WidgetTier,
  ladder: readonly F[],
): readonly F[] {
  if (tier.rungs <= 0 || ladder.length === 0) return ladder;
  return ladder.slice(0, Math.max(1, Math.min(ladder.length, tier.rungs)));
}

/**
 * The ladder cut to this tier by **priority**, in the ladder's own draw order.
 *
 * The exception `HOUSE_TIERS` argues for, spelled as a general function so the
 * exception is visible at the call site rather than buried in a renderer.
 * `priority` is the order fields are *kept* in; the answer comes back in the
 * order they are *drawn* in, because a household who put the label before the
 * value did not ask for them to swap when the box got narrow.
 *
 * A field the priority list has never heard of sorts last, so an unknown name
 * from a newer server is given up first rather than kept ahead of a value.
 */
export function rungsByPriority<F extends string>(
  tier: WidgetTier,
  ladder: readonly F[],
  priority: readonly F[],
): readonly F[] {
  if (tier.rungs <= 0 || ladder.length === 0) return ladder;
  const keep = Math.max(1, Math.min(ladder.length, tier.rungs));
  if (keep >= ladder.length) return ladder;
  const rank = (field: F): number => {
    const at = priority.indexOf(field);
    return at < 0 ? priority.length : at;
  };
  const kept = ladder.slice().sort((a, b) => rank(a) - rank(b)).slice(0, keep);
  return ladder.filter((field) => kept.includes(field));
}

/**
 * Whether a badge drawn at this tier says its ladder on one line.
 *
 * The ladder's own rule, and it survives the tier unchanged: at one rung out of
 * more than one, the wall draws a **line** rather than a word. Stated as a
 * predicate rather than left inside the renderer so the two renderers of a
 * shift badge cannot come to disagree about it again.
 */
export function laddersToOneLine(tier: WidgetTier, full: number): boolean {
  return tier.rungs === 1 && full > 1;
}
