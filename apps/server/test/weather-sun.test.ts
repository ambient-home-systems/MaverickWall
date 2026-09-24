import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localIso, sunDay, sunIsUp } from '../src/modules/weather/sun.js';

/**
 * Sunrise and sunset, held to Open-Meteo's own answer (plan item P3.3).
 *
 * The reference is a real response: ten places from the equator to 86°N and
 * 78°S, every day from 25 June to 9 October 2026, captured once from the live
 * API (`fixtures/open-meteo/real/README.md`). That range was chosen for what it
 * holds rather than for convenience: the midnight sun at Tromsø and at 86°N, the
 * Antarctic polar night at McMurdo ending, the sun setting for the winter at
 * 86°N on 5 October, a Reykjavik sunset past midnight, and Sydney and Singapore
 * either side of the date line and far from their zones' meridians.
 *
 * Two things about the comparison are measurements rather than choices, and
 * both are stated where they are used. Open-Meteo computes for the grid cell it
 * reports rather than the point asked for (the requested coordinates miss by
 * up to eleven minutes at 86°N; the reported ones by under two), and it
 * **truncates** to the minute — the mean difference across 1,794 events is
 * +0.52 minutes, which is a truncation's signature — so the fair reference is
 * the middle of the minute it printed.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface SpreadLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly utc_offset_seconds: number;
  readonly daily: {
    readonly time: readonly string[];
    readonly sunrise: readonly string[];
    readonly sunset: readonly string[];
    readonly daylight_duration: readonly number[];
  };
}

const SPREAD = JSON.parse(
  readFileSync(join(FIXTURES, 'open-meteo', 'real', 'sun-spread.json'), 'utf8'),
) as SpreadLocation[];

/**
 * Open-Meteo's local time as an instant, at the middle of the minute it printed.
 *
 * It prints every time in the one `utc_offset_seconds` the response carries —
 * Sydney's sunrises run on without a jump across the 4 October clock change —
 * so that offset, and not the zone's, is what turns them back into instants.
 */
function reference(local: string, offsetSeconds: number): number {
  return Date.parse(`${local}:30Z`) - offsetSeconds * 1000;
}

/**
 * The crossing is ill-conditioned when the sun is barely rising or barely
 * setting, and that is geometry rather than error.
 *
 * The time the sun crosses the horizon moves by 1/sin(hour angle) minutes for
 * every minute of arc its declination is off, so as the hour angle nears 0° or
 * 180° — a day of under four hours or over twenty — a hundredth of a degree is
 * minutes. Those days are held to a looser bound rather than left out, and the
 * looser bound is what they measure.
 */
function grazing(daylightSeconds: number): boolean {
  return daylightSeconds < 4 * 3600 || daylightSeconds > 20 * 3600;
}

describe('against Open-Meteo, at ten latitudes over fifteen weeks', () => {
  it('covers the spread it claims to', () => {
    // A fixture quietly reduced to the easy places would pass everything below.
    const latitudes = SPREAD.map((loc) => loc.latitude);
    expect(Math.min(...latitudes)).toBeLessThan(-77);
    expect(Math.max(...latitudes)).toBeGreaterThan(86);
    expect(latitudes.some((lat) => Math.abs(lat) < 1)).toBe(true);
    expect(SPREAD.every((loc) => loc.daily.time.length === 107)).toBe(true);
  });

  it('lands within two minutes of every sunrise and sunset where the sun is not grazing the horizon', () => {
    let compared = 0;
    for (const loc of SPREAD) {
      const { daily } = loc;
      for (let i = 0; i < daily.time.length; i++) {
        const daylight = daily.daylight_duration[i] as number;
        if (daylight === 0 || daylight === 86_400 || grazing(daylight)) continue;
        const day = sunDay(daily.time[i] as string, loc.latitude, loc.longitude, loc.utc_offset_seconds / 60);
        expect(day?.kind, `${loc.latitude} on ${daily.time[i]}`).toBe('rises');
        if (day?.kind !== 'rises') continue;
        const rise = (day.sunriseAt - reference(daily.sunrise[i] as string, loc.utc_offset_seconds)) / 60_000;
        const set = (day.sunsetAt - reference(daily.sunset[i] as string, loc.utc_offset_seconds)) / 60_000;
        expect(Math.abs(rise), `sunrise at ${loc.latitude} on ${daily.time[i]}`).toBeLessThanOrEqual(2);
        expect(Math.abs(set), `sunset at ${loc.latitude} on ${daily.time[i]}`).toBeLessThanOrEqual(2);
        compared += 2;
      }
    }
    // 1,726 of the 1,794 events: the other 34 days are Reykjavik and Tromsø
    // near midsummer, McMurdo as its night ends, and two days at 86°N.
    expect(compared).toBeGreaterThan(1_700);
  });

  it('stays within five minutes on the days the sun only skims the horizon', () => {
    let grazed = 0;
    for (const loc of SPREAD) {
      const { daily } = loc;
      for (let i = 0; i < daily.time.length; i++) {
        const daylight = daily.daylight_duration[i] as number;
        if (daylight === 0 || daylight === 86_400 || !grazing(daylight)) continue;
        const day = sunDay(daily.time[i] as string, loc.latitude, loc.longitude, loc.utc_offset_seconds / 60);
        if (day?.kind !== 'rises') throw new Error(`${loc.latitude} on ${daily.time[i]}: ${day?.kind}`);
        const rise = (day.sunriseAt - reference(daily.sunrise[i] as string, loc.utc_offset_seconds)) / 60_000;
        const set = (day.sunsetAt - reference(daily.sunset[i] as string, loc.utc_offset_seconds)) / 60_000;
        expect(Math.abs(rise)).toBeLessThanOrEqual(5);
        expect(Math.abs(set)).toBeLessThanOrEqual(5);
        grazed++;
      }
    }
    expect(grazed).toBeGreaterThan(0);
  });

  it('agrees with Open-Meteo about every day the sun does not rise, and every day it does not set', () => {
    // Open-Meteo's way of saying so is a sentinel — sunrise at 00:00 and a
    // daylight of 0 or 86,400 seconds — and that is exactly the reading a wall
    // must never draw as a time.
    let nights = 0;
    let days = 0;
    for (const loc of SPREAD) {
      const { daily } = loc;
      for (let i = 0; i < daily.time.length; i++) {
        const daylight = daily.daylight_duration[i] as number;
        if (daylight !== 0 && daylight !== 86_400) continue;
        const day = sunDay(daily.time[i] as string, loc.latitude, loc.longitude, loc.utc_offset_seconds / 60);
        expect(day?.kind, `${loc.latitude} on ${daily.time[i]}`).toBe(daylight === 0 ? 'polar-night' : 'polar-day');
        if (daylight === 0) nights++;
        else days++;
      }
    }
    // McMurdo's winter and 86°N from 5 October; Tromsø's and 86°N's summer.
    expect(nights).toBeGreaterThan(50);
    expect(days).toBeGreaterThan(50);
  });

  it('has no sunrise at 86°N on 9 October, and neither does Open-Meteo', () => {
    const arctic = SPREAD.find((loc) => loc.latitude > 86);
    const i = arctic?.daily.time.indexOf('2026-10-09') ?? -1;
    expect(arctic?.daily.daylight_duration[i]).toBe(0);
    expect(sunDay('2026-10-09', arctic?.latitude ?? 0, arctic?.longitude ?? 0, 0)).toEqual({ kind: 'polar-night' });
  });
});

describe('against the National Weather Service', () => {
  /*
   * The points document carries today's sun times, to the second, and nothing
   * for any other day — which is why this module exists. It is still a second
   * reference, from a second algorithm, for the place the NWS fixtures are for.
   */
  const cases = [
    { file: 'nws/real/points.json', date: '2026-09-24' },
    { file: 'nws-points.json', date: '2026-08-01' },
  ];
  for (const { file, date } of cases) {
    it(`matches ${file}'s astronomicalData on ${date} to within a minute`, () => {
      const points = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as {
        geometry: { coordinates: [number, number] };
        properties: { astronomicalData: { sunrise: string; sunset: string } };
      };
      const [longitude, latitude] = points.geometry.coordinates;
      const day = sunDay(date, latitude, longitude, -240);
      if (day?.kind !== 'rises') throw new Error(String(day?.kind));
      const { sunrise, sunset } = points.properties.astronomicalData;
      expect(Math.abs(day.sunriseAt - Date.parse(sunrise)) / 60_000).toBeLessThanOrEqual(1);
      expect(Math.abs(day.sunsetAt - Date.parse(sunset)) / 60_000).toBeLessThanOrEqual(1);
    });
  }
});

describe('the local time it prints', () => {
  it('is in the offset it was handed, rounded to the nearest minute', () => {
    // 10:57:51 UTC is 06:57:51 in New York in September.
    expect(localIso(Date.parse('2026-09-24T10:57:51Z'), -240)).toBe('2026-09-24T06:58');
    expect(localIso(Date.parse('2026-09-24T10:57:29Z'), -240)).toBe('2026-09-24T06:57');
  });

  it('puts a sunset after midnight on the next date, which is where Open-Meteo puts it', () => {
    const reykjavik = SPREAD.find((loc) => loc.timezone === 'Atlantic/Reykjavik');
    if (reykjavik === undefined) throw new Error('no Reykjavik in the spread');
    const day = sunDay('2026-06-25', reykjavik.latitude, reykjavik.longitude, 0);
    if (day?.kind !== 'rises') throw new Error(String(day?.kind));
    expect(day.sunset.slice(0, 10)).toBe('2026-06-26');
    expect(reykjavik.daily.sunset[0]).toBe('2026-06-26T00:02');
  });

  it('reads a Sydney morning as that local date, not the UTC one before it', () => {
    // Sunrise is 20:00 UTC the day before; starting the estimate from UTC
    // midnight would have answered with the wrong day's sun.
    const day = sunDay('2026-06-25', -33.8489, 151.1955, 600);
    if (day?.kind !== 'rises') throw new Error(String(day?.kind));
    expect(day.sunrise.slice(0, 10)).toBe('2026-06-25');
    expect(day.sunset.slice(0, 10)).toBe('2026-06-25');
  });

  it('answers nothing rather than a guess for a date or a place that is not one', () => {
    expect(sunDay('2026-02-30', 51.5, 0, 0)).toBeUndefined();
    expect(sunDay('not a date', 51.5, 0, 0)).toBeUndefined();
    expect(sunDay('2026-06-25', 91, 0, 0)).toBeUndefined();
    expect(sunDay('2026-06-25', Number.NaN, 0, 0)).toBeUndefined();
  });
});

describe('whether the sun is up', () => {
  const dc = { latitude: 38.8894, longitude: -77.0352 };
  it('is day between sunrise and sunset and night outside it', () => {
    expect(sunIsUp(Date.parse('2026-09-24T12:00:00Z'), dc.latitude, dc.longitude, -240)).toBe(true);
    // 18:30 EDT, half an hour before a 19:02 sunset — the hour NWS's own
    // hourly `isDaytime` has already called night.
    expect(sunIsUp(Date.parse('2026-09-24T22:30:00Z'), dc.latitude, dc.longitude, -240)).toBe(true);
    expect(sunIsUp(Date.parse('2026-09-24T23:30:00Z'), dc.latitude, dc.longitude, -240)).toBe(false);
    expect(sunIsUp(Date.parse('2026-09-24T09:00:00Z'), dc.latitude, dc.longitude, -240)).toBe(false);
  });

  it('keeps yesterday’s sun up past midnight in a Reykjavik summer', () => {
    // 00:01 on 26 June, a minute before the 25th's sunset.
    expect(sunIsUp(Date.parse('2026-06-26T00:01:00Z'), 64.1396, -21.9716, 0)).toBe(true);
    expect(sunIsUp(Date.parse('2026-06-26T01:00:00Z'), 64.1396, -21.9716, 0)).toBe(false);
  });

  it('is up all day in a polar summer and down all day in a polar winter', () => {
    expect(sunIsUp(Date.parse('2026-06-25T00:00:00Z'), 86.0105, 0, 0)).toBe(true);
    expect(sunIsUp(Date.parse('2026-10-09T12:00:00Z'), 86.0105, 0, 0)).toBe(false);
  });
});
