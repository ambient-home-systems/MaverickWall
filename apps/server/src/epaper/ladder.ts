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

const isShiftField = (value: unknown): value is ShiftField =>
  typeof value === 'string' && (SHIFT_FIELDS as readonly string[]).includes(value);

/** The stored ladder, or the one derived from the switches that predate it. */
export function shiftLadder(config: Readonly<Record<string, unknown>>): readonly ShiftField[] {
  const stored = config['fields'];
  if (Array.isArray(stored)) {
    const seen: ShiftField[] = [];
    for (const entry of stored) {
      if (isShiftField(entry) && !seen.includes(entry)) seen.push(entry);
    }
    if (seen.length > 0) return seen;
  }
  return DEFAULT_SHIFT_LADDER.filter((field) => {
    if (field === 'hours') return config['showHours'] !== false;
    if (field === 'run') return config['showRun'] !== false;
    return true;
  });
}

export interface LadderRow {
  readonly field: ShiftField;
  readonly role: LadderRole;
  readonly text: string;
}

/** The ladder against the data there actually is — an absent field is dropped. */
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
 * Give up rows from the bottom until what is left fits. The first always
 * survives — an empty widget is the one outcome rule nine forbids.
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
