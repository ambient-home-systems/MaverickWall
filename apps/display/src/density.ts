/**
 * The two boundaries a widget's *layout* changes at, rather than its density.
 *
 * **This file used to hold the scale floors, and they are gone with the
 * transform they bounded.** `MIN_CHORE_SCALE` and `MIN_CALENDAR_SCALE` were
 * both 0.62 — the deepest a section could be shrunk and stay readable across a
 * room — and both were arrived at by measuring a real 1280x720 television at
 * six scales and writing down what was on the glass. They were correct
 * bandages on the wrong mechanism: a uniform `transform: scale()` can change
 * how big a widget looks and can never change what it says, so the floors were
 * bounding a trade the layout should not have been making. `CLAUDE.md` keeps
 * both measurement tables as history, because what they record — what a wall
 * looks like at 0.20, 0.30, 0.40, 0.50, 0.62 and 0.80, with a sentence per row
 * — outlives the constants they justified.
 *
 * What is left here is the two questions that are genuinely about *layout*
 * rather than about density, and neither is a floor on a scale:
 *
 *  - whether seven day-columns are worth drawing at all in a box this wide;
 *  - whether an agenda row can keep its time beside its title.
 *
 * Both answer with a **form** — a week becomes an agenda, a time moves above
 * its title — which is the same shape as a density tier one step up, and they
 * live here rather than in `widget-tiers.ts` because their unit is the wall's
 * own `rem` rather than a widget's primary role. Seven columns is the one
 * section on the wall that does not get narrower *type* as its box narrows: it
 * gets narrower columns, and a column with a letter in it is not a week.
 *
 * Pure functions of measured sizes, so the decision can be argued about against
 * numbers rather than a screenshot — the same reason `viewmodel.ts` has no DOM
 * in it and `orientation.ts` computes a layout instead of asking a media query.
 */

/**
 * The week's own tier boundary: the least box width, per column, that seven
 * day-columns can be drawn in.
 *
 * **A boundary rather than a floor**, and the distinction is what kept this
 * constant when the two beside it went. A scale floor bounds how far a drawing
 * may be shrunk; this decides which of two drawings there is. Below it the
 * household's week is drawn as an agenda — the same events, down a list, at the
 * size they are declared at — and above it as seven columns. Nothing is scaled
 * either side of it, and no type gives up a point.
 *
 * It is stated in `rem` rather than in `ch` of a role, which is the one place
 * this differs from `widget-tiers.ts`, and that is deliberate: a week column's
 * problem is not that its *type* is too small — the type never changes — it is
 * that the column is too narrow to hold a day, gaps, card and all. The number
 * was measured against those columns, so it is stated in the unit they are
 * built in.
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
 * So the boundary sits at 5rem — just under what still works, rather than just
 * over what still fits. The failure it prevents is the middle row, which is the
 * dangerous one: at 4rem the wall looks deliberate and carries no information,
 * so nobody reports it as broken and nobody can read it either.
 *
 * **It applies to the comfortable week alone**, and that restriction is as
 * load-bearing as the number. The dense week gives up its gaps, its cards and
 * its padding precisely so that it fits in less room, so its own boundary is a
 * different number and nobody has measured it; applying this one would swap an
 * agenda onto every wall already hanging that stores `skyweek`. The renderer
 * says so at the one call site.
 */
export const MIN_WEEK_COLUMN_REM = 5;

/**
 * Whether seven day-columns are worth drawing in a box this wide.
 *
 * `boxWidthPx` is the widget's own box, measured after layout — the columns
 * share it, minus gaps, so this slightly over-estimates each column and the
 * boundary above is calibrated against the same measurement.
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
 * Measured on the laid-out section rather than on the widget box. That used to
 * matter for a reason that is gone — a box was scaled to fit, so a 28rem box
 * could be carrying a 20rem section — and it is still the right element to ask,
 * because a section can be narrower than its box for reasons that have nothing
 * to do with a transform (a widget title's own inset, a theme's card padding).
 * Unmeasurable answers **yes**, keeping the design's own arrangement.
 */
export function agendaTimeFitsBeside(sectionWidthPx: number, remPx: number): boolean {
  if (!(sectionWidthPx > 0) || !(remPx > 0)) return true;
  return sectionWidthPx / remPx >= MIN_AGENDA_ROW_REM;
}
