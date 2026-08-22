import { shiftLadder, type ShiftField } from './ladder.js';
import type { TodayShiftModel, WeatherDayModel } from './viewmodel.js';

/**
 * What each widget shows, decided as data.
 *
 * Kept out of `render.ts` for the reason the whole display is split that way:
 * the renderer builds nodes and does no thinking, so every decision about
 * *what* is drawn can be tested against a document rather than a screenshot.
 * There is no DOM in the display's test suite, and a widget whose options are
 * resolved inside a `document.createElement` call cannot be checked at all.
 *
 * One module for every widget rather than one per widget, because the failure
 * this exists to prevent is two places disagreeing: `epaper/widgets.ts` makes
 * the same decisions against the same config keys, and one of them being wrong
 * is how the wall and the panel came to disagree about who was on nights.
 *
 * Started as `shift-widget.ts` in 0.45.0 and was renamed the moment a second
 * widget needed the same treatment, rather than growing a second home for it.
 */

const read = (config: unknown): Record<string, unknown> =>
  typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * A whole-number count inside the schema's bounds, or undefined for "all".
 *
 * Read defensively rather than trusted: the server validates what it stores,
 * but a wall can be a version ahead of its server or drawing a document out of
 * IndexedDB, and a widget that shows nothing because a number arrived as a
 * string is a hole in the wall (rule nine).
 */
function count(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const whole = Math.trunc(value);
  return whole >= 1 ? Math.min(max, whole) : undefined;
}

/* ---------------------------------------------------------------- SHIFT --- */

export interface ShiftWidgetView {
  /** The people to draw, in the household's order. Empty means draw nothing. */
  readonly entries: readonly TodayShiftModel[];
  /** Their photo, when they have one. */
  readonly face: boolean;
  /** The shift's full name, or its short code — the month grid's abbreviation. */
  readonly name: 'label' | 'code';
  /**
   * Which rows the badge draws, in the order they matter — and so the order
   * they are given up in when the box will not hold them (see `ladder.ts`).
   */
  readonly ladder: readonly ShiftField[];
}

/**
 * Resolve one Shift widget's options against today's rota.
 *
 * `showFace` is *absence means on*: the photo has been drawn since the badge
 * existed, so a canvas arranged around it keeps it through a schema change and
 * only `false` is ever stored (see `widgetConfigBody`). The hours and the run
 * are no longer flags here — they are rows on the ladder, which is the single
 * place that says which rows exist and in what order; `shiftLadder` is what
 * still honours `showHours` / `showRun` for a widget saved before it.
 * `people` is the same "none chosen means all" the
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
    name: c['shiftName'] === 'code' ? 'code' : 'label',
    ladder: shiftLadder(config),
  };
}

/* ---------------------------------------------------------------- CLOCK --- */

export interface ClockWidgetView {
  /** The date line under the time. */
  readonly date: boolean;
  /**
   * Which clock to read the time in.
   *
   * `'follow'` is the household's own setting, which is what every clock has
   * drawn until now — so it is what an absent option resolves to, rather than a
   * value that has to be stored to mean the default.
   */
  readonly format: 'follow' | '12' | '24';
}

/**
 * Resolve one Clock widget's options.
 *
 * There is deliberately nothing here about seconds. The wall redraws every
 * fifteen seconds, so a seconds field would be wrong far more often than right
 * — and a clock that is confidently wrong is worse than one that is coarse.
 */
export function clockWidgetView(config?: unknown): ClockWidgetView {
  const c = read(config);
  const format = c['clockFormat'];
  return {
    date: c['showDate'] !== false,
    format: format === '12' || format === '24' ? format : 'follow',
  };
}

/* -------------------------------------------------------------- WEATHER --- */

export interface WeatherWidgetView {
  /** The days to draw, already capped. Empty means draw nothing. */
  readonly days: readonly WeatherDayModel[];
  /** The overnight low beside the high. */
  readonly low: boolean;
  /**
   * The forecast glyph.
   *
   * The wall's only: a panel's bitmap font is 0x20–0x7E and a weather glyph is
   * not in it, so a 1-bit frame has no icon to hide. Stated rather than left to
   * be discovered on a panel that quietly ignores the switch.
   */
  readonly icon: boolean;
}

/**
 * Resolve one Weather widget's options against the forecast it was given.
 *
 * `count` is how many days to draw, shared with the calendar's agenda — one
 * strict config object for every type, and a key a type does not read is simply
 * not read. Absent means every day the household's forecast setting supplies,
 * which is what a bare widget has always drawn.
 */
export function weatherWidgetView(
  days: readonly WeatherDayModel[],
  config?: unknown,
): WeatherWidgetView {
  const c = read(config);
  const wanted = count(c['count'], 50);
  return {
    days: wanted === undefined ? days : days.slice(0, wanted),
    low: c['showLow'] !== false,
    icon: c['showIcon'] !== false,
  };
}

/* --------------------------------------------------------- MODULE PANEL --- */

/**
 * How many rows of a module's panel to draw, or undefined for all of them.
 *
 * A module decides the shape of its own panel — `panelDataSchema` lets it send
 * up to twelve readings — and until now the household had no say in how many of
 * them landed on the wall. This is presentation of data the module already
 * sent: no new surface on the schema, and the module cannot tell the difference.
 */
export function panelRowLimit(config?: unknown): number | undefined {
  return count(read(config)['count'], 12);
}
