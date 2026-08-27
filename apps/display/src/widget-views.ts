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
  /*
   * Calendar. Three views, and the two that used to sit beside them were never
   * a fourth and fifth thing to draw — see `CALENDAR_VIEWS` below.
   */
  calendar: [
    { value: 'month', label: 'Month grid' },
    { value: 'week', label: 'Week columns' },
    { value: 'list', label: 'Upcoming list' },
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

/* ------------------------------------- the calendar's view and its density ---- */

/**
 * The three things a Calendar widget can be.
 *
 * There were five, and two of them were the same view wearing a second name:
 * `skymonth` drew the month grid and `skyweek` the week columns, edge to edge
 * with hairline rules instead of gaps and cards. That is not a choice about
 * *what* you see — it is a choice about how much room the calendar spends on
 * itself, and offering it as a view meant a household picked between "Month
 * grid" and "Sky month" with nothing on screen saying that one of them draws
 * more events a day and the other draws them larger.
 *
 * Measured on a 1080x1920 wall, the dense pair also sits under this project's
 * own 22px type floor — a median of 19.2px on the month, a minimum of 18.2px on
 * the week. That is the trade, and it is a real one worth offering; it is not a
 * different calendar, and naming it as one hid the cost.
 *
 * So: three views on one axis, two densities on another. Same renderers, same
 * pixels — `month` + `compact` *is* what `skymonth` always drew.
 */
export const CALENDAR_VIEWS = ['month', 'week', 'list'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/**
 * How much room the calendar spends on itself.
 *
 * `comfortable` is cards, gaps and breathing room; `compact` gives all three up
 * for more of the household's week in the same box. The default is
 * `comfortable`, and — like every default in this codebase — it is stored by
 * **leaving the key out**.
 */
export const CALENDAR_DENSITIES = ['comfortable', 'compact'] as const;
export type CalendarDensity = (typeof CALENDAR_DENSITIES)[number];

/**
 * What a `mode` written before the split meant, in the two axes it turned out
 * to be.
 *
 * Read-only history: nothing writes these values any more, and no migration
 * rewrites the canvases that hold them. A wall hanging in somebody's kitchen
 * stores `skymonth` and will store it for ever — mapping it here, at the read
 * boundary, is what keeps it drawing exactly what it drew the day it was hung.
 * The alternative, a migration that rewrites a stored canvas, is a change to
 * somebody's arrangement made while they were not looking, and it can only be
 * got wrong once.
 */
export const LEGACY_CALENDAR_VIEW: Readonly<Record<string, string>> = {
  skymonth: 'month',
  skyweek: 'week',
};

export const LEGACY_CALENDAR_DENSITY: Readonly<Record<string, string>> = {
  skymonth: 'compact',
  skyweek: 'compact',
};

export interface CalendarShape {
  readonly view: CalendarView;
  readonly density: CalendarDensity;
}

/**
 * One stored config, read as the pair it means — the *only* reading, on either
 * screen.
 *
 * `epaper/calendar-view.ts` is this function transcribed, because the display
 * bundle has no bundler and the server cannot import from it (the same seam as
 * `ladder.ts`), and `calendar-view-parity.test.ts` reads both files and holds
 * them to each other. That test exists because of a bug this project has
 * already shipped once: the wall read `mode !== 'list'` while the panel read
 * `mode === 'month'`, so the commonest setting — the default, which nobody
 * stores — fell through, and all three of the panel's calendar settings drew
 * the same thing. **The wall is the spec**, and this is the wall's reading.
 *
 * Total, because it runs inside a draw: anything it cannot make sense of is the
 * default rather than an exception on the one screen the household is looking
 * at (rule nine). A legacy `mode` answers both halves and ignores any `density`
 * beside it — the old value *is* a pair, and taking half of it from a newer key
 * is exactly how two readers end up disagreeing. The editor never writes such a
 * contradiction: it writes both keys or neither.
 */
export function calendarView(config: unknown): CalendarShape {
  const c: Record<string, unknown> =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const mode = typeof c['mode'] === 'string' ? c['mode'] : '';

  const legacy = LEGACY_CALENDAR_VIEW[mode];
  if (legacy !== undefined) {
    return {
      view: legacy as CalendarView,
      density: (LEGACY_CALENDAR_DENSITY[mode] ?? 'comfortable') as CalendarDensity,
    };
  }

  // An absent, unknown or foreign `mode` is the month grid — the default is an
  // absence, and `people` (the Chores widget's board, which shares this key)
  // has never been a calendar view.
  const view = (CALENDAR_VIEWS as readonly string[]).includes(mode)
    ? (mode as CalendarView)
    : 'month';
  const density: CalendarDensity = c['density'] === 'compact' ? 'compact' : 'comfortable';
  return { view, density };
}

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
 *
 * It takes the whole config rather than the `mode` off it, because for a
 * calendar the view is not the stored string: a canvas holding `skymonth` is a
 * *Month grid* drawn compactly, and `calendarView` is the one place that is
 * decided. Reading the raw value would have landed on the right label here by
 * the accident of the unknown-means-default fallback above, and that is the
 * kind of accident this file exists to remove.
 */
export function viewLabel(type: string, config: unknown): string | undefined {
  const views = WIDGET_VIEWS[type] ?? [];
  if (views.length < 2) return undefined;
  if (type === 'calendar') {
    const { view } = calendarView(config);
    return views.find((one) => one.value === view)?.label;
  }
  const c: Record<string, unknown> =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const value = typeof c['mode'] === 'string' ? c['mode'] : '';
  return (views.find((view) => view.value === value) ?? views[0])?.label;
}
