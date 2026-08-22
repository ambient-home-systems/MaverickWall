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
 * It replaces private opinions that lived in the renderers and that nobody
 * outside the source could see or change: `box.h >= 44` in `epaper/widgets.ts`,
 * which decided when a shift card became a compact line, and the implicit "these
 * rows, in this order, always" in the shift badge and the forecast strip.
 *
 * Two widgets have one so far and their shapes are different, which is the
 * point: a shift badge is one card of rows, and a forecast is a strip of days
 * whose ladder applies inside each column. The model does not care.
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

/**
 * A stored ladder, filtered to the fields this widget can actually draw.
 *
 * Shared by every widget's resolver: the config object is one strict shape for
 * all types (see `widgetConfigBody`), so a Weather widget carrying a Shift
 * field — a canvas whose widget was retyped, or a hand-edited row — must read
 * as "not for me" rather than as a row nothing can render. Duplicates are
 * dropped, exactly as `parseBlocks` treats a repeated block name.
 */
function storedLadder<F extends string>(
  stored: unknown,
  allowed: readonly F[],
): readonly F[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const seen: F[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'string') continue;
    const field = allowed.find((name) => name === entry);
    if (field !== undefined && !seen.includes(field)) seen.push(field);
  }
  return seen.length > 0 ? seen : undefined;
}

const asConfig = (config: unknown): Record<string, unknown> =>
  typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};

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
  const c = asConfig(config);
  const stored = storedLadder(c['fields'], SHIFT_FIELDS);
  if (stored !== undefined) return stored;

  return DEFAULT_SHIFT_LADDER.filter((field) => {
    if (field === 'hours') return c['showHours'] !== false;
    if (field === 'run') return c['showRun'] !== false;
    return true;
  });
}

/* -------------------------------------------------------------- WEATHER --- */

/**
 * The rows one day of the forecast can draw. Stable for ever once shipped.
 *
 * A ladder for a widget whose shape is a *strip of days* rather than one card:
 * it applies inside each day's column, so reordering moves the same rows in
 * every column and dropping gives up the same row in every column. How many
 * days there are is `count`, a separate question and a different axis.
 */
export const WEATHER_FIELDS = ['name', 'icon', 'high', 'low'] as const;
export type WeatherField = (typeof WEATHER_FIELDS)[number];

export const WEATHER_ROLES: Readonly<Record<WeatherField, LadderRole>> = {
  name: 'kicker',
  icon: 'body',
  high: 'headline',
  low: 'small',
};

/** The strip every wall already drew: the day, its glyph, then its two numbers. */
export const DEFAULT_WEATHER_LADDER: readonly WeatherField[] = ['name', 'icon', 'high', 'low'];

/**
 * The stored weather ladder, or the one the old switches describe.
 *
 * `showIcon` / `showLow` are to this what `showHours` / `showRun` are to the
 * shift badge: absence-means-on switches that predate the list, honoured here so
 * a widget nobody has touched keeps drawing what it drew.
 */
export function weatherLadder(config?: unknown): readonly WeatherField[] {
  const c = asConfig(config);
  const stored = storedLadder(c['fields'], WEATHER_FIELDS);
  if (stored !== undefined) return stored;

  return DEFAULT_WEATHER_LADDER.filter((field) => {
    if (field === 'icon') return c['showIcon'] !== false;
    if (field === 'low') return c['showLow'] !== false;
    return true;
  });
}

/**
 * Whether the high and the low share a line.
 *
 * They do when they are next to each other, because a temperature *range* reads
 * as one thing — "24° 13°C" is how the strip has always drawn it, and splitting
 * it would re-typeset every wall already hanging in a kitchen for the sake of a
 * uniform rule nobody asked for. Separate them in the list and they separate on
 * the wall, which is the household saying they want them apart.
 *
 * Deliberately about adjacency and not about which is first: a household who
 * puts the low before the high gets "13°C 24°", still one line, still a range.
 */
export function pairsTemperatures(ladder: readonly WeatherField[]): boolean {
  const high = ladder.indexOf('high');
  const low = ladder.indexOf('low');
  return high >= 0 && low >= 0 && Math.abs(high - low) === 1;
}

/* ---------------------------------------------------------------- HOUSE --- */

/**
 * The parts of one Home Assistant reading.
 *
 * A third shape again: the shift badge is one card, the forecast is a strip of
 * days, and this is a list whose *length* belongs to the household rather than
 * to the widget — they choose the entities on the Home Assistant screen, and
 * `readings` picks which of those this widget shows. The ladder is what each
 * one says, not how many there are.
 */
export const HOUSE_FIELDS = ['icon', 'label', 'value'] as const;
export type HouseField = (typeof HOUSE_FIELDS)[number];

export const HOUSE_ROLES: Readonly<Record<HouseField, LadderRole>> = {
  icon: 'body',
  label: 'kicker',
  value: 'headline',
};

/**
 * What each `display_mode` means, as a ladder.
 *
 * This is not a new idea layered over the old one — it is the old one written
 * down. `display_mode` is a per-entity setting with four named shapes, and
 * until now what each shape *drew* lived in two `if` statements inside
 * `renderHouse` and nowhere else. The panel never read it at all: every mode
 * came out as "label: value", so a reading the household set to `value` said
 * `Locked` on the wall and `Front door: Locked` on a panel. One stored value,
 * two renderers, two answers — the same fault as `shifts[0]`, and the reason
 * this table exists rather than a second setting.
 *
 * An unknown mode falls back to `label_value`, which is the column's default.
 */
export const HOUSE_MODE_LADDERS: Readonly<Record<string, readonly HouseField[]>> = {
  value: ['value'],
  label_value: ['label', 'value'],
  icon_state: ['icon', 'label', 'value'],
  presence: ['icon', 'label', 'value'],
};

/**
 * The ladder one reading draws, from the widget's list or from its own mode.
 *
 * `fields` present is authoritative *for every reading in the widget*, which is
 * the trade the household makes by touching it: a per-widget list cannot
 * express per-entity shapes, so writing one flattens them. Leave it alone and
 * each reading keeps the mode set on the Home Assistant screen — which is what
 * every wall does today, and what a panel will now do for the first time.
 */
export function houseLadder(config: unknown, mode: string): readonly HouseField[] {
  const stored = storedLadder(asConfig(config)['fields'], HOUSE_FIELDS);
  if (stored !== undefined) return stored;
  return HOUSE_MODE_LADDERS[mode] ?? HOUSE_MODE_LADDERS['label_value'] ?? HOUSE_FIELDS;
}

/* ------------------------------------------------------------- RESOLVING --- */

/** One resolved row: a field, how loudly to draw it, and what it says. */
export interface LadderRow<F extends string = string> {
  readonly field: F;
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
export function ladderRows<F extends string>(
  ladder: readonly F[],
  values: Readonly<Partial<Record<F, string>>>,
  roles: Readonly<Record<F, LadderRole>>,
): readonly LadderRow<F>[] {
  const rows: LadderRow<F>[] = [];
  for (const field of ladder) {
    const text = values[field];
    if (text === undefined || text === '') continue;
    rows.push({ field, role: roles[field], text });
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
export function dropToFit<F extends string>(
  rows: readonly LadderRow<F>[],
  budget: number,
  heightOf: (role: LadderRole) => number,
): readonly LadderRow<F>[] {
  let kept = rows;
  while (kept.length > 1) {
    const total = kept.reduce((sum, row) => sum + heightOf(row.role), 0);
    if (total <= budget) break;
    kept = kept.slice(0, -1);
  }
  return kept;
}
