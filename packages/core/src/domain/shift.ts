import { addDays, daysBetween, floorMod, type CivilDate } from '../time/civil.js';

/**
 * Shift rotation.
 *
 * A shift is a property of a *day*, not an event. It belongs on the day cell
 * with the day's colour, not in the agenda alongside a dentist appointment.
 *
 * The requirements — a long repeating cycle, occasional swaps, the roster
 * changing outright, and patterns that stop — are the same shape as calendar
 * recurrence: a base rule, a window in which it applies, and per-instance
 * overrides. So this is modelled the same way, and resolved by layering:
 *
 *   override  →  calendar-derived  →  pattern  →  nothing
 *
 * The highest layer that produces an answer wins. That single ordering covers
 * a swapped shift, a roster change, a temporary secondment onto someone else's
 * pattern, and a rotation that simply ended.
 */

export interface ShiftType {
  readonly key: string;
  readonly label: string;
  /** One or two characters for the compressed horizon cells. */
  readonly shortCode: string;
  /** A CSS custom property name, e.g. `--s-night`. Themes own the value. */
  readonly colorToken: string;
  /** False for rest days, leave, and similar. Drives "days until next shift". */
  readonly isWorking: boolean;
}

interface PlanBase {
  readonly id: string;
  readonly name: string;
  /** Inclusive. */
  readonly effectiveFrom: CivilDate;
  /** Inclusive. `null` means open-ended. */
  readonly effectiveTo: CivilDate | null;
  /** Higher wins when ranges overlap. Ties break on the later effectiveFrom. */
  readonly priority: number;
}

/**
 * A repeating cycle expressed as an explicit day-by-day sequence.
 *
 * Deliberately a flat array rather than a rule language. A 10-week rotation is
 * 70 entries, which is trivial to store, trivial to display for editing, and
 * imposes no constraints on the shape of the pattern. Rule languages are where
 * rosters go to become unrepresentable.
 */
export interface PatternPlan extends PlanBase {
  readonly kind: 'pattern';
  /** The date sitting at cycle position 0. */
  readonly anchorDate: CivilDate;
  /** Shift type keys, `null` for a rest day. Length is the cycle length. */
  readonly cycle: readonly (string | null)[];
}

export interface ShiftMatcher {
  readonly shiftTypeKey: string;
  /** Case-insensitive. A substring test unless `isRegex`. */
  readonly pattern: string;
  readonly isRegex: boolean;
}

/** Derives shifts from event titles on a designated calendar source. */
export interface CalendarPlan extends PlanBase {
  readonly kind: 'calendar';
  readonly calendarSourceId: string;
  /** Evaluated in order; first match wins. */
  readonly matchers: readonly ShiftMatcher[];
}

export type ShiftPlan = PatternPlan | CalendarPlan;

/** A single-day change: a swap, a cover, a day taken off. */
export interface ShiftOverride {
  readonly date: CivilDate;
  /** `null` means explicitly not working, which is distinct from unknown. */
  readonly shiftTypeKey: string | null;
  readonly note?: string;
}

export type ShiftSource = 'override' | 'calendar' | 'pattern' | 'none';

export interface ResolvedShift {
  readonly date: CivilDate;
  readonly shiftTypeKey: string | null;
  readonly source: ShiftSource;
  readonly planId?: string;
  readonly note?: string;
}

export interface ResolveShiftsInput {
  readonly from: CivilDate;
  readonly to: CivilDate;
  readonly plans: readonly ShiftPlan[];
  readonly overrides: readonly ShiftOverride[];
  /** Event titles per date, for calendar-derived plans. */
  readonly titlesByDate?: ReadonlyMap<CivilDate, readonly string[]>;
  /** Keys that exist. Unknown keys resolve to null rather than a broken cell. */
  readonly shiftTypes?: readonly ShiftType[];
}

function coversDate(plan: ShiftPlan, date: CivilDate): boolean {
  if (daysBetween(plan.effectiveFrom, date) < 0) return false;
  if (plan.effectiveTo !== null && daysBetween(date, plan.effectiveTo) < 0) return false;
  return true;
}

/** Highest priority first, then the most recently started plan. */
function byPrecedence(a: ShiftPlan, b: ShiftPlan): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return daysBetween(a.effectiveFrom, b.effectiveFrom);
}

function matchTitle(matchers: readonly ShiftMatcher[], titles: readonly string[]): string | undefined {
  for (const matcher of matchers) {
    for (const title of titles) {
      if (matcher.isRegex) {
        let re: RegExp;
        try {
          re = new RegExp(matcher.pattern, 'i');
        } catch {
          // A malformed pattern must not take out the rotation. Skip it.
          continue;
        }
        if (re.test(title)) return matcher.shiftTypeKey;
      } else if (title.toLowerCase().includes(matcher.pattern.toLowerCase())) {
        return matcher.shiftTypeKey;
      }
    }
  }
  return undefined;
}

function positionInCycle(plan: PatternPlan, date: CivilDate): number {
  return floorMod(daysBetween(plan.anchorDate, date), plan.cycle.length);
}

/**
 * Resolve a shift for every date in an inclusive range.
 *
 * Pure and total: an unknown shift key, a malformed matcher, or a plan with an
 * empty cycle degrades that day to `null`, never an exception. A wall display
 * showing an uncoloured day is a minor cosmetic loss; one that fails to render
 * because a roster was edited badly is a support call nobody can answer.
 */
export function resolveShifts(input: ResolveShiftsInput): ResolvedShift[] {
  const knownKeys = input.shiftTypes ? new Set(input.shiftTypes.map((t) => t.key)) : undefined;
  const isKnown = (key: string | null): boolean =>
    key === null || knownKeys === undefined || knownKeys.has(key);

  const overrideByDate = new Map<CivilDate, ShiftOverride>();
  for (const override of input.overrides) overrideByDate.set(override.date, override);

  const patternPlans = input.plans
    .filter((plan): plan is PatternPlan => plan.kind === 'pattern' && plan.cycle.length > 0)
    .sort(byPrecedence);
  const calendarPlans = input.plans
    .filter((plan): plan is CalendarPlan => plan.kind === 'calendar')
    .sort(byPrecedence);

  const out: ResolvedShift[] = [];
  const span = daysBetween(input.from, input.to);

  for (let offset = 0; offset <= span; offset++) {
    const date = addDays(input.from, offset);

    const override = overrideByDate.get(date);
    if (override && isKnown(override.shiftTypeKey)) {
      out.push({
        date,
        shiftTypeKey: override.shiftTypeKey,
        source: 'override',
        ...(override.note !== undefined ? { note: override.note } : {}),
      });
      continue;
    }

    const titles = input.titlesByDate?.get(date);
    let resolved: ResolvedShift | undefined;

    if (titles && titles.length > 0) {
      for (const plan of calendarPlans) {
        if (!coversDate(plan, date)) continue;
        const key = matchTitle(plan.matchers, titles);
        if (key !== undefined && isKnown(key)) {
          resolved = { date, shiftTypeKey: key, source: 'calendar', planId: plan.id };
          break;
        }
      }
    }

    if (!resolved) {
      for (const plan of patternPlans) {
        if (!coversDate(plan, date)) continue;
        const key = plan.cycle[positionInCycle(plan, date)] ?? null;
        if (!isKnown(key)) continue;
        resolved = { date, shiftTypeKey: key, source: 'pattern', planId: plan.id };
        break;
      }
    }

    out.push(resolved ?? { date, shiftTypeKey: null, source: 'none' });
  }

  return out;
}

/**
 * The next working day at or after `from`, for a "next shift" readout.
 * Returns undefined when nothing in the resolved range is a working day.
 */
export function nextWorkingShift(
  resolved: readonly ResolvedShift[],
  shiftTypes: readonly ShiftType[],
  from: CivilDate,
): ResolvedShift | undefined {
  const working = new Set(shiftTypes.filter((t) => t.isWorking).map((t) => t.key));
  return resolved.find(
    (shift) =>
      daysBetween(from, shift.date) >= 0 &&
      shift.shiftTypeKey !== null &&
      working.has(shift.shiftTypeKey),
  );
}
