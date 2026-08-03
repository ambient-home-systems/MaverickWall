import {
  ACTION_RANK,
  SEVERITY_RANK,
  URGENCY_RANK,
  type EntityCondition,
  type Interrupt,
  type InterruptRule,
  type RuleMatch,
  type Severity,
  type Signal,
  type TimeWindow,
  type Urgency,
} from './types.js';

/**
 * Deciding what the wall says over the top of the calendar.
 *
 * Pure and never throws. This runs inside manifest assembly, which every
 * display poll depends on, so a rule with nonsense stored in it has to be an
 * ignored rule rather than a wall that stops drawing.
 */

/**
 * How recently a `changed_to` must have happened to still count.
 *
 * `changed_to` is the one condition about an edge rather than a state, and
 * there is no store of previous states to compare against — deliberately,
 * because keeping one means a table written on every poll for a comparison a
 * timestamp already answers. So "changed to X" is read as "is X, and became X
 * within this window". The cost, stated rather than hidden: a wall unreachable
 * for the whole window misses the edge. A rule that must not be missed should
 * use `equals`, which stays true.
 */
export const EDGE_WINDOW_MS = 5 * 60_000;

export interface EvaluateInput {
  readonly signals: readonly Signal[];
  readonly rules: readonly InterruptRule[];
  readonly now: number;
  /**
   * The wall clock where the screen is hanging, as `HH:MM`.
   *
   * Passed in rather than derived, because deriving it needs `Intl` and rule
   * one keeps that out of core. It is the same argument as `now`: a pure
   * function is told what time it is.
   */
  readonly localHhmm: string;
  /**
   * When each key was last dismissed, epoch ms.
   *
   * Household-wide rather than per screen, and that is the point: a kitchen
   * tablet and a hall television must not disagree about whether the garage is
   * still worth mentioning.
   */
  readonly dismissedAt?: Readonly<Record<string, number>>;
}

/** True when `now` falls inside the window, which may wrap past midnight. */
export function withinWindow(window: TimeWindow, nowHhmm: string): boolean {
  return window.from <= window.to
    ? nowHhmm >= window.from && nowHhmm < window.to
    : // Wrapped: 23:00–06:00 is "at or after 23:00, or before 06:00".
      nowHhmm >= window.from || nowHhmm < window.to;
}

function severityOf(signal: Signal): Severity {
  return signal.severity ?? 'Unknown';
}

function urgencyOf(signal: Signal): Urgency {
  return signal.urgency ?? 'Unknown';
}

function conditionHolds(
  condition: EntityCondition,
  signal: Signal,
  now: number,
  localHhmm: string,
): boolean {
  const state = signal.state ?? '';

  let holds: boolean;
  switch (condition.kind) {
    case 'equals':
    case 'changed_to':
      // Case-insensitive: Home Assistant answers `on`, and somebody typing a
      // rule writes `On` about as often.
      holds = state.toLowerCase() === condition.value.toLowerCase();
      break;
    case 'above': {
      const threshold = Number(condition.value);
      holds =
        Number.isFinite(threshold) &&
        signal.numeric !== null &&
        signal.numeric !== undefined &&
        signal.numeric > threshold;
      break;
    }
    case 'below': {
      const threshold = Number(condition.value);
      holds =
        Number.isFinite(threshold) &&
        signal.numeric !== null &&
        signal.numeric !== undefined &&
        signal.numeric < threshold;
      break;
    }
  }
  if (!holds) return false;

  if (condition.kind === 'changed_to') {
    const since = signal.since;
    if (since === null || since === undefined || now - since > EDGE_WINDOW_MS) return false;
  }

  if (condition.between !== null && !withinWindow(condition.between, localHhmm)) return false;

  return true;
}

function matches(match: RuleMatch, signal: Signal, now: number, localHhmm: string): boolean {
  if (match.entityId !== undefined && match.entityId !== signal.key) return false;

  if (match.eventTypes !== undefined) {
    const wanted = match.eventTypes.map((name) => name.toLowerCase());
    if (!wanted.includes(signal.title.toLowerCase())) return false;
  }

  if (match.minSeverity !== undefined) {
    if (SEVERITY_RANK[severityOf(signal)] < SEVERITY_RANK[match.minSeverity]) return false;
  }

  if (match.minUrgency !== undefined) {
    if (URGENCY_RANK[urgencyOf(signal)] < URGENCY_RANK[match.minUrgency]) return false;
  }

  if (match.startsWithinSec !== undefined) {
    const startsAt = signal.startsAt;
    if (startsAt === null || startsAt === undefined) return false;
    const until = startsAt - now;
    // Already started is not "starting soon". A reminder that stays up through
    // the appointment is a reminder nobody reads by the second time.
    if (until < 0 || until > match.startsWithinSec * 1000) return false;
  }

  if (match.condition !== undefined && !conditionHolds(match.condition, signal, now, localHhmm)) {
    return false;
  }

  /*
   * A match with nothing in it matches nothing.
   *
   * An empty `match` reads as "everything" and would turn one bad row into a
   * wall covered by every signal in the house. Requiring at least one clause
   * makes a rule somebody half-wrote into a rule that does nothing.
   */
  return (
    match.entityId !== undefined ||
    match.eventTypes !== undefined ||
    match.minSeverity !== undefined ||
    match.minUrgency !== undefined ||
    match.startsWithinSec !== undefined ||
    match.condition !== undefined
  );
}

/**
 * Every rule currently firing, unsorted.
 *
 * A rule may fire against several signals at once — one `minSeverity: Severe`
 * rule and two warnings in force is two interrupts, not one, because they are
 * two different things to tell somebody.
 */
export function evaluateRules(input: EvaluateInput): Interrupt[] {
  const firing: Interrupt[] = [];
  const dismissed = input.dismissedAt ?? {};

  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    if (rule.action === 'none') continue;

    for (const signal of input.signals) {
      if (signal.source !== rule.source) continue;
      if (!matches(rule.match, signal, input.now, input.localHhmm)) continue;

      // Expired is not firing, whatever anybody was told. This is the
      // client-side expiry: an alert clears on its own `expires` even if the
      // poll that would have removed it never arrived.
      const expiresAt = signal.expiresAt;
      if (expiresAt !== null && expiresAt !== undefined && expiresAt <= input.now) continue;

      if (rule.minDwellSec > 0) {
        const since = signal.since;
        if (since === null || since === undefined) continue;
        if (input.now - since < rule.minDwellSec * 1000) continue;
      }

      /*
       * Dismissal, and coming back.
       *
       * Keyed on the rule *and* the signal, so dismissing one warning does not
       * silence the next one a different county gets. Without
       * `reassertAfterSec` a dismissal lasts until the signal stops — which is
       * what somebody means by "yes, I know" about a thing that will end.
       */
      const dismissKey = `${rule.id}:${signal.key}`;
      const clearedAt = dismissed[dismissKey];
      if (clearedAt !== undefined) {
        if (rule.reassertAfterSec === undefined) continue;
        if (input.now - clearedAt < rule.reassertAfterSec * 1000) continue;
      }

      firing.push({
        ruleId: rule.id,
        key: signal.key,
        source: signal.source,
        action: rule.action,
        title: signal.title,
        ...(signal.headline !== undefined ? { headline: signal.headline } : {}),
        ...(signal.area !== undefined ? { area: signal.area } : {}),
        ...(signal.sender !== undefined ? { sender: signal.sender } : {}),
        severity: severityOf(signal),
        urgency: urgencyOf(signal),
        ...(signal.expiresAt !== undefined ? { expiresAt: signal.expiresAt } : {}),
        dismissible: rule.dismissible,
        wakeScreen: rule.action === 'takeover_and_wake',
        piercesNightMode: rule.piercesNightMode,
        priority: rule.priority,
      });
    }
  }

  return firing;
}

export interface Resolution {
  /** What the wall shows now, loudest first. */
  readonly active: readonly Interrupt[];
  /** True and firing, but outranked. Kept so nothing is silently dropped. */
  readonly queued: readonly Interrupt[];
}

/**
 * Order what is firing, and decide what a wall can actually show at once.
 *
 * Severity first, because that is the question a household is really asking —
 * a Moderate banner must never outrank an Extreme takeover just because
 * somebody set a high priority on it. Then urgency, then how loud the action
 * is, then the rule's own priority, then the title so the order does not
 * shuffle between polls and make the wall flicker.
 *
 * **One interrupt per signal.** The shipped rules are a ladder of
 * `minSeverity` bars, so an Extreme warning satisfies every one of them — and
 * without this a single tornado warning produced a takeover *and* a banner
 * repeating it underneath. A household is told about a thing once, at the
 * loudest level any rule assigns it. The same is true of a household who
 * writes two rules about one door.
 *
 * **One takeover at a time.** Two things covering the whole wall is one thing
 * covering the whole wall and one thing nobody sees, so the rest queue. Banners
 * stack, because they are a list by nature — but only the first few are worth
 * drawing, and that is the renderer's call rather than this one's.
 */
export function resolveConflicts(firing: readonly Interrupt[]): Resolution {
  const sorted = [...firing].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] ||
      ACTION_RANK[b.action] - ACTION_RANK[a.action] ||
      b.priority - a.priority ||
      a.title.localeCompare(b.title),
  );

  const active: Interrupt[] = [];
  const queued: Interrupt[] = [];
  const spokenFor = new Set<string>();
  let takeoverShown = false;

  for (const interrupt of sorted) {
    // Already said, by a louder rule. Sorted loudest-first, so the first one
    // through for a key is the one to show.
    if (spokenFor.has(interrupt.key)) {
      queued.push(interrupt);
      continue;
    }

    const isTakeover = interrupt.action === 'takeover' || interrupt.action === 'takeover_and_wake';
    if (isTakeover && takeoverShown) {
      queued.push(interrupt);
      continue;
    }
    if (isTakeover) takeoverShown = true;

    spokenFor.add(interrupt.key);
    active.push(interrupt);
  }

  return { active, queued };
}

/** Everything, in one call: what is firing, ordered, with the rest queued. */
export function evaluateInterrupts(input: EvaluateInput): Resolution {
  return resolveConflicts(evaluateRules(input));
}
