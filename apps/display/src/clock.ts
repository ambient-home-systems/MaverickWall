/**
 * Wall time, corrected against the server.
 *
 * A tablet screwed to a kitchen wall may never have been given NTP, and some
 * of them drift minutes a week. Every decision about what to draw — which day
 * is today above all — uses this rather than `Date.now()`, because a wall
 * showing the wrong day is worse than a wall showing nothing: nobody doubts it.
 */
export interface Clock {
  now(): number;
  /** Fold in the server's own time from a poll. */
  sync(serverTime: number): void;
  /** How far this device's clock is out, for the diagnostics overlay. */
  offset(): number;
}

export function createClock(deviceNow: () => number = () => Date.now()): Clock {
  let offset = 0;
  return {
    now: () => deviceNow() + offset,
    sync(serverTime: number): void {
      if (!Number.isFinite(serverTime) || serverTime <= 0) return;
      /*
       * Taken as the truth without smoothing.
       *
       * The round trip on a LAN is a few milliseconds and nothing here is
       * finer-grained than a minute, so the error this introduces is far
       * smaller than the drift it corrects. Averaging would only delay the
       * correction that matters — the one at midnight.
       */
      offset = serverTime - deviceNow();
    },
    offset: () => offset,
  };
}
