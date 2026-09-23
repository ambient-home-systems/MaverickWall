/**
 * Which of a wall's canvases the clock selects (RFC 014 §5.2).
 *
 * A wall may hold several named canvases per orientation — a school-morning
 * arrangement from 06:30 to 08:30, the everyday one otherwise — and the
 * manifest carries every one of them with the schedule that picks between
 * them, for the reason it carries both orientations: the wall has to draw the
 * right one *offline*, from its stored copy, at the moment the clock crosses
 * the boundary. So the choice is made here, on every fifteen-second tick,
 * against the wall's corrected clock in the household's zone — and never on
 * the server, which does not know when the next tick is.
 *
 * Pure and DOM-free, the way `widget-options.ts`, `ink.ts`, `ladder.ts` and
 * `orientation.ts` are, so the boundary arithmetic can be asked one minute
 * either side of a window without a browser. `pickCanvas` in `main.ts` is the
 * caller: it takes the slot from here, the widgets from here, and keeps the
 * geometry — the aspect and the background — from the orientation's own
 * canvas, because a schedule picks *within* an orientation and never between
 * them.
 *
 * Every reader here is defensive, because the second caller is the copy read
 * out of IndexedDB, which `store.load()` deliberately does not shape-check: a
 * manifest written by an older bundle carries no `slots` at all, and one
 * written by a newer server could carry a shape this bundle has never seen.
 * Anything unreadable is "no schedule", which draws the default — rule nine.
 */

import type { ManifestWidget } from './manifest.js';

export interface ScheduleRow {
  readonly slot: string;
  readonly from: string;
  readonly to: string;
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Whether `hhmm` falls inside the window — wrapping past midnight when
 * `from > to`, and never for a window of no length.
 *
 * The same arithmetic as `daytimeActive` in `theme.ts`, which is what decides
 * the daylight theme, and `canvas-schedule.test.ts` holds the two to one
 * answer at every minute of the day: a schedule that read a window one way
 * while the theme read it another would swap the canvas and the colours at
 * different minutes on the same wall.
 */
export function windowContains(from: string, to: string, hhmm: string): boolean {
  if (from === to) return false;
  return from < to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

/** The schedule rows this bundle can read, in the order they were written. */
export function readSchedule(raw: unknown): ScheduleRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: ScheduleRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { slot?: unknown; from?: unknown; to?: unknown };
    if (typeof row.slot !== 'string' || row.slot === '') continue;
    if (typeof row.from !== 'string' || !HHMM.test(row.from)) continue;
    if (typeof row.to !== 'string' || !HHMM.test(row.to)) continue;
    rows.push({ slot: row.slot, from: row.from, to: row.to });
  }
  return rows;
}

/**
 * The slot the schedule selects at `hhmm`, or undefined for the default.
 *
 * First row wins, in the household's order: two overlapping windows are a
 * choice the settings page lets through, because the alternative is a 400 on
 * a form for a case the wall resolves perfectly well.
 */
export function scheduledSlot(schedule: unknown, hhmm: string): string | undefined {
  for (const row of readSchedule(schedule)) {
    if (windowContains(row.from, row.to, hhmm)) return row.slot;
  }
  return undefined;
}

/**
 * The named canvas's widgets on this orientation, or undefined when the slot
 * has no canvas there — which is the caller's cue to draw the default slot's
 * canvas for that orientation, and never a blank.
 *
 * `undefined` rather than `[]` for an *empty* slot canvas too: a household
 * who made a "morning" canvas in portrait and never arranged landscape did not
 * ask for an empty landscape wall between 06:30 and 08:30.
 */
export function slotWidgets(
  slots: unknown,
  orientation: 'portrait' | 'landscape',
  slot: string,
): readonly ManifestWidget[] | undefined {
  if (!Array.isArray(slots)) return undefined;
  for (const entry of slots) {
    if (typeof entry !== 'object' || entry === null) continue;
    const named = entry as { slot?: unknown; portrait?: unknown; landscape?: unknown };
    if (named.slot !== slot) continue;
    const canvas = named[orientation];
    if (typeof canvas !== 'object' || canvas === null) return undefined;
    const widgets = (canvas as { widgets?: unknown }).widgets;
    if (!Array.isArray(widgets) || widgets.length === 0) return undefined;
    return widgets as readonly ManifestWidget[];
  }
  return undefined;
}
