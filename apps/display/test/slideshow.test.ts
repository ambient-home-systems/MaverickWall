import { describe, expect, it } from 'vitest';
import { DEFAULT_SLIDE_SECONDS, roundOrder, slideAt, slideConfig } from '../src/slideshow.js';

/** Which photo an album shows, from the wall clock alone (plan item M5.12). */

const PHOTOS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `${x.repeat(64)}.jpg`);
const MIN = 60_000;

describe('slideConfig', () => {
  it('reads five minutes in order when the widget has not said, and refuses what it does not offer', () => {
    expect(slideConfig({})).toEqual({ seconds: DEFAULT_SLIDE_SECONDS, order: 'in-order' });
    expect(DEFAULT_SLIDE_SECONDS).toBe(300);
    expect(slideConfig({ slideSeconds: 3600, slideOrder: 'shuffle' })).toEqual({ seconds: 3600, order: 'shuffle' });
    expect(slideConfig({ slideSeconds: 7, slideOrder: 'random' })).toEqual({ seconds: 300, order: 'in-order' });
  });
});

describe('slideAt', () => {
  it('turns at the interval on the clock, in the album’s order, and says what comes next', () => {
    const config = { seconds: 60, order: 'in-order' } as const;
    const base = 1_000_000 * MIN; // a whole minute
    expect(slideAt(PHOTOS, base, config)).toEqual({ current: PHOTOS[0], next: PHOTOS[1] });
    expect(slideAt(PHOTOS, base + MIN - 1, config)?.current).toBe(PHOTOS[0]);
    expect(slideAt(PHOTOS, base + MIN, config)?.current).toBe(PHOTOS[1]);
    expect(slideAt(PHOTOS, base + 7 * MIN, config)).toEqual({ current: PHOTOS[7], next: PHOTOS[0] });
  });

  it('is the same photo on every wall and every redraw inside one interval', () => {
    const config = { seconds: 300, order: 'shuffle' } as const;
    const at = 1_791_388_800_000;
    const seen = new Set([0, 15_000, 30_000, 299_999].map((offset) => slideAt(PHOTOS, at + offset, config)?.current));
    expect(seen.size).toBe(1);
  });

  it('shows every photo once a round when shuffled, in an order that changes from round to round', () => {
    const config = { seconds: 60, order: 'shuffle' } as const;
    const round = (r: number): (string | undefined)[] =>
      PHOTOS.map((_, i) => slideAt(PHOTOS, (r * PHOTOS.length + i) * MIN, config)?.current);
    for (const r of [0, 1, 2, 500]) expect([...round(r)].sort()).toEqual([...PHOTOS].sort());
    expect(round(1)).not.toEqual(PHOTOS);
    expect(round(1)).not.toEqual(round(2));
    expect(roundOrder(PHOTOS, 'shuffle', 9)).toEqual(roundOrder(PHOTOS, 'shuffle', 9));
  });

  it('shows the one photo of an album of one, and nothing of an empty album', () => {
    expect(slideAt([PHOTOS[0] ?? ''], 123_456_789, { seconds: 60, order: 'shuffle' })).toEqual({
      current: PHOTOS[0],
      next: PHOTOS[0],
    });
    expect(slideAt([], 123_456_789, { seconds: 60, order: 'in-order' })).toBeUndefined();
  });
});
