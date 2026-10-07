import type { GlyphKey } from './glyphs.js';
import type { CurrentWeatherModel, WeatherDayModel, WeatherUnitsModel } from './viewmodel.js';
import { todayOf } from './weather-looks.js';
import { iconSetOf, type WeatherIconSet } from './weather-icons.js';

/**
 * The clock's weather line (plan item M5.10), as data.
 *
 * One line under a clock: a picture and the temperature, and whichever of the
 * humidity, the wind and the UV index the household asked for. The values are
 * the forecast panel's own, read from the model the forecast widget reads —
 * nothing is fetched for it and nothing new travels in the manifest.
 *
 * Pure, `weather-looks.ts`' seam: what the line says is answered here with no
 * DOM, so `clock-weather.test.ts` reads it, and `render.ts` only builds nodes.
 */

/** The readings a line may carry beside the temperature, in the order they are drawn. */
export const CLOCK_WEATHER_READINGS = ['humidity', 'wind', 'uv'] as const;
export type ClockWeatherReading = (typeof CLOCK_WEATHER_READINGS)[number];

export interface ClockWeatherOptions {
  /** Whether the line is drawn: `showWeather`, absent meaning off, the agenda's own key and reading. */
  readonly show: boolean;
  readonly readings: readonly ClockWeatherReading[];
  /** The picture set, the forecast widget's own `icons` key (M5.9). */
  readonly pictures: WeatherIconSet;
}

/** What a clock's config asks for. Anything unrecognised is left out rather than guessed at. */
export function clockWeatherOf(config: unknown): ClockWeatherOptions {
  const c = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const asked = Array.isArray(c['weatherReadings']) ? (c['weatherReadings'] as unknown[]) : [];
  return {
    show: c['showWeather'] === true,
    // In the line's own order, whatever order they were ticked in.
    readings: CLOCK_WEATHER_READINGS.filter((reading) => asked.includes(reading)),
    pictures: iconSetOf(config),
  };
}

export interface ClockWeatherLine {
  /** Whether the temperature is now's, or today's high and low because there is no now. */
  readonly mode: 'now' | 'today';
  readonly glyph: GlyphKey | undefined;
  readonly isDay: boolean;
  /** "14°", or "18° / 9°" for today's high and low. */
  readonly temp: string;
  /** "82%", "NW 12 km/h", "UV 3": the readings asked for that the forecast has. */
  readonly parts: readonly string[];
}

export interface ClockWeatherInput {
  readonly current: CurrentWeatherModel | undefined;
  readonly days: readonly WeatherDayModel[];
  readonly todayDate: string | undefined;
  readonly units: WeatherUnitsModel | undefined;
}

/**
 * The line for this forecast, or undefined when there is nothing true to say.
 *
 * **Now** when the forecast has a current reading recent enough to call now
 * (the server's ninety minutes and the wall's own again, `weatherFrom`), and
 * otherwise **today's high and low** — the Today card's rule (P3.4): a clock
 * must not put a morning's forecast beside the afternoon's time as though it
 * were the temperature outside. Humidity is a reading of now, so it is left
 * out without one; the wind and the UV fall back to the day's maximum, which is
 * the day's own figure rather than a guess. A wind with no unit the panel named
 * is left out: a number with no unit is not a reading.
 */
export function clockWeatherLine(
  input: ClockWeatherInput,
  readings: readonly ClockWeatherReading[],
): ClockWeatherLine | undefined {
  const now = input.current;
  const today = todayOf(input.days, input.todayDate);
  let temp: string;
  if (now !== undefined) {
    temp = now.temp;
  } else if (today !== undefined && today.highValue !== undefined && today.lowValue !== undefined) {
    // From the values rather than the strip's strings: the strip writes its
    // low with the unit after it ("13°C"), which beside a high reads as two
    // different scales.
    temp = `${Math.round(today.highValue)}° / ${Math.round(today.lowValue)}°`;
  } else {
    return undefined;
  }

  const parts: string[] = [];
  for (const reading of readings) {
    if (reading === 'humidity' && now?.humidity !== undefined) {
      parts.push(`${Math.round(now.humidity)}%`);
    }
    if (reading === 'wind') {
      const speed = now?.windSpeed ?? today?.windMax;
      if (speed !== undefined && input.units !== undefined) {
        const dir = now?.windSpeed !== undefined ? now.windDir : undefined;
        parts.push(`${dir === undefined ? '' : `${dir} `}${Math.round(speed)} ${input.units.wind}`);
      }
    }
    if (reading === 'uv') {
      const uv = now?.uv ?? today?.uvMax;
      if (uv !== undefined) parts.push(`UV ${Math.round(uv)}`);
    }
  }

  return {
    mode: now === undefined ? 'today' : 'now',
    glyph: now?.glyph ?? today?.glyph,
    isDay: now?.isDay ?? true,
    temp,
    parts,
  };
}
