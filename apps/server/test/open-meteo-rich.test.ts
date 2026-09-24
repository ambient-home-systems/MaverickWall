import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  airQualityUrl,
  airScaleFor,
  conditionWords,
  forecastUrl,
  parseAirQuality,
  parseOpenMeteo,
} from '../src/modules/weather/open-meteo.js';
import { GLYPH_KEYS } from '../src/glyphs.js';

/**
 * Open-Meteo's richer answer, read from bytes it sent (plan items P3.1, P3.6).
 *
 * Every document here was captured from the live API on 2026-09-24 with the
 * exact request `forecastUrl` and `airQualityUrl` build — the README beside
 * the fixtures has the URLs — for Washington in imperial and London in metric.
 * The existing `open-meteo.test.ts` still reads the older London capture, whose
 * days carry none of the new fields, which is the other half of the promise:
 * a document with nothing new in it parses to exactly what it always did.
 */

const REAL = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-meteo', 'real');
const read = (file: string): string => readFileSync(join(REAL, file), 'utf8');
const DC = read('forecast-dc-imperial.json');
const LONDON = read('forecast-london-metric.json');

/** New York in late September is four hours behind UTC. */
const newYork = (instantMs: number): string => {
  const local = new Date(instantMs - 4 * 3600_000);
  return local.toISOString().slice(0, 16);
};

const NOW = Date.parse('2026-09-24T12:31:00Z');

describe('the request', () => {
  it('sets the wind and rain units explicitly, never leaving them to the default', () => {
    // Left out, Open-Meteo answers km/h and millimetres whatever the
    // temperature is in, and an imperial wall would print kilometres as miles.
    const imperial = new URL(forecastUrl({ latitude: 38.8894, longitude: -77.0352 }, 'imperial', 5)).searchParams;
    expect(imperial.get('temperature_unit')).toBe('fahrenheit');
    expect(imperial.get('wind_speed_unit')).toBe('mph');
    expect(imperial.get('precipitation_unit')).toBe('inch');
    const metric = new URL(forecastUrl({ latitude: 51.5074, longitude: -0.1278 }, 'metric', 5)).searchParams;
    expect(metric.get('wind_speed_unit')).toBe('kmh');
    expect(metric.get('precipitation_unit')).toBe('mm');
  });

  it('asks for the current conditions, the next day of hours and the days in one request', () => {
    const params = new URL(forecastUrl({ latitude: 38.8894, longitude: -77.0352 }, 'imperial', 5)).searchParams;
    expect(params.get('current')?.split(',')).toEqual(expect.arrayContaining([
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'is_day',
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'uv_index',
    ]));
    expect(params.get('hourly')).toBe('temperature_2m,precipitation_probability,weather_code,is_day');
    expect(params.get('daily')?.split(',')).toEqual(expect.arrayContaining([
      'precipitation_probability_max', 'precipitation_sum', 'wind_speed_10m_max', 'uv_index_max',
      'sunrise', 'sunset',
    ]));
    expect(params.get('forecast_hours')).toBe('24');
  });

  it('was answered in the units it asked for — read off the captured documents themselves', () => {
    // The fixtures are only evidence for this parser if they came from this
    // request. Open-Meteo prints the unit it used beside every field.
    const dc = JSON.parse(DC) as { current_units: Record<string, string>; daily_units: Record<string, string> };
    expect(dc.current_units['temperature_2m']).toBe('°F');
    expect(dc.current_units['wind_speed_10m']).toBe('mp/h');
    expect(dc.daily_units['precipitation_sum']).toBe('inch');
    const london = JSON.parse(LONDON) as { current_units: Record<string, string>; daily_units: Record<string, string> };
    expect(london.current_units['wind_speed_10m']).toBe('km/h');
    expect(london.daily_units['precipitation_sum']).toBe('mm');
  });

  it('asks the second host for the two indices and nothing else', () => {
    const url = new URL(airQualityUrl({ latitude: 38.8894, longitude: -77.0352 }));
    expect(url.origin).toBe('https://air-quality-api.open-meteo.com');
    expect(url.searchParams.get('current')).toBe('us_aqi,european_aqi');
    expect(url.searchParams.get('latitude')).toBe('38.8894');
  });
});

describe('the current conditions', () => {
  it('reads Washington at 08:30, as an instant, modelled and in words', () => {
    const { current } = parseOpenMeteo(DC, { now: NOW, units: 'imperial', todayIso: '2026-09-24', limit: 5 });
    expect(current).toEqual({
      // 08:30 in the answer's own offset of -14400 s.
      observedAt: Date.parse('2026-09-24T12:30:00Z'),
      temp: 54,
      feelsLike: 49.7,
      condition: 'Overcast',
      glyph: 'cloudy',
      isDay: true,
      humidity: 79,
      windSpeed: 8.7,
      windGust: 24.8,
      // 13° is north-north-east on a sixteen-point rose.
      windDir: 'NNE',
      uv: 0.95,
    });
  });

  it('reads London in the units London asked for', () => {
    const { current } = parseOpenMeteo(LONDON, { now: NOW, units: 'metric', todayIso: '2026-09-24', limit: 5 });
    expect(current?.temp).toBe(19.4);
    expect(current?.windSpeed).toBe(3.6);
    expect(current?.condition).toBe('Mostly clear');
    // 13:30 at +3600 s.
    expect(current?.observedAt).toBe(Date.parse('2026-09-24T12:30:00Z'));
  });

  it('has words for every code the vocabulary draws, and none it would have to invent', () => {
    for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
      expect(conditionWords(code), `code ${code}`).not.toBe('');
    }
    expect(conditionWords(4)).toBe('');
    expect(conditionWords(-1)).toBe('');
  });
});

describe('the next twenty-four hours', () => {
  it('reads every hour as an instant with a glyph, the sun and the rain chance', () => {
    const { hours } = parseOpenMeteo(DC, { now: NOW, units: 'imperial', todayIso: '2026-09-24', limit: 5 });
    expect(hours).toHaveLength(24);
    const first = hours?.[0];
    // The hour the answer starts in: 08:00 New York.
    expect(first?.at).toBe(Date.parse('2026-09-24T12:00:00Z'));
    expect(first?.end).toBe(Date.parse('2026-09-24T13:00:00Z'));
    expect(first?.precipChance).toBe(0);
    for (const hour of hours ?? []) expect(GLYPH_KEYS).toContain(hour.glyph);
    // The fixture's own `is_day`: light until 19:00, dark from 20:00 to 06:00.
    const byLocalHour = new Map((hours ?? []).map((hour) => [newYork(hour.at).slice(11, 13), hour.isDay]));
    expect(byLocalHour.get('12')).toBe(true);
    expect(byLocalHour.get('23')).toBe(false);
    expect(byLocalHour.get('07')).toBe(true);
  });
});

describe('the days', () => {
  it('carries the rain chance and amount, the wind, the UV and the sun for each', () => {
    const { forecast } = parseOpenMeteo(DC, {
      now: NOW, units: 'imperial', todayIso: '2026-09-24', limit: 5, localTime: newYork,
    });
    expect(forecast?.days).toHaveLength(5);
    expect(forecast?.days.map((day) => day.precipChance)).toEqual([0, 2, 14, 14, 4]);
    expect(forecast?.days.map((day) => day.precipAmount)).toEqual([0, 0, 0, 0.035, 0]);
    expect(forecast?.days[0]).toMatchObject({
      name: 'Today',
      date: '2026-09-24',
      high: 62.3,
      low: 51.7,
      unit: 'F',
      summary: 'Overcast',
      glyph: 'cloudy',
      windMax: 11.7,
      uvMax: 4.45,
      // Round-tripped through an instant and back into the household's zone.
      sunrise: '2026-09-24T06:57',
      sunset: '2026-09-24T19:01',
    });
    expect(forecast?.days[3]?.summary).toBe('Drizzle');
  });

  /*
   * Open-Meteo prints every day in the one offset it answered in, so a forecast
   * that crosses a clock change puts the later days an hour off the wall's own
   * clock. Sydney went to daylight time on 4 October 2026 and the captured
   * spread runs on in +10:00 regardless — "05:27" on the 5th, when the kitchen
   * clock read 06:27. Re-expressed through the household's zone, it reads what
   * the clock does.
   */
  it('puts a sunrise after a clock change on the household’s clock, not the one Open-Meteo answered in', () => {
    const spread = JSON.parse(read('sun-spread.json')) as Array<{ timezone: string }>;
    const sydney = JSON.stringify(spread.find((loc) => loc.timezone === 'Australia/Sydney'));
    const inSydney = (instantMs: number): string =>
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(instantMs).replace(' ', 'T');
    const days = parseOpenMeteo(sydney, {
      now: NOW, units: 'metric', todayIso: '2026-06-25', limit: 200, localTime: inSydney,
    }).forecast?.days ?? [];
    const on = (date: string): string | undefined => days.find((day) => day.date === date)?.sunrise;
    // Before the change the two agree; after it, the wall's is an hour later.
    expect(on('2026-10-03')).toBe('2026-10-03T05:30');
    expect(on('2026-10-05')).toBe('2026-10-05T06:27');
    const printed = JSON.parse(sydney) as { daily: { time: string[]; sunrise: string[] } };
    expect(printed.daily.sunrise[printed.daily.time.indexOf('2026-10-05')]).toBe('2026-10-05T05:27');
  });

  it('keeps millimetres in millimetres', () => {
    const { forecast } = parseOpenMeteo(LONDON, { now: NOW, units: 'metric', todayIso: '2026-09-24', limit: 5 });
    expect(forecast?.days.map((day) => day.precipAmount)).toEqual([0, 0.1, 0.2, 3.7, 4.4]);
    expect(forecast?.days[3]?.windMax).toBe(19.4);
  });

  /*
   * Open-Meteo's polar sentinel, from its own bytes: McMurdo's winter and
   * 86°N's summer out of the captured sun spread. Sunrise at midnight is a
   * way of saying "no sunrise", and a wall drawing it as a time says the sun
   * rose at 00:00.
   */
  it('reads a day with no sunrise, and a day with no sunset, as no sun times at all', () => {
    const spread = JSON.parse(read('sun-spread.json')) as Array<{ timezone: string }>;
    const mcmurdo = JSON.stringify(spread.find((loc) => loc.timezone === 'Antarctica/McMurdo'));
    const arctic = JSON.stringify(spread.find((loc) => loc.timezone === 'Etc/GMT'));
    const polar = (body: string): readonly { sunrise?: string; sunset?: string; date?: string }[] =>
      parseOpenMeteo(body, { now: NOW, units: 'metric', todayIso: '2026-06-25', limit: 200 }).forecast?.days ?? [];

    const winter = polar(mcmurdo);
    expect(winter[0]?.sunrise).toBeUndefined();
    expect(winter[0]?.sunset).toBeUndefined();
    // … and its sun back on 9 October.
    expect(winter.at(-1)?.sunrise).toBe('2026-10-09T04:22');

    const summer = polar(arctic);
    expect(summer[0]?.sunrise).toBeUndefined();
    expect(summer[0]?.sunset).toBeUndefined();
    // 5 October on is the polar night, in the same sentinel's other form.
    expect(summer.at(-1)?.sunrise).toBeUndefined();
    // A day between them is a real one.
    expect(summer.find((day) => day.date === '2026-10-03')?.sunrise).toBe('2026-10-03T09:23');
  });
});

describe('parts that are missing or malformed', () => {
  it('returns each part on its own, so one that changed shape costs only itself', () => {
    const document = JSON.parse(DC) as Record<string, unknown>;
    document['hourly'] = { time: 'not a list' };
    document['current'] = { time: '2026-09-24T08:30' }; // no temperature
    const parts = parseOpenMeteo(JSON.stringify(document), { now: NOW, units: 'imperial', todayIso: '2026-09-24', limit: 5 });
    expect(parts.forecast?.days).toHaveLength(5);
    expect(parts.current).toBeUndefined();
    expect(parts.hours).toBeUndefined();
  });

  it('drops a rich field of the wrong type without dropping the day', () => {
    const document = JSON.parse(DC) as { daily: Record<string, unknown> };
    document.daily['uv_index_max'] = 'high';
    const { forecast } = parseOpenMeteo(JSON.stringify(document), { now: NOW, units: 'imperial', todayIso: '2026-09-24', limit: 5 });
    expect(forecast?.days[0]?.high).toBe(62.3);
    expect(forecast?.days[0]).not.toHaveProperty('uvMax');
  });

  it('places nothing in time without the offset the answer is written in', () => {
    const document = JSON.parse(DC) as Record<string, unknown>;
    delete document['utc_offset_seconds'];
    const parts = parseOpenMeteo(JSON.stringify(document), { now: NOW, units: 'imperial', todayIso: '2026-09-24', limit: 5 });
    expect(parts.current).toBeUndefined();
    expect(parts.hours).toBeUndefined();
    expect(parts.forecast?.days).toHaveLength(5);
  });
});

describe('air quality', () => {
  it('reads Washington on the US scale and London on the European one', () => {
    const dc = parseAirQuality(read('air-quality-dc.json'), airScaleFor('America/New_York'));
    expect(dc).toEqual({ aqi: 43, scale: 'us', label: 'Good', observedAt: Date.parse('2026-09-24T12:00:00Z') });
    const london = parseAirQuality(read('air-quality-london.json'), airScaleFor('Europe/London'));
    // 25 on the EEA's bands is "Fair"; the same 25 on the US one would be "Good".
    expect(london).toEqual({ aqi: 25, scale: 'eu', label: 'Fair', observedAt: Date.parse('2026-09-24T12:00:00Z') });
  });

  it('answers nothing for a document that is not one', () => {
    for (const body of ['', '{}', '{"current":{}}', 'null', '[]']) {
      expect(parseAirQuality(body, 'us')).toBeUndefined();
    }
  });
});
