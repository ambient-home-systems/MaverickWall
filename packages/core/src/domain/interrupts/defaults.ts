import type { InterruptRule } from './types.js';

/**
 * The rules a household gets without asking.
 *
 * Weather alerts arrive whether or not anybody configured anything, so the
 * defaults are what decides whether this feature helps or becomes the reason
 * somebody unplugs the wall. The shape of the ladder matters more than any one
 * row: **the loudest thing the wall can do is reserved for the rarest.**
 *
 * Extreme is a handful of events a year in most places — a tornado warning, a
 * flash flood emergency. Severe is a few dozen. Moderate is weekly in some
 * counties and would make a takeover meaningless within a month. Minor is
 * noise: a frost advisory does not get to interrupt a family's calendar, and a
 * product that thinks it does teaches people to ignore it.
 *
 * A household can change every one of these. They are rows, not code.
 */

/** Prefix on the shipped rules' ids, so an upgrade can find them again. */
export const DEFAULT_RULE_PREFIX = 'nws-default-';

export const DEFAULT_ALERT_RULES: readonly InterruptRule[] = [
  {
    id: `${DEFAULT_RULE_PREFIX}extreme`,
    source: 'nws',
    name: 'Extreme weather warning',
    enabled: true,
    match: { minSeverity: 'Extreme' },
    action: 'takeover_and_wake',
    piercesNightMode: true,
    minDwellSec: 0,
    /*
     * Not dismissible for the first minute, expressed as not dismissible at
     * all plus a re-assert. Somebody woken at three in the morning reaches for
     * the nearest button, and an Extreme warning that can be cleared by a hand
     * moving before its owner is awake has failed at the one job it has.
     */
    dismissible: false,
    priority: 100,
  },
  {
    id: `${DEFAULT_RULE_PREFIX}severe-immediate`,
    source: 'nws',
    name: 'Severe weather, happening now',
    enabled: true,
    // Severe *and* Immediate. A severe thunderstorm watch for tomorrow
    // afternoon is not a reason to light a bedroom.
    match: { minSeverity: 'Severe', minUrgency: 'Immediate' },
    action: 'takeover',
    piercesNightMode: true,
    minDwellSec: 0,
    dismissible: true,
    // Back in ten minutes if it is still in force. "Yes, I know" should not
    // mean "and never mention it again" while the storm is overhead.
    reassertAfterSec: 600,
    priority: 80,
  },
  {
    id: `${DEFAULT_RULE_PREFIX}severe`,
    source: 'nws',
    name: 'Severe weather warning',
    enabled: true,
    match: { minSeverity: 'Severe' },
    action: 'takeover',
    // Severe but not Immediate does not get to wake anybody.
    piercesNightMode: false,
    minDwellSec: 0,
    dismissible: true,
    reassertAfterSec: 1800,
    priority: 60,
  },
  {
    id: `${DEFAULT_RULE_PREFIX}moderate`,
    source: 'nws',
    name: 'Weather advisory',
    enabled: true,
    match: { minSeverity: 'Moderate' },
    action: 'banner',
    piercesNightMode: false,
    minDwellSec: 0,
    dismissible: true,
    priority: 40,
  },
  /*
   * Minor is `none`, and it is a row rather than an absence.
   *
   * Shipping it switched off means a household who *does* want frost
   * advisories has something to turn on, and it documents the decision where
   * somebody can see it. A rule that does not exist looks like an oversight.
   */
  {
    id: `${DEFAULT_RULE_PREFIX}minor`,
    source: 'nws',
    name: 'Minor weather advisory',
    enabled: false,
    match: { minSeverity: 'Minor' },
    action: 'banner',
    piercesNightMode: false,
    minDwellSec: 0,
    dismissible: true,
    priority: 20,
  },
];
