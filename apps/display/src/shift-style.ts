/**
 * How the calendar widget draws a rota, resolved once for both renderers.
 *
 * Three stored keys decide it — `showShifts`, `shiftStyle` and the widget's
 * view — and each of them is a value this project has already shipped read two
 * ways. `showShifts` used to be read by the wall alone and never by the panel;
 * `shifts[0]` was the month cell's whole idea of a rota while the badge drew
 * everybody; `mode` was `!== 'list'` on the wall and `=== 'month'` on the
 * panel. The cure each time was to resolve the value **once** and hand over the
 * answer, and this file is that resolution for the rota: the wall's
 * `render.ts` and the editor read it, and `epaper/shift-style.ts` is this file
 * transcribed for the panel, held character-identical by
 * `shift-style-parity.test.ts` — the seam `calendar-view.ts`, `tiers.ts` and
 * `month-spans.ts` already sit at, for the reason they sit there (the display
 * bundle has no bundler and the server cannot import from it).
 *
 * **Pure, and no DOM.** A decision taken inside a `createElement` call is a
 * decision nothing can check; every module beside this one in the bundle that
 * decides rather than draws is pure for the same reason.
 *
 * **The wall is the spec.** Where the two copies differ, this file is right.
 */

/**
 * The four looks a rota can take on a calendar (plan item P5.4).
 *
 *   tint   the day's cell washed in the shift's colour, with a rule along its
 *          top — what every wall has drawn since the rota existed, and so the
 *          absence
 *   label  the shift's short code as text in the date line, beside the numeral
 *   edge   the rule along the top of the cell alone, with no wash
 *   dot    a small disc beside the numeral
 *
 * The order is the editor's, tint first because it is the default. Stable once
 * shipped: a canvas stores one of these and two renderers read it.
 */
export const SHIFT_STYLES = ['tint', 'label', 'edge', 'dot'] as const;
export type ShiftStyle = (typeof SHIFT_STYLES)[number];

/** The calendar's views, as `calendarView` resolves them. */
export type CalendarShiftView = 'month' | 'week' | 'list';

/**
 * Which look a stored config asks for.
 *
 * Total, because it runs inside a draw: an absent, unknown or foreign value is
 * `tint`, which is what every wall drew before the key existed, so a canvas
 * saved before this shipped — or by a newer server naming a fifth look this
 * bundle has never heard of — draws exactly as it did (rule nine). The editor
 * stores the default as an *absence*, the way every default in this codebase
 * is stored, so `tint` is never written.
 */
export function shiftStyle(config: unknown): ShiftStyle {
  const c: Record<string, unknown> =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const raw = c['shiftStyle'];
  for (const style of SHIFT_STYLES) {
    if (style === raw) return style;
  }
  return 'tint';
}

/**
 * Whether this view draws the rota at all.
 *
 * Two readings of one key, and the difference is deliberate (open question Q2
 * of `docs/plan-2026-09-household-review.md`, built as proposed). On the month
 * grid and the agenda `showShifts` has meant *on* by its absence since the wall
 * was first drawn, so a household who arranged a canvas around those colours
 * keeps them: only `false` turns them off. The week views never drew a rota
 * until plan item P5.4 — so reading the same absence as *on* there would light
 * up rota colours on every week wall already hanging in a kitchen, on the day
 * of an upgrade nobody asked for. On a week view the rota draws only when
 * `showShifts` is **explicitly** `true`.
 *
 * The editor's switch reads this function and writes what it means for the
 * view it is on, so the control and the two renderers cannot disagree about
 * what an absence is.
 */
export function shiftsShown(config: unknown, view: CalendarShiftView): boolean {
  const c: Record<string, unknown> =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const raw = c['showShifts'];
  if (view === 'week') return raw === true;
  return raw !== false;
}

/**
 * One person's shift on one day, as much of it as a mark needs.
 *
 * `initial` is the person's, `code` the shift's — "A" and "D" for Amy on days.
 * Both renderers receive these already resolved; neither derives an initial
 * from a name, because two renderers deriving one is two answers.
 */
export interface ShiftMark {
  readonly initial: string;
  readonly code: string;
}

/**
 * The words a `label` may carry for these people, longest form first.
 *
 * One person is their shift's code alone: "D". Two or more are told apart by
 * initial — "A·D B·N" — because two people on days would otherwise read "D D",
 * which says how many are working and not who. When the date line cannot hold
 * that whole, the codes alone are the shorter form: "D N" still names both
 * shifts and loses only whose is whose, where cutting "A·D B·N" to "A·D B" is
 * a different string (this project's own rule about truncation, `CLAUDE.md`).
 * A renderer draws the **first form that fits whole** in the room its numeral
 * leaves, and nothing when none does — the tier table's rule for a name, one
 * mark along.
 *
 * `separator` is between an initial and its code, and is the caller's because
 * the two alphabets differ: the wall draws a middle dot, and the panel's
 * bitmap face is ASCII and draws a colon — the same substitution its shift
 * line already makes for the wall's en dash.
 */
export function shiftLabelForms(marks: readonly ShiftMark[], separator: string): readonly string[][] {
  if (marks.length === 0) return [];
  if (marks.length === 1) return [[marks[0]!.code]];
  return [marks.map((mark) => `${mark.initial}${separator}${mark.code}`), marks.map((mark) => mark.code)];
}

/**
 * How many dots the `dot` look draws for these people.
 *
 * Three at most, the month grid's own limit for its event dots: beyond that the
 * count stops being countable at a glance and the cell only needs to read as
 * "several". The renderer draws the first `n` people's colours.
 */
export const SHIFT_DOTS_MAX = 3;

export function shiftDotCount(marks: readonly ShiftMark[]): number {
  return Math.min(SHIFT_DOTS_MAX, marks.length);
}

/**
 * A person's initial for a mark — the first character of their name, upper
 * case, or nothing for a blank name.
 *
 * One character rather than the badge's two-letter monogram, because a mark
 * is read beside a one-letter shift code and "AM·D" reads as a third code.
 * `Array.from` rather than `charAt`, so a name that starts with a character
 * outside the basic plane is not split in half.
 */
export function markInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? '' : first.toUpperCase();
}
