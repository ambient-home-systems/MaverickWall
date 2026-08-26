/**
 * What each widget type can draw, as data.
 *
 * Kept out of `layout-editor.ts` because it is a fact about the widgets rather
 * than about the editor: the panel designer reads the same table, a widget
 * editor would edit it, and a test can check it against the renderers without
 * booting a DOM. Pure — no imports, nothing to run.
 */

/**
 * The views each widget type can draw, first one being its default.
 *
 * A *view* is which renderer draws the widget — Month grid or Upcoming list —
 * and it is content, not styling: it decides what you see, a month of days or
 * the next few events, rather than how the box is painted. That is why it sits
 * on the Content tab and why it is not called "Style": Style is the box (its
 * title, alignment, background, corners, shadow), and having two of those words
 * in one panel is what made this confusing to read.
 *
 * Calendar is the only type with more than one today; the other nine have
 * exactly one renderer each, so their view is *stated* rather than offered as a
 * dropdown that cannot be changed. It becomes a real picker the day a second
 * view exists — which is the seam a widget editor would build on, and the
 * reason every type declares its view here even when it only has one.
 *
 * The first entry's value is stored as an absence, the way `mode` always has
 * been, so nothing about what is written to a canvas changed.
 */
export interface WidgetView {
  readonly value: string;
  readonly label: string;
}

export const WIDGET_VIEWS: Readonly<Record<string, readonly WidgetView[]>> = {
  clock: [{ value: '', label: 'Time and date' }],
  calendar: [
    { value: 'month', label: 'Month grid' },
    { value: 'week', label: 'Week columns' },
    { value: 'list', label: 'Upcoming list' },
    { value: 'skyweek', label: 'Sky week' },
    { value: 'skymonth', label: 'Sky month' },
  ],
  weather: [{ value: '', label: 'Forecast strip' }],
  homeassistant: [{ value: '', label: 'Readings list' }],
  shift: [{ value: '', label: 'Today\u2019s shift' }],
  countdown: [{ value: '', label: 'Days remaining' }],
  notes: [{ value: '', label: 'Note' }],
  todo: [{ value: '', label: 'Checklist' }],
  /*
   * Chores. The default is stored as an *absence*, like every other type's, and
   * both renderers have to read it that way — the wall's `renderChoresWidget`
   * and the panel's `drawChores`. The e-paper calendar shipped with those two
   * disagreeing (`mode === 'month'` against a default nobody stores), so all
   * three of its settings drew the same thing. `week` is deliberately the same
   * spelling the calendar uses for seven days across.
   */
  chores: [
    { value: '', label: 'Today' },
    { value: 'people', label: 'By person' },
    { value: 'week', label: 'This week' },
  ],
  image: [{ value: '', label: 'Picture' }],
  external: [{ value: '', label: 'Module panel' }],
};

/**
 * Which view a widget is set to, in words — or nothing, when naming it would
 * say nothing.
 *
 * Two Calendars on a canvas were both labelled "Calendar", on the box and in
 * the Layers list, with the month grid and the upcoming list indistinguishable
 * until you selected one and read its Content tab. The name a household reads
 * has to carry the difference, and the difference is already declared here.
 *
 * A type with one view answers nothing rather than repeating itself: "Clock —
 * Time and date" is a longer way of writing "Clock", and on a 10px chip inside
 * a narrow box the length is the whole cost. An unknown or dropped `mode` reads
 * as the default, which is how the renderers read it — the default is stored as
 * an absence, so "not one of these" and "not set" are the same answer.
 */
export function viewLabel(type: string, mode: unknown): string | undefined {
  const views = WIDGET_VIEWS[type] ?? [];
  if (views.length < 2) return undefined;
  const value = typeof mode === 'string' ? mode : '';
  return (views.find((view) => view.value === value) ?? views[0])?.label;
}
