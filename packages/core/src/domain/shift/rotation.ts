import { addDays, dayOfWeek, type CivilDate } from '../../time/civil.js';

/**
 * Builds the flat day-by-day cycle that a `PatternPlan` consumes.
 *
 * The stored form is deliberately a flat array — see resolve.ts for why — but
 * typing seventy cells by hand is a bad first-run experience and an easy place
 * to make an invisible off-by-one. This describes a rotation the way people say
 * it out loud ("two weeks of days, front half of the week") and emits the array.
 *
 * The output is the source of truth once generated. Editing a cell afterwards is
 * expected and must not be clobbered by regenerating.
 */

/** How working days are distributed inside a block. */
export type BlockPattern =
  /** 4 on, 3 off, 3 on, 4 off from the block start. Seven working days. */
  | 'split-4-3'
  /**
   * Front of each week: Sun-Wed on, then Sun-Tue on. Seven working days.
   * Assumes the block begins on a Sunday, as a US federal pay period does.
   */
  | 'front-half'
  /** Back of each week: Thu-Sat on, then Wed-Sat on. Complement of `front-half`. */
  | 'back-half'
  /** 2 on, 2 off, 3 on, 2 off, 2 on, 3 off. Fourteen days, seven worked. */
  | 'panama'
  /** Four on, four off. */
  | 'four-four'
  /** Monday to Friday on, weekends off. Aligned to real weekdays. */
  | 'weekdays'
  /** Every day in the block is a working day. */
  | 'all'
  /** No working days; a block of leave. */
  | 'none';

export interface RotationBlock {
  /** Shift type key, or `null` for a block of rest. */
  readonly shiftTypeKey: string | null;
  /** Block length in weeks. Ignored when `days` or `cells` is given. */
  readonly weeks?: number;
  /** Block length in days, for cycles that are not a whole number of weeks. */
  readonly days?: number;
  readonly pattern?: BlockPattern;
  /**
   * Explicit day-by-day contents, overriding `pattern` entirely.
   *
   * The escape hatch that makes every real roster representable. Some rotations
   * — DuPont being the standard example — change shift type *within* a block,
   * which no single `shiftTypeKey` plus pattern can express. Rather than grow a
   * rule language to cover them, those simply state their days.
   */
  readonly cells?: readonly (string | null)[];
  /** Optional label for the admin UI. */
  readonly label?: string;
}

export interface BuildRotationInput {
  readonly blocks: readonly RotationBlock[];
  /**
   * The date at cycle position 0. Only `weekdays` blocks depend on it, since
   * they need to know which real weekday each position lands on — but a cycle
   * that is a whole number of weeks always restarts on the same weekday, so
   * that alignment holds for the life of the rotation.
   */
  readonly anchorDate: CivilDate;
}

const SPLIT_4_3: readonly boolean[] = [
  true, true, true, true, false, false, false,
  true, true, true, false, false, false, false,
];

/** Sun Mon Tue Wed on, then Sun Mon Tue on. */
const FRONT_HALF: readonly boolean[] = SPLIT_4_3;

/** Thu Fri Sat on, then Wed Thu Fri Sat on. The exact complement. */
const BACK_HALF: readonly boolean[] = FRONT_HALF.map((working) => !working);

/** 2 on, 2 off, 3 on, 2 off, 2 on, 3 off. */
const PANAMA: readonly boolean[] = [
  true, true, false, false, true, true, true,
  false, false, true, true, false, false, false,
];

const FOUR_FOUR: readonly boolean[] = [true, true, true, true, false, false, false, false];

function repeatingPattern(pattern: BlockPattern): readonly boolean[] | undefined {
  switch (pattern) {
    case 'split-4-3':
      return SPLIT_4_3;
    case 'front-half':
      return FRONT_HALF;
    case 'back-half':
      return BACK_HALF;
    case 'panama':
      return PANAMA;
    case 'four-four':
      return FOUR_FOUR;
    default:
      return undefined;
  }
}

function isWorkingDay(pattern: BlockPattern, positionInBlock: number, date: CivilDate): boolean {
  const repeating = repeatingPattern(pattern);
  if (repeating) return repeating[positionInBlock % repeating.length] ?? false;

  switch (pattern) {
    case 'all':
      return true;
    case 'weekdays': {
      const day = dayOfWeek(date);
      return day >= 1 && day <= 5;
    }
    case 'none':
    default:
      return false;
  }
}

function blockLength(block: RotationBlock): number {
  if (block.cells) return block.cells.length;
  if (block.days !== undefined) return Math.max(0, Math.round(block.days));
  if (block.weeks !== undefined) return Math.max(0, Math.round(block.weeks * 7));
  return 0;
}

/**
 * Expand blocks into the day array.
 *
 * Nothing assumes a particular cycle length, so a 6-week, 8-day or 28-day
 * roster works the same way.
 */
export function buildRotationCycle(input: BuildRotationInput): (string | null)[] {
  const cycle: (string | null)[] = [];
  let position = 0;

  for (const block of input.blocks) {
    if (block.cells) {
      for (const cell of block.cells) {
        cycle.push(cell);
        position++;
      }
      continue;
    }

    const length = blockLength(block);
    const pattern = block.pattern ?? 'all';
    for (let i = 0; i < length; i++) {
      const date = addDays(input.anchorDate, position);
      cycle.push(isWorkingDay(pattern, i, date) ? block.shiftTypeKey : null);
      position++;
    }
  }

  return cycle;
}

/** Count of working days in a generated cycle, for a sanity readout in admin. */
export function countWorkingDays(cycle: readonly (string | null)[]): number {
  return cycle.reduce<number>((total, key) => total + (key === null ? 0 : 1), 0);
}

/**
 * A US federal pay period is fourteen days beginning on a Sunday, so a
 * seventy-day rotation is exactly five pay periods and the two cycles stay
 * locked indefinitely. Anchoring anywhere else silently breaks that alignment,
 * which is worth warning about rather than quietly allowing.
 */
export function isPayPeriodAligned(anchorDate: CivilDate, cycleLength: number): boolean {
  return dayOfWeek(anchorDate) === 0 && cycleLength % 14 === 0;
}

/**
 * Default shift vocabulary.
 *
 * Keys are generic so a household can rename everything in admin without stored
 * cycles or calendar matchers breaking. Labels are the local names — "Mids"
 * rather than "Nights" — because that is what appears on the wall and in
 * calendar event titles. Colour tokens come from the theme.
 */
export const DEFAULT_SHIFT_TYPES = [
  { key: 'day', label: 'Days', shortCode: 'D', colorToken: '--s-day', isWorking: true },
  { key: 'night', label: 'Mids', shortCode: 'M', colorToken: '--s-night', isWorking: true },
  { key: 'straight', label: 'Straights', shortCode: 'S', colorToken: '--s-straight', isWorking: true },
] as const;

/**
 * Starting point for deriving shifts from calendar event titles.
 *
 * Ordered, first match wins. Substring tests by default: regex is available per
 * matcher but is the wrong default for something edited in a settings screen —
 * and substrings absorb the inconsistencies real calendars contain. One feed
 * this was built against writes both "Daddy - Working Day Shift" and "Daddy
 * Working - Day Shift"; a substring test on "day shift" catches both, while a
 * regex anchored to the start would silently miss half of them.
 */
export const DEFAULT_SHIFT_MATCHERS = [
  // Order matters and these are not interchangeable. "Break Day" contains the
  // word "day", so it has to be tested before any day-shift pattern or every
  // rest day resolves as a working day.
  { shiftTypeKey: null, pattern: 'break day', isRegex: false },
  { shiftTypeKey: 'straight', pattern: 'straight', isRegex: false },
  { shiftTypeKey: 'night', pattern: 'night shift', isRegex: false },
  { shiftTypeKey: 'night', pattern: 'mid', isRegex: false },
  { shiftTypeKey: 'day', pattern: 'day shift', isRegex: false },
] as const;
