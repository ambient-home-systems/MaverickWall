import { addDays, daysBetween, floorMod, type CivilDate } from '../../time/civil.js';

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
  /** An explicit colour that overrides the token, or absent to follow the theme. */
  readonly color?: string;
  /** Optional `HH:MM` start/end of the shift, shown on the wall. */
  readonly startTime?: string;
  readonly endTime?: string;
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
  /**
   * Shift type key, or `null` to mean explicitly not working.
   *
   * Calendars frequently state rest days outright — "Break Day" — and that is
   * positive information, not an absence. Matching it to `null` lets a
   * calendar-derived plan say "definitely off" and stop a lower-priority
   * pattern plan from filling the day back in.
   */
  readonly shiftTypeKey: string | null;
  readonly pattern: string;
  /**
   * How `pattern` is compared. Case-insensitive in every mode.
   *
   * `exact` is the right default for titles a person has picked from a list of
   * what is genuinely in their feed: it cannot surprise them by also matching
   * something else. `contains` is for feeds that vary their own wording — one
   * real calendar writes both "Daddy - Working Day Shift" and "Daddy Working -
   * Day Shift". `regex` is the escape hatch and a poor default for anything
   * edited in a settings screen.
   */
  readonly matchMode?: 'exact' | 'contains' | 'regex';
  /** @deprecated Use `matchMode`. Retained so stored matchers keep working. */
  readonly isRegex?: boolean;
}

/** Derives shifts from event titles on a designated calendar source. */
export interface CalendarPlan extends PlanBase {
  readonly kind: 'calendar';
  readonly calendarSourceId: string;
  /** Evaluated in order; first match wins. */
  readonly matchers: readonly ShiftMatcher[];
  /**
   * Remove matched events from the agenda.
   *
   * On by default in practice, because a feed that marks every single day with
   * "Working Day Shift" or "Break Day" would otherwise bury the appointments
   * somebody is actually looking at the wall to find. The shift belongs in the
   * day's colour; the event has done its job once it has been read.
   */
  readonly consumesEvents?: boolean;
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

/**
 * Does any matcher claim this title?
 *
 * Exported because the manifest needs to ask the question per event, not per
 * day: a shift plan that derives "Working Day Shift" from a calendar should
 * also remove that event from the agenda, or the wall lists the same
 * information twice — once as a day colour and once as an appointment.
 *
 * `undefined` means no matcher fired; `null` means one fired and said "off".
 */
export function matchShiftTitle(
  matchers: readonly ShiftMatcher[],
  title: string,
): string | null | undefined {
  return matchTitle(matchers, [title]);
}

/** `undefined` means no matcher fired; `null` means one fired and said "off". */
function matchTitle(
  matchers: readonly ShiftMatcher[],
  titles: readonly string[],
): string | null | undefined {
  for (const matcher of matchers) {
    for (const title of titles) {
      const mode = matcher.matchMode ?? (matcher.isRegex === true ? 'regex' : 'contains');
      const candidate = title.trim().toLowerCase();
      const pattern = matcher.pattern.trim().toLowerCase();

      if (mode === 'regex') {
        let re: RegExp;
        try {
          re = new RegExp(matcher.pattern, 'i');
        } catch {
          // A malformed pattern must not take out the rotation. Skip it.
          continue;
        }
        if (re.test(title)) return matcher.shiftTypeKey;
      } else if (mode === 'exact') {
        if (candidate === pattern) return matcher.shiftTypeKey;
      } else if (candidate.includes(pattern)) {
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
