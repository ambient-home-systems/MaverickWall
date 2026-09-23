import { describe, expect, it } from 'vitest';

import {
  CLOCK_VARIANTS,
  FACE_CENTRE,
  FACE_DIAL_PATH,
  FACE_HOUR_HAND,
  FACE_MINUTE_HAND,
  analogueFace,
  clockVariant,
  handAngles,
  handPolygon,
  stackedDateLines,
  tickPolygons,
  wallClockReading,
  type FacePoint,
} from '../src/clock-face.js';

/**
 * The clock's designed variants, as data (RFC 014 §4.2).
 *
 * Everything a variant decides is decided in `clock-face.ts` so it can be
 * asked here, with no DOM: which variant a stored config means, what the
 * kitchen clock reads in the household's zone, where each hand points, and
 * which way every silhouette winds. The drawing itself is measured in a real
 * browser in `browser-clock-variants.test.ts`.
 */

describe('which variant a config means', () => {
  it('is plain when absent, and plain for a value that belongs to another widget', () => {
    expect(clockVariant(undefined)).toBe('plain');
    expect(clockVariant({})).toBe('plain');
    // One enum for every type: a value the clock does not draw is "not for me".
    expect(clockVariant({ variant: 'strip' })).toBe('plain');
    expect(clockVariant({ variant: 42 })).toBe('plain');
    for (const variant of CLOCK_VARIANTS) expect(clockVariant({ variant })).toBe(variant);
  });
});

describe('what the kitchen clock reads', () => {
  it('reads the hour and minute in the household’s zone, not the device’s', () => {
    const at = Date.UTC(2026, 8, 23, 10, 7, 45);
    expect(wallClockReading(at, 'Europe/London')).toEqual({ hour: 11, minute: 7 });
    expect(wallClockReading(at, 'America/New_York')).toEqual({ hour: 6, minute: 7 });
    // Midnight is 0, however an engine spells it.
    expect(wallClockReading(Date.UTC(2026, 8, 23, 23, 0), 'Europe/London').hour).toBe(0);
  });

  it('spells the weekday and the date out, from the same instant as the digits', () => {
    // 23:30 UTC is already Thursday in London: the lines follow the clock.
    expect(stackedDateLines(Date.UTC(2026, 8, 23, 23, 30), 'Europe/London')).toEqual({
      weekday: 'Thursday',
      date: '24 September',
    });
    expect(stackedDateLines(Date.UTC(2026, 8, 23, 23, 30), 'UTC')).toEqual({
      weekday: 'Wednesday',
      date: '23 September',
    });
  });
});

/** Twice the signed area, positive for a clockwise path on a y-down grid. */
function signedArea(points: readonly FacePoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

describe('the face', () => {
  it('points the hands the way a kitchen clock does', () => {
    expect(handAngles(11, 0)).toEqual({ hour: 330, minute: 0 });
    expect(handAngles(15, 30)).toEqual({ hour: 105, minute: 180 });
    expect(handAngles(0, 45)).toEqual({ hour: 22.5, minute: 270 });
  });

  it('puts each hand’s tip first, where the hand points', () => {
    for (const [degrees, hand] of [
      [0, FACE_MINUTE_HAND],
      [90, FACE_HOUR_HAND],
      [330, FACE_HOUR_HAND],
    ] as const) {
      const tip = handPolygon(degrees, hand)[0]!;
      const rad = (degrees * Math.PI) / 180;
      expect(tip.x).toBeCloseTo(FACE_CENTRE + Math.sin(rad) * hand.length, 2);
      expect(tip.y).toBeCloseTo(FACE_CENTRE - Math.cos(rad) * hand.length, 2);
    }
  });

  it('winds every silhouette clockwise, the idiom `glyphs.ts` states', () => {
    for (const degrees of [0, 45, 137, 330]) {
      expect(signedArea(handPolygon(degrees, FACE_MINUTE_HAND))).toBeGreaterThan(0);
      expect(signedArea(handPolygon(degrees, FACE_HOUR_HAND))).toBeGreaterThan(0);
    }
    for (const tick of tickPolygons()) expect(signedArea(tick)).toBeGreaterThan(0);
  });

  it('keeps every hand and mark inside the ring, and the ring at the grid’s edge', () => {
    const face = analogueFace(11, 0);
    const numbers = (d: string): number[] => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (const d of [face.hourPath, face.minutePath]) {
      for (const n of numbers(d)) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(24);
      }
    }
    // The dial starts at the left of the outer disc: x = 0, the grid's edge.
    expect(FACE_DIAL_PATH.startsWith('M0 12')).toBe(true);
    expect(tickPolygons()).toHaveLength(12);
  });

  it('is a filled drawing — no stroke and no seconds', () => {
    // The seconds are the one thing this face refuses, for the reason the
    // schema has no seconds field: a wall redrawn every fifteen seconds would
    // be wrong about them far more often than right.
    const face = analogueFace(11, 0);
    expect(Object.keys(face).sort()).toEqual(['hourAngle', 'hourPath', 'minuteAngle', 'minutePath']);
  });
});
