/**
 * Interrupts: the wall saying something that is not the calendar.
 *
 * Source-agnostic on purpose. A rule matches a *signal* — a key, a state, a
 * number, and when it last changed — and nothing here knows where a signal came
 * from. Home Assistant entities are the first source to produce them; weather
 * alerts are the obvious second, and adding them is a function that emits
 * signals rather than a second evaluator.
 *
 * Pure and never throws. This runs inside manifest assembly, which every
 * display poll depends on, so a rule with nonsense stored in it has to be an
 * ignored rule rather than a wall that stops drawing.
 */

export type InterruptAction = 'banner' | 'takeover' | 'takeover_and_wake';

export type ConditionKind = 'equals' | 'above' | 'below' | 'changed_to';

export interface Signal {
  /** What produced it: `ha_entity`, later `weather_alert`. */
  readonly source: string;
  /** Identifies the thing within its source — an entity id, a zone code. */
  readonly key: string;
  /**
   * The state as the source reports it. This is what conditions match on.
   *
   * Raw, deliberately: a household writing a rule types what Home Assistant
   * says — `on` — and matching on a prettified version would mean the rule
   * form and the API disagreed about what a door sensor reads.
   */
  readonly state: string;
  /**
   * The same state as a person would say it: "Open" rather than "on".
   *
   * Only ever shown, never matched. Without it the wall said "Garage · on for
   * 47 minutes", which is the raw vocabulary the rest of this integration
   * exists to translate.
   */
  readonly reading: string;
  /** The state as a number, when it is one. */
  readonly numeric: number | null;
  /** When it last became this state, epoch ms. Null when unknown. */
  readonly since: number | null;
  /** What to call it on screen. */
  readonly label: string;
}

export interface InterruptRule {
  readonly id: string;
  readonly name: string;
  readonly trigger: string;
  readonly action: InterruptAction;
  readonly priority: number;
  readonly dismissAfterSeconds: number | null;
  readonly condition: Condition;
}

export interface Condition {
  readonly key: string;
  readonly kind: ConditionKind;
  readonly value: string;
  /**
   * Hold the condition this long before it counts.
   *
   * "The freezer door is open" is not worth a wall takeover; "the freezer door
   * has been open for five minutes" is the whole point. Measured from `since`.
   */
  readonly forSeconds: number | null;
  /**
   * Only between these times of day, in the household's own zone.
   *
   * "The garage is open" is not news at four in the afternoon; "the garage is
   * open at midnight" is the rule somebody actually wants. Without this the
   * only way to express it is a duration, which fires just as readily at noon.
   *
   * Wraps past midnight, because every rule anybody writes with this does:
   * 23:00 to 06:00 means the night, not an empty window.
   */
  readonly between: TimeWindow | null;
}

export interface TimeWindow {
  /** `HH:MM`, 24 hour. */
  readonly from: string;
  /** `HH:MM`, exclusive. */
  readonly to: string;
}

/**
 * How recently a `changed_to` must have happened to still count.
 *
 * `changed_to` is the one condition that is about an edge rather than a state,
 * and there is no store of previous states to compare against — deliberately,
 * because keeping one would mean a table written on every poll for the sake of
 * a comparison that a timestamp already answers. Home Assistant reports when a
 * state was last entered, so "changed to X" is read as "is X, and became X
 * within this window". The consequence, stated rather than hidden: a wall that
 * was unreachable for the whole window misses the edge. A rule that must not
 * be missed should use `equals`, which stays true.
 */
export const EDGE_WINDOW_MS = 5 * 60_000;

/** Parse a stored condition. Undefined when it is not one, which is ignored. */
export function parseCondition(raw: unknown): Condition | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  const key = record['entityId'] ?? record['key'];
  if (typeof key !== 'string' || key === '') return undefined;

  const kind = record['condition'];
  if (kind !== 'equals' && kind !== 'above' && kind !== 'below' && kind !== 'changed_to') {
    return undefined;
  }

  const value = record['value'];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;

  const forSeconds = record['forSeconds'];
  return {
    key,
    kind,
    value: String(value),
    forSeconds: typeof forSeconds === 'number' && forSeconds > 0 ? Math.round(forSeconds) : null,
    between: parseWindow(record['between']),
  };
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** A stored time window, or null — which means "at any hour", not "never". */
export function parseWindow(raw: unknown): TimeWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const from = record['from'];
  const to = record['to'];
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!HHMM.test(from) || !HHMM.test(to)) return null;
  // A zero-length window would never match and reads as deliberate. Somebody
  // who set both the same meant a whole day far more often than no day.
  return from === to ? null : { from, to };
}

/**
 * The wall clock in a zone, as `HH:MM`.
 *
 * From `Intl` rather than arithmetic, for the same reason recurrence is: the
 * offset on a given night is a fact about a timezone database, and a household
 * on the wrong side of a clock change would otherwise get their overnight rule
 * an hour late twice a year.
 */
export function localHhmm(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));
  } catch {
    // An unusable zone must not disarm every rule that has a window. UTC is
    // wrong by hours; refusing to evaluate is wrong always.
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at));
  }
}

/** True when `now` is inside the window, which may wrap past midnight. */
export function withinWindow(window: TimeWindow, nowHhmm: string): boolean {
  return window.from <= window.to
    ? nowHhmm >= window.from && nowHhmm < window.to
    : // Wrapped: 23:00–06:00 is "at or after 23:00, or before 06:00".
      nowHhmm >= window.from || nowHhmm < window.to;
}

function numeric(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the signal satisfies the condition, ignoring how long for. */
function matches(condition: Condition, signal: Signal): boolean {
  switch (condition.kind) {
    case 'equals':
    case 'changed_to':
      // Case-insensitive: Home Assistant answers `on`, and somebody typing a
      // rule writes `On` about as often.
      return signal.state.toLowerCase() === condition.value.toLowerCase();
    case 'above': {
      const threshold = numeric(condition.value);
      return threshold !== null && signal.numeric !== null && signal.numeric > threshold;
    }
    case 'below': {
      const threshold = numeric(condition.value);
      return threshold !== null && signal.numeric !== null && signal.numeric < threshold;
    }
  }
}

export interface ManifestInterrupt {
  readonly id: string;
  readonly name: string;
  /** Written for someone standing in a kitchen. Never an entity id. */
  readonly message: string;
  readonly action: InterruptAction;
  readonly priority: number;
}

export interface EvaluateInput {
  readonly rules: readonly InterruptRule[];
  readonly signals: readonly Signal[];
  readonly now: number;
  /** The household's zone. Only `between` needs it; it is always supplied. */
  readonly timezone: string;
}

/**
 * Which interrupts are in force, highest priority first.
 *
 * Auto-dismissal is measured from when the state was entered rather than from
 * when it was first shown. There is no per-screen record of what a wall has
 * already displayed, and there should not be: a household with a kitchen
 * tablet and a hall television would otherwise get two different answers about
 * whether the garage is open.
 */
export function evaluateInterrupts(input: EvaluateInput): ManifestInterrupt[] {
  const byKey = new Map(input.signals.map((signal) => [signal.key, signal]));
  const firing: ManifestInterrupt[] = [];
  // Once per evaluation rather than once per rule: every rule with a window
  // asks the same question of the same instant.
  const nowHhmm = localHhmm(input.now, input.timezone);

  for (const rule of input.rules) {
    const signal = byKey.get(rule.condition.key);
    if (signal === undefined) continue;
    if (!matches(rule.condition, signal)) continue;
    if (rule.condition.between !== null && !withinWindow(rule.condition.between, nowHhmm)) {
      continue;
    }

    const heldFor = signal.since === null ? null : input.now - signal.since;

    if (rule.condition.kind === 'changed_to') {
      // An edge, read from a timestamp. See EDGE_WINDOW_MS.
      if (heldFor === null || heldFor > EDGE_WINDOW_MS) continue;
    }

    if (rule.condition.forSeconds !== null) {
      if (heldFor === null || heldFor < rule.condition.forSeconds * 1000) continue;
    }

    if (rule.dismissAfterSeconds !== null && heldFor !== null) {
      if (heldFor > rule.dismissAfterSeconds * 1000) continue;
    }

    firing.push({
      id: rule.id,
      name: rule.name,
      message: describe(rule, signal, heldFor),
      action: rule.action,
      priority: rule.priority,
    });
  }

  // Highest priority first, then by name so the order does not shuffle between
  // polls and make the wall flicker between two equal interrupts.
  return firing.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

/**
 * What the wall says.
 *
 * The rule's own name leads, because it is the sentence the household wrote
 * about their own house — "Water under the sink" beats anything derivable from
 * `binary_sensor.leak_1`. The reading follows it as evidence.
 */
function describe(rule: InterruptRule, signal: Signal, heldFor: number | null): string {
  const reading = `${signal.label} · ${signal.reading}`;
  if (rule.condition.forSeconds === null || heldFor === null) return `${rule.name} — ${reading}`;

  const minutes = Math.floor(heldFor / 60_000);
  const duration =
    minutes < 1
      ? 'less than a minute'
      : minutes < 60
        ? `${minutes} minute${minutes === 1 ? '' : 's'}`
        : `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? '' : 's'}`;
  return `${rule.name} — ${reading} for ${duration}`;
}

export interface RuleTemplate {
  readonly key: string;
  readonly name: string;
  /** Which domains the entity picker should offer for this template. */
  readonly domains: readonly string[];
  readonly condition: Omit<Condition, 'key'>;
  readonly action: InterruptAction;
  readonly priority: number;
  /** Why this template exists, on the form. */
  readonly hint: string;
}

/**
 * The three the brief asks to ship.
 *
 * Templates rather than a blank form, because the hard part of a rule builder
 * is not the fields — it is knowing that a freezer door is worth five minutes
 * and a leak is worth none. A household can still write their own; these are
 * the ones that answer "what would I even use this for".
 */
export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    key: 'leak',
    name: 'Water leak',
    domains: ['binary_sensor'],
    condition: { kind: 'equals', value: 'on', forSeconds: null, between: null },
    action: 'takeover_and_wake',
    priority: 100,
    hint: 'The whole wall, the moment it is wet, and it lights a screen that has gone dark. Water does not wait.',
  },
  {
    key: 'garage',
    name: 'Garage door open late',
    domains: ['binary_sensor', 'sensor'],
    /*
     * The window is the rule, not the duration.
     *
     * A garage open at four in the afternoon is somebody unloading shopping.
     * The same sensor at midnight is the thing worth walking downstairs for,
     * and only the hour tells them apart. Ten minutes on top so that coming
     * home late does not set it off on the driveway.
     */
    condition: {
      kind: 'equals',
      value: 'on',
      forSeconds: 10 * 60,
      between: { from: '23:00', to: '06:00' },
    },
    action: 'takeover',
    priority: 60,
    hint: 'Open after 23:00, for ten minutes. Overnight only — the same sensor at teatime is somebody carrying shopping in.',
  },
  {
    key: 'freezer',
    name: 'Freezer door open',
    domains: ['binary_sensor'],
    condition: { kind: 'equals', value: 'on', forSeconds: 5 * 60, between: null },
    action: 'banner',
    priority: 40,
    hint: 'Five minutes. A banner rather than a takeover — worth knowing, not worth losing the calendar over.',
  },
];
