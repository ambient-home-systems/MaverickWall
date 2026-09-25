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
 * The `colour` forecast (plan item P5.1): the strip, with each sky painted in
 * its condition colours and each temperature tinted on the temperature scale.
 *
 * **It gives up exactly what the strip gives up, in the strip's order** — the
 * ladder from the bottom: the low, then the high, then the glyph, and the day's
 * name last. The plan names this style "today's strip" and states no order of
 * its own, and a household who picked the colours did not ask for the rows to
 * go in a different order from the forecast they had.
 *
 * **Its own table because its glyph is a different size at every rung.** A
 * two-tone sky is two objects in one mark — a sun behind a cloud, a bolt under
 * one — and at the strip's size the smaller of the two is a speck of a second
 * colour. So the glyph is stated in the temperature's own `em` (1.1, 1.4 and
 * 1.8 at T1, T2 and T3, `display.css`), and each rung's height is the sum of
 * what that rung draws, measured off a drawn colour strip at 1080x1920:
 *
 *     tier        needs           columns  rungs  what one column says
 *     T0 Number   4ch x 1.7em     1+       1      the day's name alone
 *     T1 Pair     6ch x 2.9em     1+       2      name and glyph
 *     T2 Strip    9ch x 4.3em     1+       3      name, glyph, high
 *     T3 Full    11ch x 4.7em     1+       4      the whole ladder, glyph at its largest
 *
 * The strip's own padding is 0.85em, a name's row 0.86em and the temperature's
 * row 1.16em; a glyph's row is the glyph, nothing more. So T1 is
 * 0.85 + 0.86 + 1.1, T2 0.85 + 0.86 + 1.4 + 1.16 and T3 the same with a 1.8em
 * glyph — **T3 needs more height than T2 here where the strip's does not**,
 * because this glyph grows with the rung and the strip's T3 budget was set
 * before it did. `browser-weather-colour` holds the table to the drawing by
 * asserting the belt never has anything to do: a threshold set too low would
 * have to hide a row to fit, and that is what it counts.
 */
export const COLOUR_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 4, minEm: 1.7, items: 1, rungs: 1 },
  { tier: 'T1', minCh: 6, minEm: 2.9, items: 1, rungs: 2 },
  { tier: 'T2', minCh: 9, minEm: 4.3, items: 1, rungs: 3 },
  { tier: 'T3', minCh: 11, minEm: 4.7, items: 1, rungs: 4 },
];

/**
 * The columns of one `range` row, in the order they are **kept** — the bar
 * first, because a range style that has given up its bar is the strip on its
 * side. The row is drawn in reading order (name, glyph, rain, low, bar, high);
 * this is only which of them a narrow box still has room for.
 */
export const RANGE_COLUMNS = ['bar', 'low', 'high', 'glyph', 'rain'] as const;
export type RangeColumn = (typeof RANGE_COLUMNS)[number];

/**
 * The `range` forecast (plan item P5.1, "iOS 10-day"): one row per day — its
 * name, its glyph, its rain chance, its low, a bar from the low to the high on
 * the week's own scale, and its high.
 *
 * **Primary role: the temperature** (`.wr-temp`), for the strip's reason: the
 * numbers are what a forecast is for, and the shortest run is the one that can
 * see a collapse.
 *
 *     tier        needs (beside the name)   days  rungs  what one row says
 *     T0 Bar      14ch x 1.6em              1+    3      low, bar, high
 *     T1 Marked   18ch x 1.6em              1+    4      and the glyph
 *     T2 Full     23ch x 1.6em              1+    5      and the rain chance
 *     T3 Week     28ch x 5.4em              3+    5      the same, in a box with room for the week
 *
 * **The order is the plan's, read per axis: the foot gives up days, the side
 * gives up the rain chance and then the glyph.** A row is a day, so a box
 * that loses height loses days from the bottom — `items` is a floor and the
 * measured capacity is what a taller box buys, the rule every table here
 * states. What loses *width* first is the rain chance, which is a detail of a
 * day, then the glyph, which the bar and its two numbers say better; the bar
 * and its numbers are never given up, because they are the style.
 *
 * **The widths are stated beside the day's name rather than including it.**
 * The name is the provider's own word — "Today", "Wed", "Wednesday", "This
 * Afternoon" — and it is never cut, so the renderer measures the widest name it
 * is drawing and asks this table about the room left over. A table that
 * budgeted for "Wed" would clip "Wednesday"; one that budgeted for "This
 * Afternoon" would give up the glyph on every Open-Meteo wall.
 *
 * Summed in `ch` of the temperature role, whose figures are 1.21ch wide
 * (`tiers.ts` has the measurement): a temperature is four figures at most
 * ("-12°"), 4.8ch; the bar's floor 4ch; a gap 1.2ch; the glyph 1.3em, 3.1ch;
 * the rain chance "100%" in the scaffold role, 3.8ch. T3 is T2 with room for
 * three rows, which is the House table's shape: at the top of the ladder there
 * is nothing left to add to a row, so height is the only thing left to buy.
 */
export const RANGE_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 14, minEm: 1.6, items: 1, rungs: 3 },
  { tier: 'T1', minCh: 18, minEm: 1.6, items: 1, rungs: 4 },
  { tier: 'T2', minCh: 23, minEm: 1.6, items: 1, rungs: 5 },
  { tier: 'T3', minCh: 28, minEm: 5.4, items: 3, rungs: 5 },
];

/** The columns a `range` row keeps at this tier. Never fewer than the bar and its two numbers. */
export function rangeColumnsAt(tier: WidgetTier): readonly RangeColumn[] {
  return RANGE_COLUMNS.slice(0, Math.max(3, Math.min(RANGE_COLUMNS.length, tier.rungs)));
}

/**
 * What a Today card says, in the order it is **kept** (plan item P5.1). The
 * lede — the one large reading, with today's high and low on the line under
 * it — is never given up; the plan's order is the rest of the list read from
 * the bottom: the next hours first, then the feels-like, then the condition
 * words.
 *
 * The high and the low ride with the lede rather than taking a rung of their
 * own, because in the card's other mode (no current reading) they *are* the
 * lede, and a card that had room for one number and not its range would be
 * the one form in which the two modes said different kinds of thing.
 */
export const TODAY_RUNGS = ['lede', 'condition', 'feels', 'next'] as const;
export type TodayRung = (typeof TODAY_RUNGS)[number];

/**
 * The smallest the lede is drawn while the card still keeps a rung under it,
 * in `em` of the card's primary role.
 *
 * The lede is the reading the card exists for, and its size is whatever the
 * box has left once the rungs the tier kept are drawn — up to the clock's cap
 * (decision D1: 1.8x the event role, `--t-wall-clock`), which it reaches in
 * any box with room. This is the other end: below it, a rung goes before the
 * lede shrinks further. 1.6em is the height the heaviest condition words set
 * at the event role would look *equal* to beside a lede drawn in the light
 * weight the card uses — at which point the lede is no longer a lede.
 */
export const TODAY_LEDE_FLOOR_EM = 1.6;

/**
 * The `today` forecast (plan item P5.1, "iOS widget"): a card on its sky with a
 * large reading, the words for the sky, how it feels, and the next hours — or,
 * in a box with room for one line of them, the next days as that line.
 *
 * **Primary role: the condition words** (`.wt-cond`), the event role. The lede
 * is not a role — it is the room left over, capped (`TODAY_LEDE_FLOOR_EM`) —
 * so the table is stated in the one run whose size does not depend on the box.
 *
 *     tier        needs           rungs  what the card says
 *     T0 Lede     8ch x 0em       1      the reading, its high and low
 *     T1 Said    10ch x 5.0em     2      and the condition words
 *     T2 Felt    10ch x 6.0em     3      and how it feels
 *     T3 Next    12ch x 7.5em     4      and the next hours, or the next days on one line
 *
 * Summed at the lede's floor from each rung measured off a drawn card, in `em`
 * of the event role, at 1080x1920 and 1920x1080 on a wall nobody measured and
 * on a 32" television (the four agree to a hundredth): the card's padding
 * 1.0em (step 3 each side), the lede 1.6em, and the range line under it 1.05em
 * (the time role at 1.15 leading, and a step-1 gap) — T0 needs none of it,
 * because rule nine draws the lede in any box. The condition words cost 1.3em,
 * the feels-like 1.05em, and the one line of days 1.5em with its step-3 space
 * above it. The hours are **three** lines — a time, a glyph and a temperature,
 * 3.8em — and whether a card reaching T3 draws them or the one line of days is
 * measured rather than tabled: the box's room once the lede has its floor,
 * against the hours row drawn. That is the plan's "or, in a short box, the next
 * days as one line", and it is a question about height alone.
 *
 * The widths are the lede's floor across "-12°" and its glyph (T0), then the
 * shortest condition a provider sends ("Clear", "Fog") with room to be read
 * (T1-T2), then two days of the next line (T3). A condition longer than the
 * card is wide wraps at a word rather than being cut, and the lede gives up
 * the height it costs.
 */
export const TODAY_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 8, minEm: 0, items: 1, rungs: 1 },
  { tier: 'T1', minCh: 10, minEm: 5.0, items: 1, rungs: 2 },
  { tier: 'T2', minCh: 10, minEm: 6.0, items: 1, rungs: 3 },
  { tier: 'T3', minCh: 12, minEm: 7.5, items: 1, rungs: 4 },
];

/** The rungs a Today card keeps at this tier. Never fewer than the lede. */
export function todayRungsAt(tier: WidgetTier): readonly TodayRung[] {
  return TODAY_RUNGS.slice(0, Math.max(1, Math.min(TODAY_RUNGS.length, tier.rungs)));
}

/**
 * The `playful` forecast (plan item P5.1): the strip's days, each with its name
 * large, a bundled picture for its weather that bobs, and its numbers — and an
 * advice line under them in plain words.
 *
 * **It gives up what the strip gives up, in the strip's order**, for
 * `COLOUR_TIERS`' reason: the ladder is the household's own list, and a look
 * that reordered what it sacrifices would be a second ladder nobody can see.
 * The advice line is not a rung. It is the first thing given up, before any of
 * them: it is kept only where the whole ladder is drawn and the box has the
 * room under it, measured off the drawn line — a card that had to choose
 * between "Umbrella day" and the day's high keeps the high, which is the fact
 * the advice was drawn from.
 *
 * **Primary role: the temperature** (`.wp-temp`), the strip's argument. The day
 * name is the event role here too — "big day names" is the look — so the
 * column is wider than the strip's for the same word count, which is
 * `PLAYFUL_COLUMN_CH`.
 *
 *     tier        needs           columns  rungs  what one column says
 *     T0 Name     5ch x 2.2em     1+       1      the day's name alone
 *     T1 Picture  7ch x 4.8em     1+       2      name and picture
 *     T2 High     9ch x 6.0em     1+       3      name, picture, high
 *     T3 Full    11ch x 6.0em     1+       4      the whole ladder
 *
 * Summed from each row measured off a drawn playful strip, in `em` of the
 * temperature, at 1080x1920 and 1920x1080 on a wall nobody measured and on a
 * 32" television: the strip's padding 1.0em, a name's row 1.16em (the event
 * role at 1.15 leading), the picture 2.63em (2.2em of it and a step-1 and a
 * step-2 margin), and the temperatures' row 1.16em. The advice line, when it
 * is kept, is another 1.9em under them. A first draft of this table guessed
 * 4.6 and 5.8 and was short by a fifth of an em at both, which the belt would
 * have paid for by hiding a row. T2 and T3 differ in width and not height, the
 * strip's reason: the high and the low share a line while they are adjacent.
 */
export const PLAYFUL_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 5, minEm: 2.2, items: 1, rungs: 1 },
  { tier: 'T1', minCh: 7, minEm: 4.8, items: 1, rungs: 2 },
  { tier: 'T2', minCh: 9, minEm: 6.0, items: 1, rungs: 3 },
  { tier: 'T3', minCh: 11, minEm: 6.0, items: 1, rungs: 4 },
];

/**
 * The width one playful column needs, in `ch` of the temperature role — the
 * strip's `WEATHER_COLUMN_CH` for a column whose name is set at the event role
 * rather than the scaffold's, so "Today" in the heavy weight is the widest thing
 * in it rather than the temperatures.
 */
export const PLAYFUL_COLUMN_CH = 11;

/**
 * The forecast's table for each of its designed looks that the wall draws.
 */
export const WEATHER_STYLE_TIERS: Readonly<Record<string, readonly WidgetTier[]>> = {
  strip: WEATHER_TIERS,
  colour: COLOUR_TIERS,
  range: RANGE_TIERS,
  today: TODAY_TIERS,
  playful: PLAYFUL_TIERS,
};

/**
 * The parts of a countdown's `page` look (plan item P5.2), in the order they
 * are **kept**: the count, its unit, the household's label, and the target's
 * own date. The binder strip is not a part — it is what makes the sheet a
 * page, and it is thin enough never to be the thing a box cannot hold.
 */
export const PAGE_PARTS = ['num', 'unit', 'label', 'date'] as const;
export type PagePart = (typeof PAGE_PARTS)[number];

/**
 * The tear-off page: the count on a drawn sheet.
 *
 * **Primary role: the lede** (`.cdp-label`, the household's own label). The
 * count is drawn at the clock's role — 1.8 ledes, the most any one reading on
 * the wall may outsize an event name (D1, `WALL_TYPE_CAPS`) — and capped by
 * the box as the clock is, so the table can be stated in one unit: every other
 * run on the page is a fraction of the lede.
 *
 *     tier        needs           rungs  what the page says
 *     T0 Count    6ch x 3.8em     2      the count and its unit
 *     T1 Label   12ch x 5.3em     3      and the label under the sheet
 *     T2 Dated   15ch x 6.5em     4      and the target's date on the sheet
 *
 * The date goes first because it is the fact the household already knows —
 * they chose it — where the label is the thing the count is *for*; the unit
 * stays to the end because "12" on a calendar page with no unit reads as the
 * twelfth.
 *
 * **Measured off the drawn page rather than summed**, on the shipped Classic
 * wall with the forecast's box made a page: the sheet with its count and unit
 * is 3.80em tall on a wall nobody has measured, 4.96em with the date, and the
 * label is 1.15em under it a step-2 gap below — 5.19em and 6.36em, taken up to
 * 5.3 and 6.5. A measured wall needs less (its scaffold is half a lede where
 * the fallback is two thirds: 5.64em for the whole page on a 32" television),
 * and one table in ledes cannot be exact for both, so it is the unmeasured
 * wall's, the larger: a measured wall reaches each rung a little later than it
 * could, and no wall reaches one it cannot hold. The widths are the sheet's
 * own 4.5-lede minimum (12.4ch) and the date with the sheet's padding (15ch).
 * `browser-countdown-page` holds the table to the drawing by asserting the
 * belt never has anything to do.
 */
export const PAGE_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 6, minEm: 3.8, items: 1, rungs: 2 },
  { tier: 'T1', minCh: 12, minEm: 5.3, items: 1, rungs: 3 },
  { tier: 'T2', minCh: 15, minEm: 6.5, items: 1, rungs: 4 },
];

/**
 * The parts of a countdown's `ticket` look, in the order they are **kept**:
 * the destination (the household's label), the line "Departs in 12 days", the
 * departure board under its perforated rule, and the pass's own head.
 */
export const TICKET_PARTS = ['dest', 'when', 'board', 'head'] as const;
export type TicketPart = (typeof TICKET_PARTS)[number];

/**
 * The boarding pass.
 *
 * **Primary role: the lede** (`.cdt-dest`, the destination), the page's reason
 * one look along. The board's flaps are the clock's role, capped by the box.
 *
 *     tier        needs           rungs  what the pass says
 *     T0 Line     9ch x 3.2em     2      the destination and "Departs in 12 days"
 *     T1 Board   12ch x 6.0em     3      and the board, under its perforation
 *     T2 Pass    20ch x 6.9em     4      and the pass's head
 *
 * **The board goes before the line, and that is the one surprise in it.** The
 * board is the look — but it says the number the line already says in words,
 * at nearly twice the height, so a box with room for one of them keeps the one
 * that also says what the number counts. The head is the last thing added
 * because it is the only part that says nothing about this countdown.
 *
 * Measured the page's way: the pass is 3.13em with its line, 5.85em with the
 * board and 6.71em with the head, on a wall nobody has measured. The head's
 * width is what sets T2's: "BOARDING PASS" is thirteen tracked capitals that
 * do not wrap, about 16ch, plus the pass's padding.
 */
export const TICKET_TIERS: readonly WidgetTier[] = [
  { tier: 'T0', minCh: 9, minEm: 3.2, items: 1, rungs: 2 },
  { tier: 'T1', minCh: 12, minEm: 6.0, items: 1, rungs: 3 },
  { tier: 'T2', minCh: 20, minEm: 6.9, items: 1, rungs: 4 },
];

/**
 * A countdown's table for each of its looks the wall draws with one. `number`
 * is deliberately not here: it keeps the clock's `--buw`/`--buh` sizing, so an
 * existing countdown is drawn exactly as it was (plan item P5.2).
 */
export const COUNTDOWN_TIERS: Readonly<Record<string, readonly WidgetTier[]>> = {
  page: PAGE_TIERS,
  ticket: TICKET_TIERS,
};

/** The parts a look keeps at this tier: its first `rungs`, never fewer than one. */
export function partsAt<P extends string>(parts: readonly P[], tier: WidgetTier): readonly P[] {
  return parts.slice(0, Math.max(1, Math.min(parts.length, tier.rungs)));
}

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

/**
 * The height one badge of a stack of `count` has: the box's inner height, less
 * the gaps between the badges, shared equally.
 *
 * **A rota tier is a question about one badge, never about the box.** The wall
 * used to hand `widgetTierFor` the whole box whoever was on the rota, so two
 * people in a box one badge tall were each promised a card that box could only
 * hold once — and the belt, which keeps the first item and hides whatever ends
 * past the foot, took the second person off the glass. That is the Classic
 * wall with two shift workers on it, on every day both are working. With one
 * person there are no gaps and this is the inner height exactly, so a
 * one-person wall is asked the question it was always asked.
 */
export function stackedItemHeight(innerH: number, count: number, gap: number): number {
  if (!(count > 1)) return innerH;
  const between = gap > 0 ? gap : 0;
  return Math.max(0, (innerH - between * (count - 1)) / count);
}

/**
 * Whether a rota drawn at this tier says each person on one line.
 *
 * One person is `laddersToOneLine`, unchanged. **Several people are a line each
 * whenever a card does not fit per person** — the tier chosen for one badge is
 * the floor — which is the panel's rule: `epaper/widgets.ts` has always drawn
 * more than one person as a compact line each. A one-rung ladder is a line here
 * too, where for one person it is a card, because the line form for several is
 * a *list* drawn at the list's own size (`display.css`) and a one-rung card is
 * the headline at full size, which a box with room for one of them per person
 * does not have for two.
 */
export function shiftBadgesToLines(tier: WidgetTier, full: number, people: number): boolean {
  if (people > 1) return tier.rungs <= 1;
  return laddersToOneLine(tier, full);
}
