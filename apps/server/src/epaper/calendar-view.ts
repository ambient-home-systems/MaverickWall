/**
 * How a calendar widget's stored config becomes a view and a density —
 * `apps/display/src/widget-views.ts` transcribed, and nothing else.
 *
 * **Written twice because it has to be.** The display bundle has no
 * dependencies and no bundler — plain `tsc` output with `rootDir` pinned to its
 * own `src` — so it cannot import from here, and a test here cannot import from
 * it without falling outside `tsconfig.test.json`'s root. The ladder has the
 * same seam for the same reason, and the same guard:
 * `calendar-view-parity.test.ts` reads *both* files and compares what each one
 * actually says, in both directions.
 *
 * The parity matters more here than almost anywhere, because this project has
 * already shipped the fault it prevents. The wall read `mode !== 'list'` and
 * this renderer read `mode === 'month'`; the editor stores the default view by
 * *leaving the key out*, so the commonest setting — the one nobody changes —
 * fell through, and all three of the panel's "Show as" values drew the same
 * thing. The household's report was "the calendar settings have no impact".
 * **The wall is the spec**; this is a copy of the wall's reading and must never
 * become a second opinion about it.
 *
 * The panel deliberately does *nothing* with the density half — see
 * `drawCalendarWidget`, and `PANEL_IGNORES` in `honours.ts`, which is where a
 * household is told so.
 */

export const CALENDAR_VIEWS = ['month', 'week', 'list'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const CALENDAR_DENSITIES = ['comfortable', 'compact'] as const;
export type CalendarDensity = (typeof CALENDAR_DENSITIES)[number];

/**
 * What a `mode` written before the split meant, in the two axes it turned out
 * to be. Read-only history: nothing writes these and no migration rewrites the
 * canvases holding them, so a wall hung before the split keeps drawing what it
 * drew that day, for ever.
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
 * Total, because it runs inside a draw: anything it cannot make sense of is the
 * default rather than an exception on a panel bolted to a wall (rule nine). A
 * legacy `mode` answers both halves and ignores any `density` beside it — the
 * old value *is* a pair, and taking half of it from a newer key is exactly how
 * two readers end up disagreeing.
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
