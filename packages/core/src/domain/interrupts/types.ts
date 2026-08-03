/**
 * The interrupt model: one shape, whatever the source.
 *
 * A rule matches a **signal** — something that is currently true and that
 * something outside this package went and found out. A weather alert, a door
 * sensor, an appointment starting soon. Nothing in this directory knows how any
 * of them were fetched, and that is the property being defended: a fourth
 * source should be a function that emits signals, not a fourth evaluator.
 *
 * Pure, and rule one applies. No `Intl`, no clock, no I/O — even the wall-clock
 * reading a night-hours rule needs arrives as a string the caller worked out,
 * for the same reason `now` does.
 */

/** CAP v1.2 severity, most serious first. */
export type Severity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';

/** CAP v1.2 urgency, most urgent first. */
export type Urgency = 'Immediate' | 'Expected' | 'Future' | 'Past' | 'Unknown';

export type Certainty = 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown';

export type InterruptSource = 'nws' | 'homeassistant' | 'calendar' | 'manual';

export type InterruptAction = 'none' | 'banner' | 'takeover' | 'takeover_and_wake';

/**
 * Ranked so "at least this serious" is a comparison rather than a lookup table
 * at every call site. `Unknown` sits at the bottom deliberately: a provider
 * that omits severity must not clear a `minSeverity` bar by accident.
 */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  Extreme: 4,
  Severe: 3,
  Moderate: 2,
  Minor: 1,
  Unknown: 0,
};

export const URGENCY_RANK: Readonly<Record<Urgency, number>> = {
  Immediate: 4,
  Expected: 3,
  Future: 2,
  Past: 1,
  Unknown: 0,
};

export const ACTION_RANK: Readonly<Record<InterruptAction, number>> = {
  takeover_and_wake: 3,
  takeover: 2,
  banner: 1,
  none: 0,
};

export type ConditionKind = 'equals' | 'above' | 'below' | 'changed_to';

/** `HH:MM` to `HH:MM`, 24 hour. Wraps past midnight. */
export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * A state test against one entity.
 *
 * Home Assistant is the only source that produces these today, but nothing
 * here names it: any source with a keyed state can be matched this way.
 */
export interface EntityCondition {
  readonly kind: ConditionKind;
  readonly value: string;
  /**
   * Only between these hours, in the household's own zone.
   *
   * A garage door open at teatime is somebody carrying shopping in; the same
   * sensor at midnight is worth walking downstairs for, and only the hour
   * tells them apart.
   */
  readonly between: TimeWindow | null;
}

export interface RuleMatch {
  /** CAP event names, e.g. `Tornado Warning`. Case-insensitive, exact. */
  readonly eventTypes?: readonly string[];
  readonly minSeverity?: Severity;
  readonly minUrgency?: Urgency;
  /** Matches one signal by key — an entity id, a zone code. */
  readonly entityId?: string;
  readonly condition?: EntityCondition;
  /**
   * Fires when the signal *starts* within this many seconds.
   *
   * The third source: an appointment about to begin. It is what proves the
   * model is a model rather than two special cases sharing a file — a calendar
   * event has no severity, no state and no entity, and still matches.
   */
  readonly startsWithinSec?: number;
}

export interface InterruptRule {
  readonly id: string;
  readonly source: InterruptSource;
  /** Shown on the wall. The household's own sentence when they wrote one. */
  readonly name: string;
  readonly enabled: boolean;
  readonly match: RuleMatch;
  readonly action: InterruptAction;
  /**
   * Whether this may light a screen that has gone dark for the night.
   *
   * Separate from `action` because they are different questions: a household
   * may want a tornado warning to cover the wall *and* wake it, and a bin
   * reminder to cover the wall and absolutely not.
   */
  readonly piercesNightMode: boolean;
  /**
   * The signal must have been true this long before it counts.
   *
   * "The freezer door is open" is not worth a wall; "the freezer door has been
   * open five minutes" is the whole point.
   */
  readonly minDwellSec: number;
  readonly dismissible: boolean;
  /**
   * Come back this long after being dismissed. Undefined means stay dismissed
   * until the signal itself goes away.
   */
  readonly reassertAfterSec?: number;
  /** Breaks ties before severity does. Higher wins. */
  readonly priority: number;
}

/**
 * Something that is true right now, found out by somebody else.
 *
 * Deliberately one wide shape rather than a union. A union would mean the
 * evaluator switching on source, which is exactly the coupling this model
 * exists to avoid — a rule should be able to say "minSeverity: Severe" without
 * anything asking whether the signal came from a weather office or a smoke
 * alarm.
 */
export interface Signal {
  readonly source: InterruptSource;
  /** Unique within its source. A CAP id, an entity id, an event id. */
  readonly key: string;
  /** What the thing is called: `Tornado Warning`, `Freezer door`, `Dentist`. */
  readonly title: string;
  /** The provider's own sentence, when it has one. */
  readonly headline?: string;
  /** Where it applies: a county list, a room. */
  readonly area?: string;
  /** Who said so: `NWS Baltimore/Washington`. */
  readonly sender?: string;
  readonly severity?: Severity;
  readonly urgency?: Urgency;
  readonly certainty?: Certainty;
  /** The current state, for a source that has one. */
  readonly state?: string;
  /** That state as a number, when it is one. */
  readonly numeric?: number | null;
  /** When it became true, epoch ms. Null when the source cannot say. */
  readonly since?: number | null;
  /** When it stops being true, epoch ms. */
  readonly expiresAt?: number | null;
  /** When the thing itself begins, epoch ms. Calendar events have this. */
  readonly startsAt?: number | null;
}

/** A rule that is currently firing, with the signal that made it fire. */
export interface Interrupt {
  readonly ruleId: string;
  readonly key: string;
  readonly source: InterruptSource;
  readonly action: Exclude<InterruptAction, 'none'>;
  /** The line drawn largest. Never contains an entity id or a URL. */
  readonly title: string;
  readonly headline?: string;
  readonly area?: string;
  readonly sender?: string;
  readonly severity: Severity;
  readonly urgency: Urgency;
  readonly expiresAt?: number | null;
  readonly dismissible: boolean;
  /**
   * Carried through to the push message, and on to the Android app.
   *
   * Present on the payload from the start so that adding wake support to the
   * app later needs no server change — a web client simply ignores it.
   */
  readonly wakeScreen: boolean;
  readonly piercesNightMode: boolean;
  readonly priority: number;
}
