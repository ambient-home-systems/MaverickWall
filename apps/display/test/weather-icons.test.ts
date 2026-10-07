import { describe, expect, it } from 'vitest';
import { GLYPH_KEYS } from '../src/glyphs.js';
import { VARIANT_HIDES } from '../src/variants.js';
import {
  ICON_MOTION_MS,
  METEOCON_FILES,
  MOON_PHASES,
  iconMotion,
  iconSetOf,
  meteoconFor,
  moonPhase,
} from '../src/weather-icons.js';

/**
 * The forecast's Meteocons pictures (plan item M5.9), as data: which file a
 * sky wears, what the moon is doing, and how a picture moves.
 */

describe('the picture set a widget asked for', () => {
  it('is the drawn set unless it named one of the two Meteocons sets', () => {
    expect(iconSetOf(undefined)).toBe('drawn');
    expect(iconSetOf({})).toBe('drawn');
    expect(iconSetOf({ icons: 'fill' })).toBe('fill');
    expect(iconSetOf({ icons: 'line' })).toBe('line');
    expect(iconSetOf({ icons: 'animated' })).toBe('drawn');
    expect(iconSetOf({ icons: 3 })).toBe('drawn');
  });
});

describe('where the choice is offered', () => {
  it('on every forecast look but playful, whose pictures are its own artwork', () => {
    for (const [look, hidden] of Object.entries(VARIANT_HIDES.weather)) {
      expect(hidden.includes('icons'), look).toBe(look === 'playful');
    }
  });
});

describe('tonight’s moon', () => {
  // Real phases, from the published almanac, each within the mean's tolerance.
  const cases: readonly [string, string][] = [
    ['2024-01-18T03:52:00Z', 'moon-first-quarter'],
    ['2024-01-25T17:54:00Z', 'moon-full'],
    ['2024-02-02T23:18:00Z', 'moon-last-quarter'],
    ['2024-02-09T22:59:00Z', 'moon-new'],
    ['2024-02-24T12:30:00Z', 'moon-full'],
  ];
  for (const [at, phase] of cases) {
    it(`is ${phase} at ${at}`, () => {
      expect(moonPhase(Date.parse(at))).toBe(phase);
    });
  }

  it('waxes between new and full, and wanes between full and new', () => {
    // Three and a half days after the new moon of 9 February 2024, and before the full one of 24 February.
    expect(moonPhase(Date.parse('2024-02-13T12:00:00Z'))).toBe('moon-waxing-crescent');
    expect(moonPhase(Date.parse('2024-02-21T12:00:00Z'))).toBe('moon-waxing-gibbous');
    expect(moonPhase(Date.parse('2024-02-28T12:00:00Z'))).toBe('moon-waning-gibbous');
    expect(moonPhase(Date.parse('2024-03-06T12:00:00Z'))).toBe('moon-waning-crescent');
  });

  it('goes round all eight in a month, and never answers before the epoch with a negative age', () => {
    const seen = new Set<string>();
    for (let day = 0; day < 30; day++) seen.add(moonPhase(Date.parse('2026-10-01T00:00:00Z') + day * 86_400_000));
    expect([...seen].sort()).toEqual([...MOON_PHASES].sort());
    expect(MOON_PHASES).toContain(moonPhase(Date.parse('1990-06-01T00:00:00Z')));
  });
});

describe('which picture a sky wears', () => {
  const NOON = Date.parse('2024-01-25T12:00:00Z');

  it('has a picture for every sky the wall draws, by day and by night, all of them bundled', () => {
    const sky = GLYPH_KEYS.slice(0, GLYPH_KEYS.indexOf('wind') + 1);
    expect(sky).toHaveLength(12);
    for (const glyph of sky) {
      for (const isDay of [true, false]) {
        const file = meteoconFor(glyph, isDay, NOON);
        expect(file, `${glyph} ${isDay ? 'by day' : 'by night'}`).toBeDefined();
        expect(METEOCON_FILES).toContain(file);
      }
    }
  });

  it('follows the clock only where the sun is in the sky, and shows tonight’s moon on a clear night', () => {
    expect(meteoconFor('clear', true, NOON)).toBe('clear-day');
    // The full moon of 25 January 2024.
    expect(meteoconFor('clear', false, NOON)).toBe('moon-full');
    expect(meteoconFor('partly-cloudy', false, NOON)).toBe('partly-cloudy-night');
    expect(meteoconFor('showers', false, NOON)).toBe('partly-cloudy-night-rain');
    expect(meteoconFor('fog', false, NOON)).toBe('fog-night');
    // Weather that is its own picture at any hour.
    expect(meteoconFor('rain', false, NOON)).toBe('rain');
    expect(meteoconFor('thunderstorm', true, NOON)).toBe('thunderstorms-rain');
    // A device class is not a sky.
    expect(meteoconFor('lock', true, NOON)).toBeUndefined();
    expect(meteoconFor(undefined, true, NOON)).toBeUndefined();
  });

  it('bundles nothing it never names', () => {
    const named = new Set<string>();
    const sky = GLYPH_KEYS.slice(0, GLYPH_KEYS.indexOf('wind') + 1);
    for (const glyph of sky) {
      named.add(meteoconFor(glyph, true, 0) as string);
      named.add(meteoconFor(glyph, false, 0) as string);
    }
    for (const phase of MOON_PHASES) named.add(phase);
    expect([...named].sort()).toEqual([...METEOCON_FILES].sort());
  });
});

describe('how a picture moves', () => {
  it('turns a sun, sways cloud and weather, and holds a night sky still', () => {
    expect(iconMotion('clear', true)).toBe('spin');
    expect(iconMotion('clear', false)).toBe('none');
    expect(iconMotion('partly-cloudy', false)).toBe('none');
    expect(iconMotion('partly-cloudy', true)).toBe('sway');
    expect(iconMotion('rain', false)).toBe('sway');
    expect(iconMotion(undefined, true)).toBe('none');
  });

  it('never lets the fifteen-second rebuild land near where a continuous loop is', () => {
    for (const [motion, duration] of Object.entries(ICON_MOTION_MS)) {
      const off = (15_000 % duration) / duration;
      expect(Math.min(off, 1 - off), motion).toBeGreaterThanOrEqual(0.25);
    }
  });
});
