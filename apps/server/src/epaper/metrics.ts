/**
 * The eInk layout, as arithmetic on the panel rather than as constants (RFC 006).
 *
 * Everything the frame is drawn with used to be an absolute pixel tuned by
 * looking at one 800×480 Seeed 7.5": `MARGIN = 16`, `HEADER_H = 54`,
 * `rowH = 34`, `headH = 26`, `PILL_MIN_CELL = 34`. Those are good numbers — they
 * came from real output, which is more than most numbers in a renderer can say
 * — but they are good numbers *for one panel*, and the supported range runs
 * 640×384 to 1872×1404 in either orientation. Measured with thirty days of
 * events on it, the constant version stopped drawing halfway down a 13.3" panel
 * and left 714px (51%) of it white.
 *
 * So this module is where those numbers come back as expressions. It is pure —
 * geometry in, integers out, no framebuffer and no model — which is the same
 * seam `widget-options.ts`, `ink.ts` and `ladder.ts` exist at: a layout decision
 * taken inside a draw call is a decision nothing can test.
 *
 * **Every metric is an integer.** This is a 1-bit raster: a fractional row
 * boundary is not a slightly-off boundary, it is a half-lit scan line, and on
 * e-paper a half-lit line is a grey smear that does not go away until the next
 * full refresh. Values round to *nearest* rather than flooring, because these
 * are stacked rhythms — a body is a header plus a gap plus a rule plus rows —
 * and a systematic downward bias compounds down the stack. The one thing that
 * floors is a **count**: a row that does not fit must not be drawn.
 *
 * **The type ladder is anchored, not invented.** `800×480 → scale 2` is the
 * shipped body size and is treated as the fixed point; every other panel is
 * that scale times `(shortSide / 480) ** 0.6`. The exponent is the whole
 * argument: at 1.0 a bigger panel shows exactly what a smaller one shows, only
 * larger, which is what a household with a 13.3" panel did not pay for; at 0.0
 * it shows more at a size that stops being readable across a kitchen. 0.6 buys
 * both, and the measured ladder is what to judge it by — 8, 11, 15 and 17
 * agenda rows across the four landscape sizes, at 16, 16, 24 and 32px of type.
 *
 * It is derived from the **short side**, never the height, because a panel
 * hung sideways is the same piece of hardware: `min(w, h)` is the one number a
 * quarter turn cannot change, and deriving from height would make the same
 * 13.3" panel draw 32px type landscape and 48px portrait.
 */

import { GLYPH_SIZE } from './font.js';

/** The panel's visual size in pixels — after rotation, as a viewer sees it. */
export interface PanelGeometry {
  readonly width: number;
  readonly height: number;
}

/**
 * The bitmap font's line box: its 8px glyph plus 3px of leading, per scale rung.
 *
 * Read out of the shipped renderer rather than chosen — `drawAgendaBox` puts
 * its rule at `y + 22`, `drawMonthBox`'s weekday band is 22 tall, and
 * `drawWeekBox` steps its column rows by 11. Those are 11×2 and 11×1, which
 * means the file already had a line box; it just had it written down three
 * times as three literals.
 */
const LEADING = 3;

/** The panel the shipped constants were tuned on, and the scale they used. */
const ANCHOR_SHORT_SIDE = 480;
const ANCHOR_BODY_SCALE = 2;

/**
 * How type grows with the panel. See the header — 1.0 is "the same wall,
 * bigger", 0.0 is "the same type, more of it", and this is deliberately nearer
 * the second.
 */
const SIZE_EXPONENT = 0.6;

/**
 * A ceiling on the working set, not on what fits.
 *
 * `agendaRowsInBox` answers from the box, so a very large panel would otherwise
 * ask for a hundred rows of a day that has four things on it — and the model
 * would have to carry them. Twenty-four is a day nobody has; the box is what
 * actually decides on every panel in the range.
 */
export const MAX_AGENDA_ROWS = 24;

/** The same ceiling for one month cell's names. Twelve is the wall's own cut. */
export const MAX_CELL_TITLES = 12;

/**
 * The tallest a month cell may be relative to its width.
 *
 * The built-in landscape layout never reaches it — the widest the range gets is
 * 2.03 at 1872×1404 — so this is a rail for a *widget* box a household dragged
 * three times taller than it is wide, where filling the height would draw seven
 * columns of letterbox slots with a day number rattling around in each. Past
 * the rail the grid keeps its shape and leaves the rest of the box, because a
 * calendar that has stopped looking like a calendar is worth less than a gap.
 */
const MAX_CELL_ASPECT = 2.5;

export interface EpaperMetrics {
  /** The panel this was derived for, so a caller need not carry both. */
  readonly panel: PanelGeometry;

  /** Integer font scales. `body` is the ladder; the rest are rungs off it. */
  readonly bodyScale: number;
  readonly headerScale: number;
  readonly yearScale: number;
  /** Weekday letters over the month grid, and a week column's day head. */
  readonly labelScale: number;
  /** Event names inside a month cell, date rules, and every "+N". */
  readonly smallScale: number;

  /** `GLYPH_SIZE × bodyScale` — one line of body ink, the unit for the gaps. */
  readonly bodyGlyph: number;
  /** The body line box: glyph plus leading. 22 at 800×480. */
  readonly bodyLine: number;

  /** The frame's outer inset. 16 at 800×480. */
  readonly margin: number;
  /** The inverted date band across the top. 54 at 800×480. */
  readonly headerHeight: number;
  /** Between the header band and the body. 14 at 800×480. */
  readonly headerGap: number;
  /** Between stacked blocks in portrait. 12 at 800×480. */
  readonly blockGap: number;

  /** One agenda row, bullet to bullet. 34 at 800×480. */
  readonly agendaRowH: number;
  /** A labelled rule ("TODAY") and the drop to the first row. 22 and 36. */
  readonly agendaRuleY: number;
  readonly agendaHeadH: number;
  /** The all-day/timed bullet: its side, its drop, and the gap after it. */
  readonly bullet: number;
  readonly bulletDrop: number;
  readonly bulletGap: number;
  /** A quarter line, for the small insets inside a head or a column. 4 at 800×480. */
  readonly pad: number;
  /** One row of the upcoming list, which is tighter — its days carry rules. */
  readonly upcomingRowH: number;
  /** A date rule in that list: where its hairline sits, and the drop after it. */
  readonly dateRuleY: number;
  readonly dateRuleH: number;

  /** The weekday label band over the month grid. 22 at 800×480. */
  readonly monthHeadH: number;
  /** A week column's day head, which carries a number as well as a letter. 26. */
  readonly weekHeadH: number;
  /** The smallest cell the grid will draw at all. 12 at 800×480. */
  readonly minCell: number;
  /** The smallest cell that can hold a named event under its day number. 34. */
  readonly pillMinCell: number;
  /** …and the narrowest. A cell with room for three characters of a name. */
  readonly pillMinWidth: number;
  /** Inside one cell: the number's corner inset, the names' inset, their step. */
  readonly cellNumberInset: number;
  readonly cellInset: number;
  readonly cellTitleLineH: number;
  /** A week column's own title step, which is a line box rather than tighter. */
  readonly weekTitleLineH: number;
  /**
   * One span lane in the month grid: the bar, and the pixels under it.
   *
   * A multi-day event is one bar across its days rather than the same words in
   * every square, and the bar has to hold a cell-title line — so it is that
   * line plus a pixel of ground either side, and the lane is the bar plus the
   * gap to the next. Constants (10 and 12) when they arrived, which is 10px of
   * bar under a 32px day number on a 13.3" panel.
   */
  readonly spanBarH: number;
  readonly spanLaneH: number;
  /**
   * The density mark under a cell's numeral: a hairline whose length steps
   * with the day's count, and the gap under it. 3 and 3 at 800×480.
   */
  readonly markH: number;
  readonly markGap: number;

  /** Everything the free-form widgets are drawn with. */
  readonly widget: EpaperWidgetMetrics;
}

/**
 * The widget chrome and its lists, which had the built-in layout's fault one
 * layer along.
 *
 * `renderEpaper` was the whole of it for a release, and it was not: every
 * widget on a household's own canvas was still drawn in pixels tuned on the
 * same 800×480 — an 8px inset, a 20px title bar with 8px type in it, 24px
 * to-do rows, 22px chore rows, and a dozen `scaleToFit(text, box.w, 2)` calls
 * capping ordinary widget text at 16px on a 13.3" panel. Measured as ink inside
 * one widget filling 90% of the panel, a note drew **15%** of the density at
 * 1872×1404 that it drew at 800×480, and a clock 16%. The calendar widget read
 * 64%, because that one had already been fixed — which is what said the rest
 * were not.
 *
 * Same rule as everything above: each of these reproduces the constant it
 * replaced at 800×480, exactly.
 */
export interface EpaperWidgetMetrics {
  /** A widget's border to its content. `PAD`, 8 at 800×480. */
  readonly inset: number;
  /**
   * One line of small type plus its leading — where a title's hairline sits,
   * and how far a group heading drops. 12 at 800×480, which is both.
   */
  readonly smallLine: number;
  /** The drop past a title bar to the content under it. 20 at 800×480. */
  readonly titleBarH: number;
  /** Leading under a line of any scale in a stack. 4 at 800×480. */
  readonly linePad: number;
  /** A bulleted list row — a to-do. 24 at 800×480. */
  readonly listRowH: number;
  /** A chore row, which is a body line box rather than a list row. 22. */
  readonly choreRowH: number;
  /** The chore tick: its drop into the row, its fill's inset, and the fill. */
  readonly tickDrop: number;
  readonly tickInset: number;
  readonly tickDot: number;
  /** After a chore group, and between the rows of a forecast column. 6. */
  readonly rowGap: number;
  /** The smallest forecast column drawn as a column rather than a line. 56×40. */
  readonly columnMinW: number;
  readonly columnMinH: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A line box at a scale: the glyph plus its leading. */
export const lineBox = (scale: number): number => (GLYPH_SIZE + LEADING) * scale;

/**
 * Every layout number for one panel.
 *
 * Read the 800×480 column of the comments as the specification: each of these
 * must come back to the constant it replaced on the panel that was tuned, or
 * the derivation is wrong and the constant was right.
 */
export function panelMetrics(geometry: PanelGeometry): EpaperMetrics {
  const width = Math.max(1, Math.round(geometry.width));
  const height = Math.max(1, Math.round(geometry.height));
  const short = Math.min(width, height);

  // The ladder. 384→2, 480→2, 984→3, 1404→4, and never below the shipped 2,
  // so the 4.2" and 2.9" presets keep the type they have today.
  const bodyScale = clamp(
    Math.round(ANCHOR_BODY_SCALE * (short / ANCHOR_SHORT_SIDE) ** SIZE_EXPONENT),
    2,
    8,
  );
  const bodyGlyph = GLYPH_SIZE * bodyScale;
  const bodyLine = lineBox(bodyScale);

  // Rungs off it. The header is half a rung up (3 at 800×480, which is what
  // `drawHeader` starts its own step-down from); the year and the weekday
  // letters sit on the body rung; names inside a cell sit half a rung down.
  const headerScaleWanted = clamp(Math.round(bodyScale * 1.5), 2, 12);
  const yearScale = bodyScale;
  const labelScale = bodyScale;
  const smallScale = Math.max(1, Math.round(bodyScale / 2));

  // A step off the panel rather than a constant 16. Even pixels, because the
  // margin is an inset on both sides and an odd one puts the body half a pixel
  // off centre — which at 1 bit is a column of the frame, not a rounding error.
  const margin = clamp(2 * Math.round(short / 60), 2, Math.floor(short / 8));

  /*
   * The header band.
   *
   * Aimed at 6% of the panel's height and then held between 2.25 and 3.2 times
   * the date's own line of ink. On every panel in the supported range the lower
   * bound is what binds — 6% of 480 is 29px and the date is 24px of glyph, so
   * the target alone would draw a band the text does not fit in. It earns its
   * place on a canvas that is tall for its width (a portrait 1404×1872 panel
   * takes 112 from the target rather than 108 from the bound), and the upper
   * bound is what stops a very tall narrow canvas spending a third of itself on
   * the date.
   *
   * 2.25 rather than the 2.2 this was specified at, because 2.25 × 24 is
   * exactly the 54 that shipped. A derivation that misses its anchor by a pixel
   * moves every row under it.
   */
  const headerGlyph = GLYPH_SIZE * headerScaleWanted;
  const headerHeight = Math.min(
    clamp(Math.round(0.06 * height), Math.round(2.25 * headerGlyph), Math.round(3.2 * headerGlyph)),
    // Rule nine: on a 296×128 panel the band would otherwise be 42% of the
    // glass. A quarter is the most a date may take before the calendar under it
    // stops being the point.
    Math.round(height * 0.25),
  );
  // …and if the rail above cut the band, the date comes down with it rather
  // than being drawn through the edge of its own band.
  const headerScale = Math.max(1, Math.min(headerScaleWanted, Math.floor((headerHeight - 2) / GLYPH_SIZE)));

  // Hoisted, because the widget metrics below are built from them too and one
  // expression written twice is one expression that can drift.
  const pad = Math.round(bodyGlyph * 0.25);
  const bullet = Math.round(bodyGlyph * 0.75);

  return {
    panel: { width, height },
    bodyScale,
    headerScale,
    yearScale,
    labelScale,
    smallScale,
    bodyGlyph,
    bodyLine,
    margin,
    headerHeight,
    // Seven eighths and three quarters of a body line. 14 and 12 at 800×480.
    headerGap: Math.round(bodyGlyph * 0.875),
    blockGap: Math.round(bodyGlyph * 0.75),

    // 1.55 line boxes to a row: 34 at 800×480, which is the shipped value to
    // the pixel. The upcoming list runs tighter at 1.36 because its days are
    // separated by their own dated rules and do not need the air.
    agendaRowH: Math.round(1.55 * bodyLine),
    agendaRuleY: bodyLine,
    agendaHeadH: bodyLine + Math.round(bodyGlyph * 0.875),
    bullet,
    bulletDrop: Math.round(bodyGlyph * 0.125),
    bulletGap: Math.round(bodyGlyph * 0.5),
    pad,
    upcomingRowH: Math.round(1.36 * bodyLine),
    dateRuleY: GLYPH_SIZE * smallScale + 2 * smallScale,
    dateRuleH: 2 * GLYPH_SIZE * smallScale,

    // The weekday band is exactly the label's own line box — 22 at 800×480,
    // which is the shipped `labelH`. A week column's head carries a number
    // beside the letter, so it takes a further quarter line: 26, also shipped.
    monthHeadH: lineBox(labelScale),
    weekHeadH: lineBox(labelScale) + Math.round(bodyGlyph / 4),
    minCell: Math.round(1.5 * GLYPH_SIZE * smallScale),
    /*
     * The smallest cell that can hold a named event, written as the anatomy the
     * shipped comment describes rather than as the 34 it added up to: the
     * number's inset, the number itself (a rung above the names), the gap under
     * it, one line of name, and a foot. Every term scales with the name, so a
     * 1872×1404 panel asks for 68 and gets cells of 235.
     */
    pillMinCell:
      4 * smallScale +
      GLYPH_SIZE * (2 * smallScale) +
      2 * smallScale +
      GLYPH_SIZE * smallScale +
      4 * smallScale,
    /*
     * Width was never checked, because the shipped cell was square by
     * construction — `min(w / 7, h / weeks)` — so a cell tall enough was wide
     * enough. A cell that fills its box is not, and a name cut to two
     * characters is the "unreadable smudge" the pill threshold exists to
     * refuse. Three characters is the bar; 800×480's 50px cell clears it
     * exactly as it did before, and so does 640×384's 40px one.
     */
    pillMinWidth: 2 * (3 * smallScale) + (3 * (GLYPH_SIZE + 1) - 1) * smallScale,
    cellNumberInset: 4 * smallScale,
    cellInset: 3 * smallScale,
    // A month cell packs tighter than a week column: its names sit under an
    // oversized day number in a small box, so they get a quarter-glyph of
    // leading rather than a full line box. 10 and 11 at 800×480 — both shipped.
    cellTitleLineH: GLYPH_SIZE * smallScale + Math.round((GLYPH_SIZE * smallScale) / 4),
    weekTitleLineH: lineBox(smallScale),
    // A bar is a cell-title line with a pixel of ground either side; a lane is
    // that bar and the gap to the next. 10 and 12 at 800×480, which is what
    // they were as constants.
    spanBarH: GLYPH_SIZE * smallScale + 2 * smallScale,
    spanLaneH: GLYPH_SIZE * smallScale + 4 * smallScale,
    markH: Math.max(1, Math.round(GLYPH_SIZE * smallScale * 0.375)),
    markGap: Math.max(1, Math.round(GLYPH_SIZE * smallScale * 0.375)),
    widget: widgetMetrics(bodyGlyph, smallScale, bodyLine, pad, bullet),
  };
}

/**
 * The widget chrome, derived from the same primitives the built-in layout uses.
 *
 * Taken as arguments rather than off a half-built `EpaperMetrics`, so the
 * derivations read as arithmetic on the ladder instead of as a second object
 * that could disagree with the first.
 */
function widgetMetrics(
  bodyGlyph: number,
  smallScale: number,
  bodyLine: number,
  pad: number,
  bullet: number,
): EpaperWidgetMetrics {
  const smallGlyph = GLYPH_SIZE * smallScale;
  const smallLine = smallGlyph + pad;
  const choreRowH = bodyLine;
  const tickInset = Math.round(bullet / 4);
  return {
    inset: Math.round(bodyGlyph * 0.5),
    smallLine,
    titleBarH: smallLine + smallGlyph,
    linePad: pad,
    // A bullet's row: the glyph beside it, plus the gap that follows the bullet.
    listRowH: bodyGlyph + Math.round(bodyGlyph * 0.5),
    choreRowH,
    // Centred in its own row rather than offset by a constant: the tick is
    // `bullet` tall in a `choreRowH` row, so the drop is what is left over.
    tickDrop: Math.round((choreRowH - bodyGlyph) / 2),
    tickInset,
    // What is left inside the box after the inset on both sides, so the fill
    // can never reach its own border however the ladder moves.
    tickDot: bullet - 2 * tickInset,
    rowGap: Math.round(pad * 1.5),
    // Below this a forecast is a list of lines rather than a strip of columns —
    // the two-mode shape `drawShift` uses, and the threshold that decides it.
    columnMinW: Math.round(bodyGlyph * 3.5),
    columnMinH: Math.round(bodyGlyph * 2.5),
  };
}

/**
 * A type scale `factor` rungs off the panel's body scale.
 *
 * The widget draws cap their type — a clock at 8, a countdown at 9, a shift
 * headline at 7, a forecast column's at 3 — and every one of those numbers was
 * a literal, which is why a 13.3" panel drew a clock the size of a 7.5" panel's
 * in six times the box. The *factor* stays at the call site because it is a
 * fact about that widget's shape rather than about the panel; only the rung it
 * is measured in belongs here. At the anchor these give back 8, 9, 7 and 3.
 */
export function scaleRung(m: EpaperMetrics, factor: number): number {
  return Math.max(1, Math.round(m.bodyScale * factor));
}

/**
 * How many agenda rows fit between `y` and the foot of the box.
 *
 * This is `EPAPER_TODAY_LIMIT`'s replacement and the whole of task 2: the
 * shipped constant said six, with a comment calling it "the most agenda rows a
 * 7.5" panel can hold and still be read at the far side of a kitchen" — an
 * honest measurement of one panel, applied to a 3.7× range. The row height has
 * not changed at 800×480, so eleven rows there are exactly as readable as the
 * six were; there are simply five more of them where there was white.
 *
 * A row is drawn when its *ink* fits, not its whole row height — that is the
 * `y + glyph > bottom` guard the renderer has always had, and the arithmetic
 * has to agree with it or the count and the loop disagree about the last row.
 */
export function agendaRowsInBox(available: number, m: EpaperMetrics): number {
  if (available < m.bodyGlyph) return 0;
  return Math.min(MAX_AGENDA_ROWS, Math.floor((available - m.bodyGlyph) / m.agendaRowH) + 1);
}

/** The same question for the names inside one month cell (`EPAPER_CELL_TITLES`). */
export function cellTitlesInBox(available: number, m: EpaperMetrics): number {
  const glyph = GLYPH_SIZE * m.smallScale;
  if (available < glyph) return 0;
  return Math.min(MAX_CELL_TITLES, Math.floor((available - glyph) / m.cellTitleLineH) + 1);
}

/** …and for a week column, which steps by a line box rather than by a cell's. */
export function weekTitlesInBox(available: number, m: EpaperMetrics): number {
  const glyph = GLYPH_SIZE * m.smallScale;
  if (available < glyph) return 0;
  return Math.min(MAX_CELL_TITLES, Math.floor((available - glyph) / m.weekTitleLineH) + 1);
}

/** A month grid's cell size and where its first row starts, inside one box. */
export interface GridMetrics {
  readonly cellW: number;
  readonly cellH: number;
  /** Pixels between the weekday labels and the first row — see below. */
  readonly topOffset: number;
}

/**
 * How a month grid fills the box it was given.
 *
 * The shipped grid used one square cell, `min(box.w / 7, available / weeks)`,
 * which means it was width-bound on every landscape panel and simply stopped:
 * at 1872×1404 the right-hand column is 815px wide and 1178 tall, so 116px
 * cells drew 580px of grid and left 598px of nothing under it. Width and height
 * are separate now, and the grid fills.
 *
 * **The cells stretch, and that is the honest cost of a two-column layout on a
 * 4:3 panel.** Making them square instead needs the month column 1694px wide on
 * a 1872px panel, which leaves the agenda seven characters for a title. Nothing
 * else in the column can absorb the height — so the cell takes it, and gains
 * room for names rather than losing anything.
 *
 * `topOffset` is the remainder. `floor` is the only correct rounding for a cell
 * — a cell rounded up puts the last row's border past the foot of the box,
 * where it is clipped rather than drawn — so five cells of 74 fill 370 of 374
 * and the grid would stop 4px short of the bottom edge it was asked to reach.
 * Those 4px go *above* the first row, where they land between the weekday
 * letters and the grid and nobody can see them, instead of below the last,
 * where they are the bug this module exists for.
 */
export function gridMetrics(boxW: number, availableH: number, weeks: number, m: EpaperMetrics): GridMetrics {
  const rows = Math.max(1, weeks);
  const cellW = Math.max(m.minCell, Math.floor(boxW / 7));
  const fill = Math.max(m.minCell, Math.floor(availableH / rows));
  const cellH = Math.min(fill, Math.round(cellW * MAX_CELL_ASPECT));
  // Only the rounding remainder is handed back. When the aspect rail is what
  // cut the cell the leftover is a deliberate gap, and pushing the grid down
  // into it would move that gap under the weekday letters, which reads as a
  // grid that has come unstuck rather than as one that fits.
  const topOffset = cellH === fill ? Math.max(0, availableH - rows * cellH) : 0;
  return { cellW, cellH, topOffset };
}
