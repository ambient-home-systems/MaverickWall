/**
 * The field ladder: what a widget says, in the order it matters.
 *
 * A widget's content is an *ordered list of fields*, and the order carries two
 * meanings at once: it is the order they are drawn in, and it is the order they
 * are given up in when the box cannot hold them all. Nothing here is a
 * breakpoint. The household says what matters most; every screen — a phone-sized
 * kiosk, a 65" television, a 7.5" panel, a box dragged smaller yesterday —
 * resolves that same list against the room it actually has.
 *
 * It replaces two private opinions that lived in the renderers and that nobody
 * outside the source could see or change: `box.h >= 44` in `epaper/widgets.ts`,
 * which decided when a shift card became a compact line, and the implicit "the
 * badge draws these four rows in this order, always" on the wall.
 *
 * **It is deliberately not a language.** A ladder is an ordered subset of a
 * fixed, per-widget allowlist of field names — the same shape as
 * `display_blocks` one level down. There is no expression, no concatenation,
 * and no household-authored string that reaches a renderer. That is the same
 * argument the recipe engine's transform makes, and it is what keeps the
 * highest-prominence text on the wall bounded.
 *
 * **The emphasis is a property of the field, not of its position.** A person's
 * name is a kicker whether it is first or third, and the shift's name is the
 * headline wherever it sits. Deriving size from position would read better in a
 * demo and worse on a wall: it would silently re-typeset every badge already
 * hanging in a kitchen the moment somebody reordered anything, and it would
 * make "put the hours first" mean "draw the hours enormous", which is not what
 * anybody asking for it wants.
 *
 * The eInk renderer keeps its own copy of the table below, because the display
 * bundle has no dependencies and no bundler and so cannot share a module with
 * the server. `epaper-ladder-parity.test.ts` reads both files and refuses to
 * let them drift — the journal-parity idiom, applied to a table instead of a
 * directory.
 */

/** The rows a shift badge can draw. Stable for ever once shipped: stored. */
export const SHIFT_FIELDS = ['person', 'shift', 'hours', 'run'] as const;
export type ShiftField = (typeof SHIFT_FIELDS)[number];

/**
 * How prominently each row is drawn.
 *
 * Four steps rather than a size, because the two renderers measure in different
 * units — the wall in `rem` against its canvas, the panel in `GLYPH_SIZE` times
 * an integer scale — and a number here would mean neither.
 */
export type LadderRole = 'kicker' | 'headline' | 'body' | 'small';

export const SHIFT_ROLES: Readonly<Record<ShiftField, LadderRole>> = {
  person: 'kicker',
  shift: 'headline',
  hours: 'body',
  run: 'small',
};

/**
 * The ladder every shift badge drew before there was a ladder.
 *
 * An untouched widget must resolve to exactly this, so a wall arranged before
 * the feature existed is unchanged by it (rule nine, and the same
 * absence-means-the-old-behaviour rule the `show…` switches follow).
 */
export const DEFAULT_SHIFT_LADDER: readonly ShiftField[] = ['person', 'shift', 'hours', 'run'];

const isShiftField = (value: unknown): value is ShiftField =>
  typeof value === 'string' && (SHIFT_FIELDS as readonly string[]).includes(value);

/**
 * Read a stored ladder, or derive one from the switches that predate it.
 *
 * `fields` is authoritative when present: it is the complete list of rows, in
 * order. When it is absent the ladder is the default one minus whatever
 * `showHours` / `showRun` turned off — which is how a widget saved before this
 * existed keeps drawing what it drew. The editor writes `fields` and clears
 * those two switches the first time somebody touches the ladder, so a widget is
 * described one way or the other and never half in each.
 *
 * Read defensively throughout: the server validates what it stores, but a wall
 * can be a version ahead of its server or drawing a document out of IndexedDB.
 * An unknown field name is dropped rather than passed to a renderer with no arm
 * for it, and a list that resolves to nothing falls back to the default —
 * an empty badge is a hole in the wall, and an empty list is far more likely to
 * be a mistake than a household asking for a blank box.
 */
export function shiftLadder(config?: unknown): readonly ShiftField[] {
  const c = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const stored = c['fields'];

  if (Array.isArray(stored)) {
    const seen: ShiftField[] = [];
    for (const entry of stored) {
      // Duplicates are dropped rather than drawn twice, exactly as `parseBlocks`
      // treats a repeated block name.
      if (isShiftField(entry) && !seen.includes(entry)) seen.push(entry);
    }
    if (seen.length > 0) return seen;
  }

  return DEFAULT_SHIFT_LADDER.filter((field) => {
    if (field === 'hours') return c['showHours'] !== false;
    if (field === 'run') return c['showRun'] !== false;
    return true;
  });
}

/** One resolved row: a field, how loudly to draw it, and what it says. */
export interface LadderRow {
  readonly field: ShiftField;
  readonly role: LadderRole;
  readonly text: string;
}

/**
 * The ladder against the data there actually is.
 *
 * A field the day has nothing for is dropped here rather than drawn empty — an
 * untimed shift has no hours, and a run the server could not establish has no
 * position. That is not the same as the household switching it off, and neither
 * is it a gap in the badge.
 */
export function ladderRows(
  ladder: readonly ShiftField[],
  values: Readonly<Partial<Record<ShiftField, string>>>,
): readonly LadderRow[] {
  const rows: LadderRow[] = [];
  for (const field of ladder) {
    const text = values[field];
    if (text === undefined || text === '') continue;
    rows.push({ field, role: SHIFT_ROLES[field], text });
  }
  return rows;
}

/**
 * Give up rows from the bottom until what is left fits.
 *
 * Pure arithmetic over a budget and a per-role height, so each renderer supplies
 * its own metrics and this stays testable without a DOM or a framebuffer — the
 * same reason `domain/interrupts` takes `now` rather than reading a clock.
 *
 * **The first row always survives**, however small the box. A widget that
 * resolves to nothing is the one outcome rule nine forbids, and a household who
 * dragged a box too small should see the thing they put at the top of the list,
 * clipped if it comes to that, rather than an empty rectangle.
 */
export function dropToFit(
  rows: readonly LadderRow[],
  budget: number,
  heightOf: (role: LadderRole) => number,
): readonly LadderRow[] {
  let kept = rows;
  while (kept.length > 1) {
    const total = kept.reduce((sum, row) => sum + heightOf(row.role), 0);
    if (total <= budget) break;
    kept = kept.slice(0, -1);
  }
  return kept;
}
