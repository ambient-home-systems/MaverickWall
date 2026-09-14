import { describe, expect, it } from 'vitest';
import {
  BROWSER_SEEN_WINDOW_MS,
  EPAPER_SEEN_WINDOW_MS,
  presence,
  presenceDot,
} from '../src/http/presence.js';

/**
 * `presence` is the one definition of whether a wall is alive (RFC 016 phase
 * 0), so its boundaries are the whole of it: a window that is off by one
 * comparison moves every page that says "up" at once, which is the point and
 * is also why it is pinned here at the edge of both windows rather than in the
 * middle of them.
 */

const AT = Date.UTC(2026, 8, 14, 11, 0, 0);
const browser = (lastSeenAt: number | null, extra: { revokedAt?: number; lastSeenIp?: string } = {}) =>
  ({ kind: 'browser', lastSeenAt, lastSeenIp: extra.lastSeenIp ?? null, revokedAt: extra.revokedAt ?? null });
const panel = (lastSeenAt: number | null, lastSeenIp: string | null = null) =>
  ({ kind: 'epaper', lastSeenAt, lastSeenIp, revokedAt: null });

describe('presence', () => {
  it('reads a null stamp as never used, in each kind’s own words', () => {
    expect(presence(browser(null), AT)).toEqual({ state: 'unpaired', headline: 'Not paired yet', detail: '', dot: 'idle' });
    expect(presence(panel(null), AT)).toEqual({ state: 'unpaired', headline: 'Waiting for its device', detail: '', dot: 'idle' });
  });

  it('holds a browser wall fresh up to, and not at, five minutes', () => {
    expect(BROWSER_SEEN_WINDOW_MS).toBe(5 * 60_000);
    const inside = presence(browser(AT - BROWSER_SEEN_WINDOW_MS + 1), AT);
    expect(inside.state).toBe('fresh');
    expect(inside.headline).toBe('Drawing now');
    expect(inside.dot).toBe('ok');
    expect(presence(browser(AT - BROWSER_SEEN_WINDOW_MS), AT).state).toBe('stale');
  });

  it('holds a panel fresh for an hour, where a browser wall of the same age is stale', () => {
    expect(EPAPER_SEEN_WINDOW_MS).toBe(60 * 60_000);
    const twelve = presence(panel(AT - 12 * 60_000), AT);
    expect(twelve).toEqual({ state: 'fresh', headline: 'Checked in 12 minutes ago', detail: '', dot: 'ok' });
    expect(presence(browser(AT - 12 * 60_000), AT).state).toBe('stale');
    expect(presence(panel(AT - EPAPER_SEEN_WINDOW_MS + 1), AT).state).toBe('fresh');
    expect(presence(panel(AT - EPAPER_SEEN_WINDOW_MS), AT).state).toBe('stale');
  });

  it('says when and from where a stale wall was last seen', () => {
    expect(presence(browser(AT - 3 * 86_400_000, { lastSeenIp: '10.0.0.4' }), AT)).toEqual({
      state: 'stale',
      headline: 'Not seen recently',
      detail: 'last seen 3 days ago from 10.0.0.4',
      dot: 'idle',
    });
    expect(presence(panel(AT - 2 * 3_600_000), AT).detail).toBe('last seen 2 hours ago');
  });

  it('reads a stamp from the future as fresh rather than as a negative age', () => {
    // A tablet whose clock ran ahead is not a wall to send somebody to check.
    expect(presence(browser(AT + 30_000), AT).state).toBe('fresh');
  });

  it('puts revoked ahead of every stamp, null or fresh', () => {
    expect(presence(browser(null, { revokedAt: AT - 1 }), AT).state).toBe('revoked');
    expect(presence(browser(AT, { revokedAt: AT - 1 }), AT).state).toBe('revoked');
  });

  it('draws the pulsing dot only for fresh', () => {
    expect(presenceDot(presence(browser(AT), AT))).toBe('<span class="dot dot-ok pulse"></span>');
    expect(presenceDot(presence(browser(null), AT))).toBe('<span class="dot dot-idle"></span>');
  });
});
