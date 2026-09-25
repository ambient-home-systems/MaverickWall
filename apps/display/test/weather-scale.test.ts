import { describe, expect, it } from 'vitest';

import {
  TEMP_ANCHORS,
  barSpan,
  rampGradient,
  rampStops,
  rampWithin,
  scalePercent,
  tempTone,
  unitOf,
  weekScale,
} from '../src/weather-scale.js';

/**
 * The arithmetic behind the `range` and `colour` weather styles (plan item
 * P5.1), table by table. The browser tests measure what these numbers draw;
 * these hold the numbers themselves, which is the only place a wrong anchor or
 * an inverted bar can be named rather than inferred from a colour.
 */

describe('the four anchors', () => {
  it('are the same four temperatures in both units', () => {
    for (let i = 0; i < 4; i++) {
      const c = TEMP_ANCHORS.C[i] as number;
      expect(TEMP_ANCHORS.F[i]).toBe(Math.round((c * 9) / 5 + 32));
    }
  });

  it.each([
    [-8, 'C', 'cold'], [4, 'C', 'cold'], [6, 'C', 'cool'], [14, 'C', 'cool'],
    [16, 'C', 'warm'], [24, 'C', 'warm'], [26, 'C', 'hot'], [41, 'C', 'hot'],
    [20, 'F', 'cold'], [40, 'F', 'cold'], [42, 'F', 'cool'], [58, 'F', 'cool'],
    [60, 'F', 'warm'], [76, 'F', 'warm'], [78, 'F', 'hot'], [101, 'F', 'hot'],
  ] as const)('reads %s°%s as %s', (value, unit, tone) => {
    expect(tempTone(value, unit)).toBe(tone);
  });

  it('agrees between the units about one day', () => {
    // 18°C is 64°F: an ordinary mild afternoon, warm in both scales.
    expect(tempTone(18, 'C')).toBe(tempTone(64, 'F'));
    expect(tempTone(3, 'C')).toBe(tempTone(37, 'F'));
  });
});

describe('the unit a forecast is in', () => {
  it('takes the first day that says, then the panel, then Celsius', () => {
    expect(unitOf([{ tempUnit: undefined }, { tempUnit: 'F' }])).toBe('F');
    expect(unitOf([{ tempUnit: undefined }], 'F')).toBe('F');
    expect(unitOf([{ tempUnit: 'C' }], 'F')).toBe('C');
    expect(unitOf([])).toBe('C');
  });
});

describe('the week’s scale', () => {
  const days = [
    { lowValue: 9, highValue: 18 },
    { lowValue: 10, highValue: 17 },
    { lowValue: 13, highValue: 14 },
  ];

  it('runs from the coldest low to the warmest high', () => {
    expect(weekScale(days)).toEqual({ min: 9, max: 18 });
  });

  it('stretches to hold a current reading off the end of the forecast', () => {
    expect(weekScale(days, 21)).toEqual({ min: 9, max: 21 });
    expect(weekScale(days, 4)).toEqual({ min: 4, max: 18 });
  });

  it('is undefined with no numbers, and never zero wide', () => {
    expect(weekScale([{ lowValue: undefined, highValue: undefined }])).toBeUndefined();
    expect(weekScale([{ lowValue: 5, highValue: 5 }])).toEqual({ min: 4, max: 6 });
  });

  it('places a value on the track and clamps it to the ends', () => {
    const scale = { min: 10, max: 20 };
    expect(scalePercent(scale, 15)).toBe(50);
    expect(scalePercent(scale, 2)).toBe(0);
    expect(scalePercent(scale, 30)).toBe(100);
  });
});

describe('a day’s bar', () => {
  const scale = { min: 9, max: 18 };

  it('spans the low to the high', () => {
    expect(barSpan(scale, 9, 18)).toEqual({ left: 0, width: 100 });
    expect(barSpan(scale, 13, 14)).toEqual({ left: 44.44, width: 11.12 });
  });

  it('is drawn the right way round when a provider sends them reversed', () => {
    expect(barSpan(scale, 14, 13)).toEqual(barSpan(scale, 13, 14));
  });

  it('is undefined when a day lacks either number', () => {
    expect(barSpan(scale, undefined, 14)).toBeUndefined();
    expect(barSpan(scale, 9, undefined)).toBeUndefined();
  });
});

describe('the ramp', () => {
  it('puts each anchor where it falls on this week, outside the track if the week does not reach it', () => {
    // A mild British week: freezing is far off the left, hot off the right.
    expect(rampStops({ min: 9, max: 18 }, 'C')).toEqual([
      { tone: 'cold', at: -100 },
      { tone: 'cool', at: 11.11 },
      { tone: 'warm', at: 122.22 },
      { tone: 'hot', at: 233.33 },
    ]);
  });

  it('is absolute: one temperature is one colour whichever week it is in', () => {
    // 20°C sits at the warm stop on two different weeks, wherever the stop lands on each.
    for (const scale of [{ min: 9, max: 18 }, { min: 14, max: 31 }]) {
      const warm = rampStops(scale, 'C').find((stop) => stop.tone === 'warm');
      expect(warm?.at).toBeCloseTo(((20 - scale.min) / (scale.max - scale.min)) * 100, 1);
    }
  });

  it('is written from the theme’s own four tokens, cold to hot', () => {
    expect(rampGradient({ min: 0, max: 30 }, 'C')).toBe(
      'linear-gradient(90deg, var(--temp-cold) 0%, var(--temp-cool) 33.33%, var(--temp-warm) 66.67%, var(--temp-hot) 100%)',
    );
  });

  it('sits inside each window so every row shows the same ramp', () => {
    // A window from 25% to 75% of the track: the ramp starts half a window to
    // its left and is two windows wide — one track, lined up with the track.
    expect(rampWithin({ left: 25, width: 50 })).toEqual({ left: -50, width: 200 });
    expect(rampWithin({ left: 0, width: 100 })).toEqual({ left: -0, width: 100 });
    expect(rampWithin({ left: 40, width: 0 })).toEqual({ left: -40, width: 100 });
  });
});
