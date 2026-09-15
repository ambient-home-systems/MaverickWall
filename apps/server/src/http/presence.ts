/**
 * Whether a wall is alive, answered once (RFC 016 phase 0).
 *
 * Before this there were four answers and three of them agreed by accident:
 * the Walls list's `seenDot` (five minutes for a browser wall, sixty for a
 * panel), the wall page's status line (a literal `5 * 60_000` that nothing held
 * to the constant it copied), the panel page's (sixty minutes), and the
 * Overview's attention rows (a day). A summary line counted from a fifth
 * reading would have been a fifth vocabulary, and the next change to a window
 * would have moved one page and not the others. Every page that says whether a
 * wall is up now asks this function for the *state*, and the Walls list draws
 * its words as well.
 *
 * Pure and with no database, for the reason `widget-options.ts` and
 * `next-path.ts` are: a policy living inside a handler is one a test can only
 * reach through a server, one case at a time. `at` is the caller's clock and is
 * required — the stamp it is compared with comes from `touchScreen`, which takes
 * the caller's clock for the same reason.
 */

export function ago(from: number | null, now: number): string {
  if (from === null) return 'never';
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * How long since a screen last called in before it stops counting as fresh.
 *
 * A browser wall polls every minute, so five minutes is generous and says
 * "up" without pretending to diagnose. An e-paper panel on battery sleeps
 * between pulls — the shipped ESPHome recipe sleeps thirty minutes and the
 * Home Assistant one pushes every fifteen — so its window is an hour, or
 * every sleeping panel in the house would read as idle for most of the day.
 */
export const BROWSER_SEEN_WINDOW_MS = 5 * 60_000;
export const EPAPER_SEEN_WINDOW_MS = 60 * 60_000;

export type PresenceState = 'unpaired' | 'fresh' | 'stale' | 'revoked';

export interface PresenceInput {
  readonly kind: string;
  readonly lastSeenAt: number | null;
  readonly lastSeenIp: string | null;
  readonly revokedAt: number | null;
}

export interface Presence {
  readonly state: PresenceState;
  /** Plain text, unescaped: the few words that say the state. */
  readonly headline: string;
  /** Plain text, unescaped, possibly empty: what follows the headline. */
  readonly detail: string;
  /** Which status dot: `ok` pulses, `idle` does not. */
  readonly dot: 'ok' | 'idle';
}

export function seenWindowMs(kind: string): number {
  return kind === 'epaper' ? EPAPER_SEEN_WINDOW_MS : BROWSER_SEEN_WINDOW_MS;
}

export function presence(screen: PresenceInput, at: number): Presence {
  const panel = screen.kind === 'epaper';
  if (screen.revokedAt !== null) {
    return { state: 'revoked', headline: 'Unpaired', detail: 'its token no longer works', dot: 'idle' };
  }
  /*
   * `touchScreen` runs from `/d/manifest` and `/d/epaper/:file` and never from
   * `/pair`, so a null stamp means nothing has ever used this token — which is
   * a claim, not a guess. The words differ by kind because the kinds are not
   * in the same position: a browser wall is paired by opening a link on it,
   * and a panel is never paired at all — a device is set up to fetch its frame.
   */
  if (screen.lastSeenAt === null) {
    return { state: 'unpaired', headline: panel ? 'Waiting for its device' : 'Not paired yet', detail: '', dot: 'idle' };
  }
  const since = ago(screen.lastSeenAt, at);
  if (at - screen.lastSeenAt < seenWindowMs(screen.kind)) {
    /*
     * "Drawing now" is true of a browser wall, which redraws every fifteen
     * seconds. A battery panel spends most of its fresh hour asleep showing a
     * frame it drew earlier, so what can honestly be said is when it asked.
     */
    return { state: 'fresh', headline: panel ? `Checked in ${since}` : 'Drawing now', detail: '', dot: 'ok' };
  }
  return {
    state: 'stale',
    headline: 'Not seen recently',
    detail: `last seen ${since}` + (screen.lastSeenIp === null ? '' : ` from ${screen.lastSeenIp}`),
    dot: 'idle',
  };
}

/** The dot markup for a presence. */
export function presenceDot(p: Presence): string {
  return p.dot === 'ok' ? `<span class="dot dot-ok pulse"></span>` : `<span class="dot dot-idle"></span>`;
}
