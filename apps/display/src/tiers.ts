/**
 * Density tiers: what a box *affords*, rather than what fits in it.
 *
 * Every legibility decision the calendar widget took before this one was a
 * measurement of its own content — draw everything, measure it, hide what
 * spilled. That answers "does this fit" and it can only ever subtract, so the
 * same widget drew the same six agenda events and the same handful of month
 * names on a 450x800 e-ink panel and on a 3.7-megapixel television. Measured on
 * the shipped Classic wall with three ordinary family calendars and nineteen
 * events in view: 6 events over 3 days at all five sizes this project measures,
 * and 0, 0, 3, 7, 8 month names. There was no mechanism anywhere in either
 * renderer by which a widget with more room showed *more things*.
 *
 * A tier is the other question. The box's own geometry picks a **form** — how
 * many names, how many lines each may wrap to, whether a time is drawn beside
 * one, how much of a weekday head there is room for — and the renderer draws
 * that form. Nothing is drawn and then taken away, so a bigger box is a
 * different drawing rather than the same drawing less cut about.
 *
 * **The thresholds are in `ch` and `em` of the event role, which is what makes
 * one table right on every panel.** The event role is already distance
 * corrected (`WALL_TYPE_CAPS` in `orientation.ts`: 14 arc-minutes of cap height
 * at the reader's eye), so "12ch wide" means twelve characters of the size that
 * household can actually read from where they stand — not twelve characters of
 * a size measured on somebody else's television. That is the whole trick: this
 * table names no device and no pixel count, and it is correct from a 640x384
 * panel to a 1872x1404 one and on a wall nobody has measured at all, where the
 * event role falls back to the rem expression the stylesheet has always used.
 *
 * **`ch` here is the face's own mean advance and deliberately not the CSS `ch`
 * unit, which is the advance of a figure.** Measured on the bundled display
 * face at every size this project checks, a figure is 0.4937em and running text
 * is 0.4081em — a figure is 21% wider than the characters a title is actually
 * made of, and it is the same 21% at every size, so it is a property of the
 * face rather than of one screen. Read as figures, the shipped 1920x1080 wall's
 * month cell measures 7.48ch and is classified as a cell that can name nothing
 * — while it draws eight event names today, "Bin day" and "Dentist" whole on
 * one line. A threshold that calls that cell empty is measuring the wrong
 * glyph. `TYPE_SPECIMEN` below is the fixed string both renderers measure, so
 * the unit is a constant of the face and never of the household's titles.
 *
 * **Pure, and no DOM.** A decision taken inside a `createElement` call is a
 * decision nothing can check; `widget-options.ts`, `ink.ts`, `ladder.ts`,
 * `placement.ts`, `omission.ts` and `inspector.ts` all exist for that reason and
 * this follows them. The caller measures the box and the type and hands both
 * over as numbers.
 *
 * The eInk renderer keeps its own copy in `epaper/tiers.ts`, because the display
 * bundle has no dependencies and no bundler and so cannot share a module with
 * the server. `tier-parity.test.ts` reads both files and refuses to let them
 * drift — the same seam, and the same idiom, as `epaper-ladder-parity.test.ts`.
 */

/** The rungs, smallest first. Stable for ever once shipped: read by two renderers. */
export const TIER_NAMES = ['M0', 'M1', 'M2', 'M3', 'M4'] as const;
export type TierName = (typeof TIER_NAMES)[number];

/**
 * How an all-day event carries its calendar's colour at this tier.
 *
 * `bar` is the rule down the row's own left edge that the grid has always
 * drawn. `edge` is what M0 does *instead*: with no row to put a colour on, the
 * cell carries a rule at its own edge, so even a cell that can name nothing
 * still says **whose** day it is — which is most of what a family wall is for.
 */
export type AllDayMark = 'edge' | 'bar';

export interface CalendarTier {
  readonly tier: TierName;
  /** The inner width this tier needs, in `ch` of the event role. */
  readonly minCh: number;
  /** The inner height this tier needs, in `em` of the event role. */
  readonly minEm: number;
  /** How many names the box may draw. M4 grows with the box — see `namesAt`. */
  readonly names: number;
  /** The wrap allowance. A taller box may spend a surplus on one more line. */
  readonly lines: number;
  /** Whether an event's time is drawn beside its name. */
  readonly times: boolean;
  /** Letters of the weekday head. `0` means the whole word. */
  readonly weekdayLetters: number;
  readonly allDay: AllDayMark;
  /** Whether a multi-day event is drawn once, as a bar across its days. */
  readonly spans: boolean;
}

/**
 * The table.
 *
 *     tier        needs           names          times  weekday  all-day
 *     M0 Mark     — (the floor)   0              no     1        colour rule at the cell edge
 *     M1 One      9ch x 3.0em     1              no     1        bar, spans
 *     M2 Few      12ch x 5.0em    2-3            no     3        bar, spans
 *     M3 List     16ch x 7.5em    4-5            no     3        bar, spans, labelled
 *     M4 Column   22ch x 10em     6+, with times yes    full     bar, spans, labelled
 *
 * Both dimensions must be met: a tall narrow column is as much M1 as a short
 * wide one, because a name needs width to be a name and height to be a row.
 *
 * **`spans` is `true` at M0 and the table it is transcribed from says
 * otherwise. The deviation is deliberate and measured.** A span bar is a *grid*
 * object rather than a cell one — it is `n` cells wide — so on a 7.5" e-ink
 * panel at 800x480 a five-day half term is 26ch across and names itself at
 * 16.9px, while the cell under it is 4.7ch and can name nothing at all.
 * Following the table literally there takes the only name either e-ink panel
 * has ever had on its grid off the glass (`MEASURED_BASELINE.distinctNames` in
 * `wall-density.test.ts`, 1 at both sizes, which went 0 → 1 one phase ago).
 * Whether a bar carries its *words* is therefore asked of the bar's own width —
 * `spanIsLabelled` below, against this table's own M2 threshold — rather than
 * of the tier of the cell beneath it, which is the wrong box to ask.
 *
 * **`names` at M4 is a floor rather than a cap**, for the reason this file
 * exists: a 20em column that drew the same six rows as a 10em one would be the
 * fault being fixed, one tier along. `namesAt` is where that is worked out.
 */
export const CALENDAR_TIERS: readonly CalendarTier[] = [
  { tier: 'M0', minCh: 0, minEm: 0, names: 0, lines: 0, times: false, weekdayLetters: 1, allDay: 'edge', spans: true },
  { tier: 'M1', minCh: 9, minEm: 3, names: 1, lines: 1, times: false, weekdayLetters: 1, allDay: 'bar', spans: true },
  { tier: 'M2', minCh: 12, minEm: 5, names: 3, lines: 2, times: false, weekdayLetters: 3, allDay: 'bar', spans: true },
  { tier: 'M3', minCh: 16, minEm: 7.5, names: 5, lines: 2, times: false, weekdayLetters: 3, allDay: 'bar', spans: true },
  { tier: 'M4', minCh: 22, minEm: 10, names: 6, lines: 2, times: true, weekdayLetters: 0, allDay: 'bar', spans: true },
];

/**
 * The cell furniture a row has to sit under, in `em` of the event role.
 *
 * The date numeral is one line of the numeral role, which is 16 arc-minutes
 * against the event's 14 on a measured wall and `1.2x` the event text on one
 * that is not — so 1.2 is the larger of the two and the safe one to reserve.
 * A row is its own line-height (`.hz-rowtext` is 1.25) plus the flex gap
 * between rows, which is 0.26rem and lands near three tenths of an em at every
 * size this project measures. Summing row heights and forgetting the gap is
 * one of the three faults `trimCellRows` shipped; the gap is in the constant
 * here so nothing downstream has to remember it.
 */
export const NUMERAL_EM = 1.2;
export const LINE_EM = 1.25;
export const ROW_EM = 1.55;

/**
 * The most lines a name may wrap to, at any tier.
 *
 * Two, because a title is drawn whole or not at all and a third line in a month
 * cell is a paragraph. The rule is the grid's, not this table's — see
 * `--cell-lines` in `display.css`.
 */
export const MAX_LINES = 2;

/**
 * The most names a cell may draw, at any tier.
 *
 * Twelve, because that is where the model's own slim per-cell list stops
 * (`viewmodel.ts`). Drawing a thirteenth is not a thing a bigger box can buy.
 */
export const MAX_NAMES = 12;

/**
 * The string both renderers measure to find out what one `ch` is worth.
 *
 * A fixed specimen, so the unit is a property of the *face* and never of the
 * household's own titles: the same 43 characters on every wall, whatever is on
 * the calendar. The standard pangram, because its letter distribution is close
 * enough to running English that the number it gives (0.4072em on the bundled
 * face) lands within a quarter of a percent of a real event title measured the
 * same way (0.4081em), and 21% off the figure the CSS `ch` unit would give.
 *
 * The panel measures the same string through its own bitmap metrics, where the
 * answer is a property of the *face* its type tier chose rather than of a probe
 * — each face's own cell plus a pixel of tracking, over its own height: 1.125em
 * on the 8x8, 0.8125em on the 12x16, 0.7083em on the 16x24. That difference is
 * the point rather than a problem, and so is the spread inside it: a 44px cell
 * on a 7.5" panel, which draws the 8x8 face, really does hold four characters,
 * while a 13.3" panel reads a face 37% narrower for its height and is told so.
 * The table is stated in characters precisely so that it can say either.
 */
export const TYPE_SPECIMEN = 'The quick brown fox jumps over the lazy dog';

/**
 * The width a bar needs before its words are worth drawing, in `ch`.
 *
 * M2's own threshold, deliberately, rather than a number of its own: twelve
 * characters is this table's stated boundary between a box that can hold a name
 * and one that cannot, and a bar is a box.
 */
export const LABEL_MIN_CH = 12;

/**
 * A whisker, so a box that is exactly at a threshold reads as reaching it.
 *
 * Both terms are a division of two measured pixel counts, and a browser reports
 * those to sub-pixel precision — so a cell built to be exactly 9ch wide lands
 * at 8.99999 about half the time. A tier that flickers between two draws of the
 * identical wall is the font-race fault in a different costume.
 */
export const TIER_EPSILON = 0.001;

/** The tier by name, or M0 for anything this build does not know. */
export function tierNamed(name: string): CalendarTier {
  for (const tier of CALENDAR_TIERS) {
    if (tier.tier === name) return tier;
  }
  return CALENDAR_TIERS[0] as CalendarTier;
}

/**
 * What this box affords, from its inner size and the event role's own metrics.
 *
 * `innerW` and `innerH` are the *content* box — padding already taken off —
 * because padding is not room a name can be drawn in. `chPx` is the advance of
 * a figure at the event role's size and `emPx` is that size; both are measured
 * where they are known and neither is derived here, so a face with unusual
 * metrics is answered honestly rather than assumed.
 *
 * Walks up rather than down, so the answer is the *highest* tier both
 * dimensions reach and a box that is wide and short is held to its height.
 */
export function tierFor(innerW: number, innerH: number, chPx: number, emPx: number): CalendarTier {
  const floor = CALENDAR_TIERS[0] as CalendarTier;
  if (!(chPx > 0) || !(emPx > 0) || !(innerW > 0) || !(innerH > 0)) return floor;
  const widthCh = innerW / chPx;
  const heightEm = innerH / emPx;
  let found = floor;
  for (const tier of CALENDAR_TIERS) {
    if (widthCh + TIER_EPSILON >= tier.minCh && heightEm + TIER_EPSILON >= tier.minEm) found = tier;
  }
  return found;
}

/**
 * How many names this tier draws in a box of this height.
 *
 * The table's number is what the tier draws **at its own threshold**, and the
 * two dimensions do not arrive together. A box that clears one and not the
 * other is the ordinary case rather than the odd one, and the surplus has to
 * buy something or the table is a table about square cells. Measured: a 13.3"
 * e-ink panel's month cell is 9.7ch by 10.9em — M1 by width, tall enough for
 * six rows — and held to M1's literal one name it would draw one where it
 * draws seven today, each of them a whole word.
 *
 * So the height buys rows and the tier's own number is the floor. Every one of
 * the table's numbers is reproduced exactly at the box it is stated for — 1 at
 * 3.0em, 3 at 5.0em, 5 at 7.5em, 6 at 10em — which is the test that fails first
 * if this arithmetic is wrong, and above them the row count is what a box with
 * more room shows more of. That is the sentence this whole file exists to make
 * true, and it is why there is no ceiling here: an in-between box — 4.33em on
 * the shipped portrait wall, half again the rung it sits on and short of the
 * next — holds two rows, and a ceiling taken from the rung would draw one and
 * leave the room empty. Capped at the model's own per-cell list, since a
 * thirteenth name is not something a bigger box can buy.
 *
 * The row arithmetic is deliberately optimistic — one line each — because the
 * wrap allowance is a maximum rather than a promise (the shift ladder's rule,
 * one widget along) and a pessimistic count would halve a cell whose titles are
 * all short. What keeps a row from being *sliced* is the renderer's one
 * geometric belt, which is a fact about the box and not about the words.
 */
export function namesAt(tier: CalendarTier, innerH: number, emPx: number): number {
  if (tier.names <= 0) return 0;
  if (!(emPx > 0) || !(innerH > 0)) return tier.names;
  const rows = Math.floor((innerH / emPx - NUMERAL_EM) / ROW_EM);
  return Math.min(MAX_NAMES, Math.max(tier.names, rows));
}

/**
 * How many lines a name may wrap to, in a box of this height.
 *
 * The table states each tier at *its own threshold*, where the numbers were
 * chosen — and a box clears one dimension's threshold and not the other's far
 * more often than it lands on both. M1 is where that shows: a 9ch x 3.0em cell
 * genuinely holds one line, and the shipped Classic wall's portrait month cell
 * is 8.6ch and **5.1em**, where a second line fits under the numeral with room
 * over. Refusing it there would take "Grandma's 80th birthday" off a wall that
 * draws it today, to honour a threshold the box has cleared twice.
 *
 * So the surplus height buys the one thing in a cell that can absorb it. Pure
 * arithmetic on the box, never a measurement of the words — a title that needs
 * more lines than this allows is still hidden and counted, which is the grid's
 * own "whole or not at all" and is not this function's decision.
 */
export function linesAt(tier: CalendarTier, innerH: number, emPx: number): number {
  if (tier.lines <= 0) return 0;
  if (tier.lines >= MAX_LINES || !(emPx > 0)) return tier.lines;
  const spare = innerH / emPx - NUMERAL_EM - tier.names * ROW_EM;
  return spare + TIER_EPSILON >= LINE_EM ? Math.min(MAX_LINES, tier.lines + 1) : tier.lines;
}

/**
 * The same tier `rungs` steps along, clamped to the table.
 *
 * The one place the renderer is allowed an opinion about the household's
 * arrangement: a month grid that resolves to M0 names nothing, and those names
 * have to go somewhere, so every agenda on the same canvas is promoted. A
 * **drawing** decision and never a saved one — nothing here writes to a canvas,
 * so widening the month brings its own names back and takes the promotion away
 * on the next draw. The same rule the week-columns fallback and the ladder's
 * drop loop already follow.
 */
export function promoted(tier: CalendarTier, rungs: number): CalendarTier {
  let index = 0;
  for (let at = 0; at < CALENDAR_TIERS.length; at++) {
    if ((CALENDAR_TIERS[at] as CalendarTier).tier === tier.tier) index = at;
  }
  const moved = Math.min(CALENDAR_TIERS.length - 1, Math.max(0, index + rungs));
  return CALENDAR_TIERS[moved] as CalendarTier;
}

/**
 * How many events a list — an agenda, an upcoming column — draws in this box.
 *
 * The same rungs and the same "the tier's number is a floor, the height buys
 * more" arithmetic, with two differences from `namesAt` and both of them are
 * about the difference between a square and a column.
 *
 * **Never fewer than one**, which is rule nine rather than a rounding: a month
 * cell that can name nothing has the density mark to say the day is busy, and a
 * list that draws nothing is an empty rectangle with a heading on it.
 *
 * **And no `MAX_NAMES` cap.** Twelve is where the *model's slim per-cell list*
 * stops, which is a fact about a month cell — the manifest carries at most
 * twelve titles for one day, so a thirteenth is not something a bigger square
 * can buy. An agenda reads the household's whole window, seven days of it by
 * default, so there a thirteenth event is exactly what a bigger box buys and
 * capping it here would be the fault this table exists to remove, hiding one
 * table down. Measured on the shipped Classic wall at 2560x1440, that cap alone
 * was the difference between 12 events and 15.
 */
export function listRowsAt(tier: CalendarTier, innerH: number, emPx: number): number {
  if (tier.names <= 0) return 1;
  if (!(emPx > 0) || !(innerH > 0)) return Math.max(1, tier.names);
  const rows = Math.floor((innerH / emPx - NUMERAL_EM) / ROW_EM);
  return Math.max(1, tier.names, rows);
}

/**
 * Whether a multi-day bar is wide enough for its own words.
 *
 * Asked of the bar rather than of the cells it crosses, which is the deviation
 * the table's docstring above argues for: a five-day bar on a panel whose cells
 * are 4.7ch is 26ch of its own, and the words fit.
 */
export function spanIsLabelled(innerW: number, chPx: number): boolean {
  return chPx > 0 && innerW > 0 && innerW / chPx + TIER_EPSILON >= LABEL_MIN_CH;
}

/**
 * The weekday head this tier has room for.
 *
 * `letters` of the short name, or the long name where the tier asks for the
 * whole word. Both are passed in: the model carries the short weekday for every
 * cell and the long one beside it, so this cuts a string it was given rather
 * than formatting a date, which is not a thing a pure module can do honestly
 * (a zone and a locale are the household's, and `Intl` is not this file's).
 */
export function weekdayHead(short: string, long: string, letters: number): string {
  if (letters <= 0) return long === '' ? short : long;
  return short.slice(0, letters);
}
