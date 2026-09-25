import { describe, expect, it } from 'vitest';
import {
  PLAYFUL_BOB_MS,
  PLAYFUL_BOB_STEP_MS,
  SKY_KINDS,
  SKY_MOTION_MS,
  SKY_PARTICLES,
  adviceInput,
  emojiForGlyph,
  hourLabel,
  skyFor,
  skyMotion,
  todayCard,
  todayOf,
  type TodayCardInput,
} from '../src/weather-looks.js';
import { GLYPH_KEYS, type GlyphKey } from '../src/glyphs.js';
import { EMOJI_KEYS } from '../src/emoji.js';
import type { CurrentWeatherModel, HourlyWeatherModel, WeatherDayModel } from '../src/viewmodel.js';

/**
 * The decisions behind the forecast's `today` and `playful` looks (plan item
 * P5.1), read without a browser — `weather-looks.ts` is where they live so
 * they can be. What a real wall draws from them is `browser-weather-today` and
 * `browser-weather-playful`.
 */

const SKIES = GLYPH_KEYS.slice(0, GLYPH_KEYS.indexOf('wind') + 1) as readonly GlyphKey[];

describe('the sky a reading is drawn on', () => {
  it('is the plan’s six, and only a sky with the sun in it follows the clock', () => {
    const table = Object.fromEntries(SKIES.map((glyph) => [glyph, [skyFor(glyph, true), skyFor(glyph, false)]]));
    expect(table).toEqual({
      clear: ['day', 'night'],
      'mostly-clear': ['day', 'night'],
      'partly-cloudy': ['day', 'night'],
      cloudy: ['cloud', 'cloud'],
      fog: ['cloud', 'cloud'],
      drizzle: ['rain', 'rain'],
      rain: ['rain', 'rain'],
      showers: ['rain', 'rain'],
      snow: ['snow', 'snow'],
      sleet: ['snow', 'snow'],
      thunderstorm: ['storm', 'storm'],
      wind: ['day', 'night'],
    });
    // Every kind is reached, so no sky token set is one nothing draws.
    expect(new Set(Object.values(table).flat())).toEqual(new Set(SKY_KINDS));
  });

  it('draws the plain sky for a glyph it was not told, never a guess at weather', () => {
    expect(skyFor(undefined, true)).toBe('day');
    expect(skyFor(undefined, false)).toBe('night');
    // A device class is not a sky.
    expect(skyFor('garage', true)).toBe('day');
  });
});

describe('what moves across it', () => {
  it('is the plan’s four, per condition, and nothing on a clear night', () => {
    const table = Object.fromEntries(SKIES.map((glyph) => [glyph, [skyMotion(glyph, true), skyMotion(glyph, false)]]));
    expect(table).toEqual({
      clear: ['glow', 'none'],
      'mostly-clear': ['glow', 'none'],
      'partly-cloudy': ['drift', 'drift'],
      cloudy: ['drift', 'drift'],
      fog: ['drift', 'drift'],
      drizzle: ['rain', 'rain'],
      rain: ['rain', 'rain'],
      showers: ['rain', 'rain'],
      snow: ['snow', 'snow'],
      sleet: ['snow', 'snow'],
      // A storm is its rain and never a flash.
      thunderstorm: ['rain', 'rain'],
      wind: ['drift', 'drift'],
    });
    expect(skyMotion(undefined, true)).toBe('none');
  });

  it('draws few of each, inside the card, from a fixed table', () => {
    // P4.3 caps the count, for an old tablet compositing every one on every frame.
    for (const [kind, spots] of Object.entries(SKY_PARTICLES)) {
      expect(spots.length, kind).toBeGreaterThan(0);
      expect(spots.length, kind).toBeLessThanOrEqual(12);
      for (const spot of spots) {
        expect(spot.left, kind).toBeGreaterThanOrEqual(0);
        expect(spot.left, kind).toBeLessThanOrEqual(100);
        expect(spot.top, kind).toBeGreaterThanOrEqual(0);
        expect(spot.top, kind).toBeLessThanOrEqual(100);
      }
    }
    for (const duration of Object.values(SKY_MOTION_MS)) expect(duration).toBeGreaterThan(0);
  });

  it('never loops in step with the fifteen-second tick, so a restart could not hide', () => {
    /*
     * A cycle that divides the tick puts a restarted loop exactly where a
     * continuous one is — the fault `motion.ts` exists to prevent would be
     * invisible on the glass and to every continuity check. So each cycle has
     * to land a restart at least a quarter of a cycle from where continuity
     * puts it — a share rather than a time, because rain's whole cycle is 1.2
     * seconds and half of it (the most any restart can be out) is 600ms.
     */
    const TICK_MS = 15_000;
    for (const [name, cycle] of [...Object.entries(SKY_MOTION_MS), ['bob', PLAYFUL_BOB_MS]] as const) {
      const off = TICK_MS % cycle;
      expect(Math.min(off, cycle - off) / cycle, `${name}, ${cycle}ms`).toBeGreaterThanOrEqual(0.25);
    }
    // And a playful strip's neighbours are a fixed share of one bob apart.
    expect(PLAYFUL_BOB_STEP_MS).toBeGreaterThan(0);
    expect(PLAYFUL_BOB_STEP_MS).toBeLessThan(PLAYFUL_BOB_MS);
  });
});

describe('the picture a playful day wears', () => {
  it('is the plan’s seven, and a cloud for an overcast day', () => {
    expect(Object.fromEntries(SKIES.map((glyph) => [glyph, emojiForGlyph(glyph)]))).toEqual({
      clear: 'sun',
      'mostly-clear': 'partly-cloudy-day',
      'partly-cloudy': 'partly-cloudy-day',
      cloudy: 'cloud',
      fog: 'fog',
      drizzle: 'cloud-with-rain',
      rain: 'cloud-with-rain',
      showers: 'cloud-with-rain',
      snow: 'snowflake',
      sleet: 'snowflake',
      thunderstorm: 'thunderstorm',
      wind: 'wind',
    });
  });

  it('is always a bundled key, and none for a glyph that is not a sky', () => {
    for (const glyph of SKIES) expect(EMOJI_KEYS as readonly string[]).toContain(emojiForGlyph(glyph));
    expect(emojiForGlyph(undefined)).toBeUndefined();
    expect(emojiForGlyph('lock')).toBeUndefined();
  });
});

const NOW = Date.parse('2026-09-24T12:40:00Z');
const HOUR = 60 * 60_000;

function day(date: string | undefined, over: Partial<WeatherDayModel> = {}): WeatherDayModel {
  return {
    name: 'Today',
    glyph: 'cloudy',
    high: '22°',
    low: '13°C',
    highValue: 22.1,
    lowValue: 12.9,
    tempUnit: 'C',
    date,
    summary: 'Overcast',
    precipChance: undefined,
    precipAmount: undefined,
    windMax: undefined,
    uvMax: undefined,
    sunrise: undefined,
    sunset: undefined,
    detail: undefined,
    ...over,
  };
}

const CURRENT: CurrentWeatherModel = {
  observedAt: NOW - 10 * 60_000,
  source: 'modelled',
  temp: '19°',
  tempValue: 19.4,
  feelsLike: '18°',
  condition: 'Mainly clear',
  glyph: 'mostly-clear',
  isDay: true,
  humidity: 50,
  windSpeed: 3.6,
  windGust: 13.3,
  windDir: 'SSW',
  uv: 2.55,
};

function hours(from: number, count: number, isDay = true): HourlyWeatherModel[] {
  return Array.from({ length: count }, (_, i) => ({
    at: from + i * HOUR,
    temp: `${19 + i}°`,
    glyph: 'cloudy' as const,
    isDay,
    precipChance: undefined,
  }));
}

const INPUT: TodayCardInput = {
  days: [day('2026-09-24'), day('2026-09-25', { name: 'Fri', highValue: 23.2, lowValue: 15 })],
  current: CURRENT,
  hourly: hours(Date.parse('2026-09-24T12:00:00Z'), 3),
  todayDate: '2026-09-24',
  now: NOW,
  timezone: 'Europe/London',
  hour12: false,
};

describe('the Today card', () => {
  it('leads with the reading now, and says the rest of today under it', () => {
    const card = todayCard(INPUT)!;
    expect(card.mode).toBe('now');
    expect(card.lede).toBe('19°');
    expect(card.ledeLow).toBeUndefined();
    expect([card.high, card.low]).toEqual(['22°', '13°']);
    expect(card.condition).toBe('Mainly clear');
    expect(card.feels).toBe('Feels like 18°');
    // The sky and the glyph are the reading's, not the day's.
    expect(card.glyph).toBe('mostly-clear');
    expect(card.sky).toBe('day');
    expect(card.motion).toBe('glow');
    expect(card.days).toEqual([{ name: 'Fri', high: '23°', low: '15°' }]);
  });

  it('degrades to today’s high and low as the lede with no reading to call now (P3.4)', () => {
    const card = todayCard({ ...INPUT, current: undefined })!;
    expect(card.mode).toBe('forecast');
    expect(card.lede).toBe('22°');
    expect(card.ledeLow).toBe('13°');
    // Nothing that only a measurement could say.
    expect(card.feels).toBeUndefined();
    expect([card.high, card.low]).toEqual([undefined, undefined]);
    // The day's own words and sky.
    expect(card.condition).toBe('Overcast');
    expect(card.glyph).toBe('cloudy');
    expect(card.sky).toBe('cloud');
  });

  it('takes the dark from the next hour when there is no reading', () => {
    const night = todayCard({ ...INPUT, current: undefined, days: [day('2026-09-24', { glyph: 'clear' })], hourly: hours(NOW, 2, false) })!;
    expect(night.sky).toBe('night');
    expect(night.motion).toBe('none');
    const noHours = todayCard({ ...INPUT, current: undefined, days: [day('2026-09-24', { glyph: 'clear' })], hourly: [] })!;
    expect(noHours.sky).toBe('day');
  });

  it('says nothing at all with neither a reading nor a today', () => {
    expect(todayCard({ ...INPUT, current: undefined, days: [day('2026-09-25')] })).toBeUndefined();
    expect(todayCard({ ...INPUT, current: undefined, days: [] })).toBeUndefined();
    // A reading alone is still a card: the lede, with no range under it.
    const lone = todayCard({ ...INPUT, days: [] })!;
    expect(lone.lede).toBe('19°');
    expect([lone.high, lone.low]).toEqual([undefined, undefined]);
  });

  it('calls the hour that has begun "Now", and names the rest in the wall’s own clock', () => {
    expect(todayCard(INPUT)!.hours.map((hour) => hour.label)).toEqual(['Now', '14', '15']);
    expect(todayCard({ ...INPUT, hour12: true })!.hours.map((hour) => hour.label)).toEqual(['Now', '2 pm', '3 pm']);
    // In the household's zone, not the device's or UTC.
    expect(hourLabel(Date.parse('2026-09-24T18:00:00Z'), 'America/New_York', false)).toBe('14');
    expect(hourLabel(Date.parse('2026-09-24T18:00:00Z'), 'America/New_York', true)).toBe('2 pm');
  });
});

describe('which day is today', () => {
  it('is the one dated today, or an undated first day, and never another day’s', () => {
    const today = day('2026-09-24');
    expect(todayOf([day('2026-09-23'), today], '2026-09-24')).toBe(today);
    const undated = day(undefined);
    expect(todayOf([undated], '2026-09-24')).toBe(undated);
    // A forecast saved yesterday, redrawn today, has no today in it.
    expect(todayOf([day('2026-09-23')], '2026-09-24')).toBeUndefined();
    expect(todayOf([], '2026-09-24')).toBeUndefined();
  });
});

describe('what the advice line reads', () => {
  it('reads the day’s figures, in the panel’s units', () => {
    const input = adviceInput(
      day('2026-09-24', { precipChance: 60, uvMax: 3, windMax: 12 }),
      CURRENT,
      { temp: 'C', wind: 'km/h', precip: 'mm' },
    );
    expect(input).toEqual({ precipChance: 60, high: 22.1, tempUnit: 'C', uv: 3, wind: 12, windUnit: 'km/h' });
  });

  it('falls back to the reading’s UV and wind where the day has none, as NWS publishes no daily UV', () => {
    const input = adviceInput(day('2026-09-24'), CURRENT, { temp: 'F', wind: 'mph', precip: 'in' });
    expect(input.uv).toBe(2.55);
    expect(input.wind).toBe(3.6);
    expect(input.tempUnit).toBe('F');
  });

  it('leaves out a wind whose unit nobody said, and takes the day’s scale for a temperature', () => {
    const input = adviceInput(day('2026-09-24', { windMax: 50 }), undefined, undefined);
    expect(input.wind).toBeUndefined();
    expect(input.windUnit).toBeUndefined();
    expect(input.tempUnit).toBe('C');
  });
});
