/**
 * Which of a household's calendars a calendar widget draws, resolved once for
 * both renderers (plan item P5.4, part 5).
 *
 * "Which calendars" was offered on the week and the agenda and not on the
 * month, and the month grid ignored it on both renderers — so the two agreed,
 * by both saying nothing. The compact month read it and the comfortable one did
 * not, which is one stored value drawn two ways on one wall. The month honours
 * it now, on the wall and on a panel, and this is the one reading both apply:
 * `render.ts` filters the grid through it and `epaper/calendar-filter.ts` is
 * this file transcribed, held character-identical by
 * `calendar-filter-parity.test.ts` — the seam `shift-style.ts`, `tiers.ts` and
 * `month-spans.ts` already sit at, because the display bundle has no bundler
 * and the server cannot import from it.
 *
 * **The count is the half that needed a model change.** A cell carries a slim
 * list of its events (twelve on the wall) and the day's true total beside it,
 * which is what "+N" and the density mark read. Filtering the slim list alone
 * would leave the total counting calendars the household took off — a "+3" for
 * three events on a calendar nobody asked to see — and a day with more events
 * than the list carries could not be counted from the list at all. So a cell
 * carries its total **per calendar**, and the filtered total is the sum over
 * the calendars kept.
 *
 * Per-calendar `show_in_grid` is untouched and applies first, household-wide,
 * in the model: this is the widget's own choice, layered on top.
 *
 * Pure, and no DOM, for the reason every deciding module in this bundle is.
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
