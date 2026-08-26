import type { EntityCondition, InterruptAction, TimeWindow } from '@maverick-wall/core';

/**
 * Starting points for a household writing their own rule.
 *
 * Distinct from `DEFAULT_ALERT_RULES` in core, which are rules that *exist*
 * whether or not anybody asked. These are examples somebody clicks to fill a
 * form in, and they live beside the form rather than in core because they are
 * a fact about the admin screen, not about the model.
 *
 * The hard part of a rule builder is not the fields. It is knowing that a
 * freezer door is worth five minutes and a leak is worth none.
 */

export type { InterruptAction };

export interface RuleTemplate {
  readonly key: string;
  readonly name: string;
  /** Which domains the entity picker should offer for this one. */
  readonly domains: readonly string[];
  readonly condition: EntityCondition;
  readonly minDwellSec: number;
  readonly action: InterruptAction;
  readonly piercesNightMode: boolean;
  readonly dismissible: boolean;
  readonly priority: number;
  /** Why this template exists, on the form. */
  readonly hint: string;
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
  // Both the same is a zero-length window that could never match. Somebody who
  // did that meant a whole day far more often than no day at all.
  return from === to ? null : { from, to };
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    key: 'leak',
    name: 'Water leak',
    domains: ['binary_sensor'],
    condition: { kind: 'equals', value: 'on', between: null },
    minDwellSec: 0,
    action: 'takeover_and_wake',
    piercesNightMode: true,
    // Not clearable. Somebody woken at three in the morning reaches for the
    // nearest button, and a leak warning cleared by a hand moving before its
    // owner is awake has failed at the one job it has.
    dismissible: false,
    priority: 90,
    hint: 'The whole wall, the moment it is wet, and it wakes it if it has gone dark. Water does not wait.',
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
    condition: { kind: 'equals', value: 'on', between: { from: '23:00', to: '06:00' } },
    minDwellSec: 10 * 60,
    action: 'takeover',
    piercesNightMode: false,
    dismissible: true,
    priority: 60,
    hint: 'Open after 23:00, for ten minutes. Overnight only — the same sensor at teatime is somebody carrying shopping in.',
  },
  {
    key: 'freezer',
    name: 'Freezer door open',
    domains: ['binary_sensor'],
    condition: { kind: 'equals', value: 'on', between: null },
    minDwellSec: 5 * 60,
    action: 'banner',
    piercesNightMode: false,
    dismissible: true,
    priority: 40,
    hint: 'Five minutes. A banner rather than a takeover — worth knowing, not worth losing the calendar over.',
  },
];
