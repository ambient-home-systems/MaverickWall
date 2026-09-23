/**
 * Scheduled canvases: the rules a slot and a schedule have to satisfy
 * (RFC 014 §5.2).
 *
 * Pure, and the reason it is a file of its own is the reason `gutter.ts` and
 * `widget-style.ts` are: three callers — the layout POST, the wall's settings
 * handler and the manifest builder — each need the same answer to "is this a
 * slot name" and "does this window contain that moment", and one of them
 * holding a private copy is how two readers come to disagree. The display's
 * `canvas-schedule.ts` is the same window arithmetic on the other side of the
 * manifest; `daytimeActive` in the display's `theme.ts` is where it came
 * from, and the parity is asserted by test rather than assumed.
 */

/**
 * A slot's name: short, lower-case, a letter or digit first.
 *
 * It is a key rather than a label — it travels in the manifest, in the editor's
 * JSON and in a POST body — so it is the shape of a widget id rather than of a
 * sentence. The editor asks for the name and offers it back as typed, and
 * a household who wants "School run" gets `school-run` and sees it. The
 * default canvas has no name at all: it is `null` in the column and absent
 * from the manifest, so an unscheduled wall carries no key for it.
 */
export const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * How many *named* canvases one screen may hold, per orientation.
 *
 * Four, beside the default: a morning, an evening, a weekend and one spare is
 * every arrangement anybody has asked for, and a wall carrying every slot's
 * widgets in every manifest is one more reason not to let this grow by
 * accident. A bound in the schema would be a `CHECK` that cannot count rows,
 * so it is enforced where the slot is written and stated here.
 */
export const MAX_LAYOUT_SLOTS = 4;

/** How many schedule rows the settings form offers. One per slot is enough. */
export const MAX_SCHEDULE_ROWS = MAX_LAYOUT_SLOTS;

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isSlotName(value: unknown): value is string {
  return typeof value === 'string' && SLOT_NAME.test(value);
}

export function isHhmm(value: unknown): value is string {
  return typeof value === 'string' && HHMM.test(value);
}

export interface ScheduleRow {
  readonly slot: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Whether `hhmm` falls inside the window — wrapping past midnight when
 * `from > to`, and never for a window of no length.
 *
 * Character for character the arithmetic of the display's `daytimeActive`,
 * which is what decides the daylight theme: a schedule that read a window one
 * way while the theme read it another would swap the canvas and the colours
 * at different minutes on the same wall. `parseWindow` in `rule-templates.ts`
 * already refuses `from === to` for an interrupt rule on the same argument.
 */
export function windowContains(from: string, to: string, hhmm: string): boolean {
  if (from === to) return false;
  return from < to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

/**
 * The slot the schedule selects at `hhmm`, or undefined for the default.
 *
 * First row wins, in the order the household wrote them — two windows that
 * overlap are a choice the form lets through deliberately, because refusing
 * it costs a 400 on a settings page for a case the wall resolves perfectly
 * well, and an empty wall is the one answer this must never give.
 */
export function scheduledSlot(schedule: readonly ScheduleRow[], hhmm: string): string | undefined {
  for (const row of schedule) {
    if (windowContains(row.from, row.to, hhmm)) return row.slot;
  }
  return undefined;
}
