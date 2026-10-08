import { describe, expect, it } from 'vitest';
import { DEFAULT_SLIDE_SECONDS, FADE_MS, frameAt, pairFrames, roundOrder, sameFrame, slideAt, slideConfig, slideTiming } from '../src/slideshow.js';

/** Which photo an album shows, from the wall clock alone (plan item M5.12). */

const PHOTOS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `${x.repeat(64)}.jpg`);
const MIN = 60_000;

describe('slideConfig', () => {
  it('reads five minutes in order when the widget has not said, and refuses what it does not offer', () => {
    expect(slideConfig({})).toEqual({ seconds: DEFAULT_SLIDE_SECONDS, order: 'in-order', motion: 'cut' });
    expect(DEFAULT_SLIDE_SECONDS).toBe(300);
    expect(slideConfig({ slideSeconds: 3600, slideOrder: 'shuffle' })).toEqual({ seconds: 3600, order: 'shuffle', motion: 'cut' });
    expect(slideConfig({ slideSeconds: 7, slideOrder: 'random' })).toEqual({ seconds: 300, order: 'in-order', motion: 'cut' });
  });

  it('reads a crossfade and a slow zoom, and anything else as the cut every album drew before (plan item M3.6)', () => {
    expect(slideConfig({ slideMotion: 'fade' }).motion).toBe('fade');
    expect(slideConfig({ slideMotion: 'zoom' }).motion).toBe('zoom');
    for (const other of ['cut', 'dissolve', 1, null]) expect(slideConfig({ slideMotion: other }).motion).toBe('cut');
  });
});

describe('slideTiming', () => {
  it('names the next swap on the clock, the same from anywhere inside the interval', () => {
    const base = 1_000_000 * MIN;
    expect(slideTiming(base, 60)).toEqual({ swapAtMs: base + MIN, intervalMs: MIN });
    expect(slideTiming(base + MIN - 1, 60).swapAtMs).toBe(base + MIN);
    expect(slideTiming(base + MIN, 60).swapAtMs).toBe(base + 2 * MIN);
    // The swap slideTiming names is the one slideAt turns on.
    const { swapAtMs } = slideTiming(base + 30_000, 60);
    expect(slideAt(PHOTOS, swapAtMs - 1, { seconds: 60, order: 'in-order', motion: 'fade' })?.current).toBe(PHOTOS[0]);
    expect(slideAt(PHOTOS, swapAtMs, { seconds: 60, order: 'in-order', motion: 'fade' })?.current).toBe(PHOTOS[1]);
    expect(FADE_MS).toBe(2_000);
  });
});

describe('slideAt', () => {
  it('turns at the interval on the clock, in the album’s order, and says what comes next', () => {
    const config = { seconds: 60, order: 'in-order', motion: 'cut' } as const;
    const base = 1_000_000 * MIN; // a whole minute
    expect(slideAt(PHOTOS, base, config)).toEqual({ current: PHOTOS[0], next: PHOTOS[1] });
    expect(slideAt(PHOTOS, base + MIN - 1, config)?.current).toBe(PHOTOS[0]);
    expect(slideAt(PHOTOS, base + MIN, config)?.current).toBe(PHOTOS[1]);
    expect(slideAt(PHOTOS, base + 7 * MIN, config)).toEqual({ current: PHOTOS[7], next: PHOTOS[0] });
  });

  it('is the same photo on every wall and every redraw inside one interval', () => {
    const config = { seconds: 300, order: 'shuffle', motion: 'cut' } as const;
    const at = 1_791_388_800_000;
    const seen = new Set([0, 15_000, 30_000, 299_999].map((offset) => slideAt(PHOTOS, at + offset, config)?.current));
    expect(seen.size).toBe(1);
  });

  it('shows every photo once a round when shuffled, in an order that changes from round to round', () => {
    const config = { seconds: 60, order: 'shuffle', motion: 'cut' } as const;
    const round = (r: number): (string | undefined)[] =>
      PHOTOS.map((_, i) => slideAt(PHOTOS, (r * PHOTOS.length + i) * MIN, config)?.current);
    for (const r of [0, 1, 2, 500]) expect([...round(r)].sort()).toEqual([...PHOTOS].sort());
    expect(round(1)).not.toEqual(PHOTOS);
    expect(round(1)).not.toEqual(round(2));
    expect(roundOrder(PHOTOS, 'shuffle', 9)).toEqual(roundOrder(PHOTOS, 'shuffle', 9));
  });

  it('shows the one photo of an album of one, and nothing of an empty album', () => {
    expect(slideAt([PHOTOS[0] ?? ''], 123_456_789, { seconds: 60, order: 'shuffle', motion: 'cut' })).toEqual({
      current: PHOTOS[0],
      next: PHOTOS[0],
    });
    expect(slideAt([], 123_456_789, { seconds: 60, order: 'in-order', motion: 'cut' })).toBeUndefined();
  });
});

describe('pairFrames (plan item M3.7)', () => {
  const [a, b, c, d, e] = PHOTOS as [string, string, string, string, string];
  it('puts a portrait with the next portrait after it, and leaves a landscape, an unknown and an odd one out alone', () => {
    // a and c portrait, b landscape: c leaves its place to join a.
    expect(pairFrames([a, b, c], new Set([a, c]))).toEqual([[a, c], [b]]);
    // Three portraits: the third has nobody to pair with.
    expect(pairFrames([a, b, c, d], new Set([a, b, d]))).toEqual([[a, b], [c], [d]]);
    // Nothing known: one at a time, exactly as before.
    expect(pairFrames([a, b, c], new Set())).toEqual([[a], [b], [c]]);
    // A portrait set naming a photo not in the album changes nothing.
    expect(pairFrames([a, b], new Set([e]))).toEqual([[a], [b]]);
  });
});

describe('frameAt (plan item M3.7)', () => {
  const config = { seconds: 60, order: 'in-order', motion: 'cut' } as const;
  const base = 1_000_000 * MIN;
  it('is slideAt a photo at a time when no portrait is known', () => {
    for (let k = 0; k < 20; k++) {
      const plain = slideAt(PHOTOS, base + k * MIN, config);
      const framed = frameAt(PHOTOS, new Set(), base + k * MIN, config);
      expect(framed).toEqual({ current: [plain?.current], next: [plain?.next] });
    }
    expect(frameAt([], new Set(), base, config)).toBeUndefined();
  });

  it('shows every photo exactly once a round, shuffled or not, and says the next frame', () => {
    const portraits = new Set([PHOTOS[0], PHOTOS[2], PHOTOS[3], PHOTOS[6], PHOTOS[7]] as string[]);
    // Eight photos, five portraits: three landscapes and two pairs and one alone is six frames.
    const frames = 8 - Math.floor(5 / 2);
    for (const order of ['in-order', 'shuffle'] as const) {
      const shuffled = { seconds: 60, order, motion: 'cut' } as const;
      for (let round = 0; round < 4; round++) {
        const seen: string[] = [];
        for (let k = 0; k < frames; k++) {
          const at = frameAt(PHOTOS, portraits, (round * frames + k) * MIN, shuffled);
          seen.push(...(at?.current ?? []));
          const after = frameAt(PHOTOS, portraits, (round * frames + k + 1) * MIN, shuffled);
          expect(sameFrame(at?.next ?? [''], after?.current ?? [''])).toBe(true);
          // A pair is two portraits, never a landscape.
          if (at?.current.length === 2) expect(at.current.every((one) => portraits.has(one))).toBe(true);
        }
        expect([...seen].sort()).toEqual([...PHOTOS].sort());
      }
    }
  });
});
