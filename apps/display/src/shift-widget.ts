import type { TodayShiftModel } from './viewmodel.js';

/**
 * What the Shift widget shows, decided as data.
 *
 * Kept out of `render.ts` for the reason the whole display is split that way:
 * the renderer builds nodes and does no thinking, so every decision about
 * *what* is drawn can be tested against a document rather than a screenshot.
 * There is no DOM in the display's test suite, and a widget whose options are
 * resolved inside a `document.createElement` call cannot be checked at all.
 *
 * It is also the shape a wider widget editor would grow into: the panel
 * renderer makes the same decisions in `epaper/widgets.ts` against the same
 * config keys, and one of them being wrong is how the wall and the panel came
 * to disagree about who was on nights.
 */

export interface ShiftWidgetView {
  /** The people to draw, in the household's order. Empty means draw nothing. */
  readonly entries: readonly TodayShiftModel[];
  /** Their photo, when they have one. */
  readonly face: boolean;
  /** The `HH:MM–HH:MM` window, when the shift has one. */
  readonly hours: boolean;
  /** "Day 2 of 4 · 2 more", when the run is known. */
  readonly run: boolean;
  /** The shift's full name, or its short code — the month grid's abbreviation. */
  readonly name: 'label' | 'code';
}

const read = (config: unknown): Record<string, unknown> =>
  typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Resolve one Shift widget's options against today's rota.
 *
 * Every flag is *absence means on*: the face, the hours and the run have been
 * drawn since the badge existed, so a canvas arranged around them keeps them
 * through a schema change and only `false` is ever stored (see
 * `widgetConfigBody`). `people` is the same "none chosen means all" the
 * calendar and reading pickers use — which is what an untouched widget has
 * always drawn under, except that it used to mean "whoever sorted first".
 *
 * A widget pointed at somebody who is off today resolves to no entries, and the
 * renderer draws the canvas's ordinary "nothing to show yet" note. That is the
 * honest empty: promoting another person's shift into a box a household aimed
 * at one of them would be a wall answering a question nobody asked.
 */
export function shiftWidgetView(
  todayShifts: readonly TodayShiftModel[],
  config?: unknown,
): ShiftWidgetView {
  const c = read(config);
  const chosen = strings(c['people']);
  return {
    entries: todayShifts.filter(
      (entry) => chosen.length === 0 || chosen.includes(entry.shift.personId),
    ),
    face: c['showFace'] !== false,
    hours: c['showHours'] !== false,
    run: c['showRun'] !== false,
    name: c['shiftName'] === 'code' ? 'code' : 'label',
  };
}
