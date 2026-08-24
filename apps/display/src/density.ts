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

/**
 * The least a chore board may be scaled to before it stops being readable.
 *
 * Measured, not picked, and the measurement is why it is not the 0.3 the notes
 * and to-do widgets use. A "this week" board of four daily chores is 28 rows;
 * `fitToBox` duly shrank it to that floor, and on a 1280px wall the chore names
 * came out at **8.1px**. That is not small — it is gone, on the one surface the
 * product exists for.
 *
 * | scale | chore name on a 1280px wall | what it looks like                |
 * |-------|-----------------------------|-----------------------------------|
 * | 1.00  | 21.6px                      | the design                        |
 * | 0.62  | 13.4px                      | dense, still readable across a room|
 * | 0.30  | 8.1px                       | grey texture with boxes in it     |
 *
 * A note that shrinks is still a note; a board nobody can read from the doorway
 * has stopped being the thing it was put on the wall for. So the floor is set
 * where it stays legible and the box clips below it — rule nine's "degrade to
 * showing less rather than showing nothing readable" — and the week view trims
 * to whole days so the clip lands between rows rather than through one.
 */
export const MIN_CHORE_SCALE = 0.62;

/**
 * The least a calendar may be scaled to before it stops being the calendar.
 *
 * Measured, not picked, and it exists because the calendar had no floor at all:
 * `minScaleFor` protected a note at 0.3, a weather reading at 0.4 and a chore
 * board at 0.62, and dropped the calendar through to `default: 0.2` — the
 * lowest bound in the system, on the one thing the product exists to show.
 *
 * This is **not** a `--t-micro` violation, and arguing it that way is wrong:
 * `display.css` exempts "the compact widget renderings that `fitToBox` already
 * scales" by name, so the type floor never claimed to survive the transform.
 * What this constant is, is the thing that *bounds* that exemption.
 *
 * Measured on the first-run wall — the Classic template, one feed, nothing
 * configured — whose agenda box is 333x216 on a 1280x720 television. Each row
 * is the floor, the scale the fit then settles at, and what is on the glass:
 *
 * | floor | settles at | event time | days | what it looks like                 |
 * |-------|------------|------------|------|------------------------------------|
 * | 0.20  | 0.27       | 4.4px      | 6    | six days of grey; no word is a word |
 * | 0.30  | 0.31       | 5.1px      | 5    | still gone — the note floor is not this widget's |
 * | 0.40  | 0.46       | 7.4px      | 3    | small: legible leaning in, not from the doorway |
 * | 0.50  | 0.60       | 9.8px      | 2    | readable here, and 0.642rem in portrait — under the bar |
 * | 0.62  | 0.62       | 10.0px     | 2    | today and tomorrow, read across a room |
 * | 0.80  | 1.00       | —          | 1    | today alone, reading "Nothing on": an Upcoming widget with nothing upcoming |
 *
 * So 0.62 — the same number the chore board landed on, arrived at separately
 * and worth stating why. 0.5 is where the *landscape* walls become readable and
 * it is not enough: in portrait the box is wider, the fit lands on the floor
 * rather than above it, and the section label draws at 0.642rem — under the
 * 0.713rem the browser harness derives from `--t-micro` x `MIN_CHORE_SCALE`. At
 * 0.62 the worst word on any of the three sizes is 0.775rem, which clears it.
 * The top of the range is bounded by the widget's own question: by 0.8 only one
 * day survives and on the seeded wall that day is today, which is the only day
 * an agenda draws when it is empty.
 *
 * The cost is real and deliberate: a wall that drew six days now draws two. A
 * calendar nobody can read from the doorway has stopped being the thing it was
 * put on the wall for, and the answer to a box this small is fewer days drawn
 * larger — which is why the floor ships with the agenda trimming to whole days
 * and fitting again, exactly as the chore week board does.
 */
export const MIN_CALENDAR_SCALE = 0.62;
