/**
 * How much a layout can be asked to hold before it stops saying anything.
 *
 * Pure functions of measured sizes, so the decision can be argued about against
 * numbers rather than a screenshot — the same reason `viewmodel.ts` has no DOM
 * in it and `orientation.ts` computes a layout instead of asking a media query.
 */

/**
 * The least box width, per column, that a seven-column week can be drawn in.
 *
 * Measured rather than picked. Rendering the week style at a shrinking width in
 * a real browser and looking at it:
 *
 * | box width ÷ 7 | what it looks like                                    |
 * |---------------|-------------------------------------------------------|
 * | 5.6rem        | clean: the weekday row is spaced and short titles fit  |
 * | 4.0rem        | tidy and useless: every title is one letter and "…"    |
 * | 2.8rem        | broken: the weekday abbreviations collide              |
 *
 * So the floor sits at 5rem — just under what still works, rather than just
 * over what still fits. The failure it prevents is the middle row, which is the
 * dangerous one: at 4rem the wall looks deliberate and carries no information,
 * so nobody reports it as broken and nobody can read it either.
 */
export const MIN_WEEK_COLUMN_REM = 5;

/**
 * Whether seven day-columns are worth drawing in a box this wide.
 *
 * `boxWidthPx` is the widget's own box, measured after layout — the columns
 * share it, minus gaps, so this slightly over-estimates each column and the
 * floor above is calibrated against the same measurement.
 *
 * An unmeasurable box (zero width, a detached node, a `rem` that did not parse)
 * answers **yes**: the household asked for a week, and drawing what they asked
 * for is the safer failure than silently substituting a list because a
 * measurement was unavailable for a frame.
 */
export function weekColumnsFit(boxWidthPx: number, remPx: number, columns = 7): boolean {
  if (!(boxWidthPx > 0) || !(remPx > 0) || columns < 1) return true;
  return boxWidthPx / columns >= MIN_WEEK_COLUMN_REM * remPx;
}

/**
 * The least section width an agenda row can keep its time *beside* its title in.
 *
 * The row is a date column (7.5rem), a time column (8rem), two gaps and a
 * title. Below about 26rem there is nothing left for the title, and the words
 * break mid-syllable — "Foot / bal / l" — which is worse than the clipping it
 * replaced. Above it, the time sits where the design puts it.
 */
export const MIN_AGENDA_ROW_REM = 26;

/**
 * Whether an agenda row can keep its time beside its title at this width.
 *
 * Measured on the laid-out section rather than the widget box: the box is
 * scaled to fit, so a 28rem box can be carrying a 20rem section. Unmeasurable
 * answers **yes**, keeping the design's own arrangement.
 */
export function agendaTimeFitsBeside(sectionWidthPx: number, remPx: number): boolean {
  if (!(sectionWidthPx > 0) || !(remPx > 0)) return true;
  return sectionWidthPx / remPx >= MIN_AGENDA_ROW_REM;
}
