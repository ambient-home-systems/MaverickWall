/**
 * Noticing that the wall has stopped being a wall.
 *
 * A display runs for months untouched. The failures that matter are not
 * crashes — a crash is visible — but the quiet ones: a poll loop that threw
 * once and never scheduled itself again, a renderer that stopped after a bad
 * document, a tab the browser froze while the household was asleep. All of
 * them look exactly like a working wall showing a very old day.
 *
 * The decision is a pure function so it can be tested without waiting hours
 * for real time to pass. The timer that acts on it lives in main.ts and does
 * nothing but call this and reload.
 */

export interface WatchdogState {
  /** When the loop last completed a draw. */
  readonly lastDrawAt: number;
  /** When the server last confirmed anything, fresh or 304. */
  readonly lastContactAt: number;
  /** When this page instance started. */
  readonly startedAt: number;
  /** Reloads already attempted since the page loaded. */
  readonly reloads: number;
}

export interface WatchdogLimits {
  /** A draw happens every tick, so silence here means the loop is gone. */
  readonly drawSilenceMs: number;
  /** Contact fails legitimately when a server is down; this is far longer. */
  readonly contactSilenceMs: number;
  /** Never reload in the first moments of a page's life. */
  readonly graceMs: number;
  /** Reloading forever helps nobody and hides the real fault. */
  readonly maxReloads: number;
}

export const DEFAULT_LIMITS: WatchdogLimits = {
  // The draw tick is 15 seconds; four missed in a row is a stopped loop
  // rather than a slow one.
  drawSilenceMs: 60_000,
  /*
   * Two hours. Deliberately not minutes: a server being down is the case the
   * offline store exists to handle gracefully, and reloading every five
   * minutes against a server that is off would replace a useful stale wall
   * with a flickering one. This is for the case where *we* are broken, not
   * where the server is.
   */
  contactSilenceMs: 2 * 60 * 60_000,
  graceMs: 90_000,
  maxReloads: 3,
};

export type WatchdogVerdict =
  | { readonly action: 'wait' }
  | { readonly action: 'reload'; readonly reason: string };

export function assess(
  state: WatchdogState,
  now: number,
  limits: WatchdogLimits = DEFAULT_LIMITS,
): WatchdogVerdict {
  // A page that has only just started has not had time to do anything wrong,
  // and reloading during startup is how a boot loop begins.
  if (now - state.startedAt < limits.graceMs) return { action: 'wait' };

  /*
   * A cap, because a reload loop is worse than the fault it is treating.
   * Three attempts is enough to clear a wedged renderer; past that the
   * problem is not one a reload fixes, and a wall showing an old day beats a
   * wall that blanks itself every minute for ever.
   */
  if (state.reloads >= limits.maxReloads) return { action: 'wait' };

  if (now - state.lastDrawAt > limits.drawSilenceMs) {
    return { action: 'reload', reason: 'the renderer stopped drawing' };
  }
  if (now - state.lastContactAt > limits.contactSilenceMs) {
    return { action: 'reload', reason: 'nothing has been heard from the server for hours' };
  }
  return { action: 'wait' };
}
