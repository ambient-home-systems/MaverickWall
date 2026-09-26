/**
 * Which calendars a calendar widget draws — `apps/display/src/calendar-filter.ts`
 * transcribed, and nothing else.
 *
 * **Written twice because it has to be.** The display bundle has no
 * dependencies and no bundler, so it cannot import from here, and a test here
 * cannot import from it without falling outside `tsconfig.test.json`'s root.
 * `shift-style.ts`, `tiers.ts` and `month-spans.ts` have the same seam and the
 * same guard: `calendar-filter-parity.test.ts` reads *both* files and holds
 * everything from the first declaration on to being character-identical.
 *
 * It matters because the month grid used to ignore the widget's "Which
 * calendars" on both renderers and the compact month read it on one: a panel
 * following a wall must draw the same month, and the same month now means the
 * same calendars in it (plan item P5.4, part 5). **The wall is the spec**; this
 * is a copy of the wall's reading and must never become a second opinion.
 */

/**
 * The calendars a widget's config names, by source id — empty when it names
 * none, which means every calendar, the same "empty selection means all" the
 * reading and people pickers use.
 *
 * Total: anything that is not an array of strings is no selection, so a
 * canvas from a newer or older server draws every calendar rather than none.
 */
export function calendarsOf(config: unknown): readonly string[] {
  const c: Record<string, unknown> =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const raw = c['calendars'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

/**
 * How many events each calendar has on one day, from the day's whole list.
 *
 * Taken before the model caps its slim list, so a day with twenty events can
 * still say how many of them are on the one calendar a widget keeps.
 */
export function countBySource(events: readonly { readonly sourceId: string }[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.sourceId, (counts.get(event.sourceId) ?? 0) + 1);
  return counts;
}

/** One day's cell, as much of it as a filter reads. */
export interface FilterableCell {
  readonly eventCount: number;
  readonly sourceCounts: ReadonlyMap<string, number>;
  readonly events: readonly { readonly sourceId: string }[];
}

/**
 * The cell with only the kept calendars' events, and a total that counts only
 * them.
 *
 * An empty selection returns the cell itself — not a copy — so a widget that
 * picked nothing draws from exactly the object it always drew from, and the
 * month a household has not filtered cannot move by a pixel.
 */
export function keepCalendars<C extends FilterableCell>(cell: C, calendars: readonly string[]): C {
  if (calendars.length === 0) return cell;
  let eventCount = 0;
  // Each calendar once, so a selection that names one twice counts it once.
  calendars.forEach((id, at) => {
    if (calendars.indexOf(id) === at) eventCount += cell.sourceCounts.get(id) ?? 0;
  });
  const events = cell.events.filter((event) => calendars.indexOf(event.sourceId) >= 0);
  return { ...cell, eventCount, events };
}
