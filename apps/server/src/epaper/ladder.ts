/**
 * The field ladder, as the panel reads it.
 *
 * **A transcription of `apps/display/src/ladder.ts`, not a variation on it.**
 * The display bundle has no dependencies and no bundler — it is plain `tsc`
 * output served to a browser, with `rootDir` pinned to its own `src` — so it
 * cannot import a shared module and neither can this import from it without
 * breaking `tsconfig.test.json`'s typecheck. Two copies is the cost of that,
 * and `epaper-ladder-parity.test.ts` is what stops them drifting: it reads both
 * files and compares the tables, in both directions, the way
 * `migration-upgrade.test.ts` compares the migrations directory with its
 * journal.
 *
 * Read that file for what a ladder is and why it is an ordered allowlist rather
 * than a template. This one only says how a 1-bit panel resolves it.
 */

export const SHIFT_FIELDS = ['person', 'shift', 'hours', 'run'] as const;
export type ShiftField = (typeof SHIFT_FIELDS)[number];

export type LadderRole = 'kicker' | 'headline' | 'body' | 'small';

export const SHIFT_ROLES: Readonly<Record<ShiftField, LadderRole>> = {
  person: 'kicker',
  shift: 'headline',
  hours: 'body',
  run: 'small',
};

export const DEFAULT_SHIFT_LADDER: readonly ShiftField[] = ['person', 'shift', 'hours', 'run'];

export const WEATHER_FIELDS = ['name', 'icon', 'high', 'low'] as const;
export type WeatherField = (typeof WEATHER_FIELDS)[number];

export const WEATHER_ROLES: Readonly<Record<WeatherField, LadderRole>> = {
  name: 'kicker',
  icon: 'body',
  high: 'headline',
  low: 'small',
};

export const DEFAULT_WEATHER_LADDER: readonly WeatherField[] = ['name', 'icon', 'high', 'low'];

/** A stored ladder, filtered to the fields this widget can actually draw. */
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

/** The stored ladder, or the one derived from the switches that predate it. */
export function shiftLadder(config: Readonly<Record<string, unknown>>): readonly ShiftField[] {
  const stored = storedLadder(config['fields'], SHIFT_FIELDS);
  if (stored !== undefined) return stored;
  return DEFAULT_SHIFT_LADDER.filter((field) => {
    if (field === 'hours') return config['showHours'] !== false;
    if (field === 'run') return config['showRun'] !== false;
    return true;
  });
}

export function weatherLadder(
  config: Readonly<Record<string, unknown>>,
): readonly WeatherField[] {
  const stored = storedLadder(config['fields'], WEATHER_FIELDS);
  if (stored !== undefined) return stored;
  return DEFAULT_WEATHER_LADDER.filter((field) => {
    if (field === 'icon') return config['showIcon'] !== false;
    if (field === 'low') return config['showLow'] !== false;
    return true;
  });
}

/**
 * Whether the high and the low share a line — true when they are adjacent,
 * because a temperature range reads as one thing. See the display's copy.
 */
export function pairsTemperatures(ladder: readonly WeatherField[]): boolean {
  const high = ladder.indexOf('high');
  const low = ladder.indexOf('low');
  return high >= 0 && low >= 0 && Math.abs(high - low) === 1;
}

export const HOUSE_FIELDS = ['icon', 'label', 'value'] as const;
export type HouseField = (typeof HOUSE_FIELDS)[number];

export const HOUSE_ROLES: Readonly<Record<HouseField, LadderRole>> = {
  icon: 'body',
  label: 'kicker',
  value: 'headline',
};

/** What each `display_mode` means, as a ladder. See the display's copy. */
export const HOUSE_MODE_LADDERS: Readonly<Record<string, readonly HouseField[]>> = {
  value: ['value'],
  label_value: ['label', 'value'],
  icon_state: ['icon', 'label', 'value'],
  presence: ['icon', 'label', 'value'],
};

/**
 * The ladder one reading draws, from the widget's list or from its own mode.
 *
 * Until this existed the panel ignored `display_mode` outright — every reading
 * came out as "label: value" through `drawPanel`'s tolerant reader, so a
 * reading set to `value` said `Locked` on the wall and `Front door: Locked`
 * here. This is that divergence closed.
 */
export function houseLadder(
  config: Readonly<Record<string, unknown>>,
  mode: string,
): readonly HouseField[] {
  const stored = storedLadder(config['fields'], HOUSE_FIELDS);
  if (stored !== undefined) return stored;
  return HOUSE_MODE_LADDERS[mode] ?? HOUSE_MODE_LADDERS['label_value'] ?? HOUSE_FIELDS;
}

export interface LadderRow<F extends string = string> {
  readonly field: F;
  readonly role: LadderRole;
  readonly text: string;
}

/** The ladder against the data there actually is — an absent field is dropped. */
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
 * Give up rows from the bottom until what is left fits. The first always
 * survives — an empty widget is the one outcome rule nine forbids.
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
