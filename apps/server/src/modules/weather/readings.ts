import type { GlyphKey } from '../../glyphs.js';
import type { Forecast } from './nws.js';
import { PROVIDER_FACTS, type Provider } from './providers.js';

/**
 * The weather panel's richer half (plan item P3.1), as shapes and arithmetic.
 *
 * Everything here is optional on the panel and **spread, never null**: a
 * provider that cannot supply a field leaves it out. That is the `layoutGutter`
 * rule one module along, and for the same reason — the manifest's ETag hashes
 * the serialisation, so a `"current": null` on every wall in the world would
 * move every stored ETag at one image pull for a household that gained nothing.
 *
 * Pure, and no zone of its own (`dayLabel` asks `Intl` for a weekday in UTC
 * alone): the only things that need a zone (the sun's local times,
 * and whether it is up) are computed by the callers and handed in.
 */

/**
 * What one provider's answer holds, part by part; any part may be missing.
 *
 * Every provider but NWS reads into this one shape, so the job writes each
 * part it was due and keeps the last good copy of any part an answer did not
 * carry (keep-last-good per part, plan item P3.2).
 */
export interface WeatherParts {
  readonly forecast?: Forecast;
  readonly current?: ConditionsReading;
  readonly hours?: readonly HourRecord[];
}

export type PartsResult =
  | { readonly ok: true; readonly parts: WeatherParts }
  | { readonly ok: false; readonly message: string; readonly suggestion?: string };

/**
 * What every reader is handed, bound to one household.
 *
 * `localTime` and `isDayAt` come from `sun.ts` through the household's zone;
 * `sunFor` is the NOAA sunrise for a date, for a provider whose answer carries
 * none. Each is optional so a parser stays testable with nothing but a body.
 */
export interface ReadOptions {
  readonly now: number;
  readonly units: 'metric' | 'imperial';
  readonly todayIso: string;
  readonly limit: number;
  readonly localTime?: (instantMs: number) => string;
  readonly isDayAt?: (instantMs: number) => boolean | undefined;
  readonly sunFor?: (date: string) => { sunrise?: string; sunset?: string };
}

/** The household's civil date at an instant, from `localTime`, or UTC's without one. */
export function localDateOf(instantMs: number, options: Pick<ReadOptions, 'localTime'>): string {
  return (options.localTime?.(instantMs) ?? new Date(instantMs).toISOString()).slice(0, 10);
}

/** A number the provider sent, or nothing — never a zero standing in for "unknown". */
export function present(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The weekday label for an ISO date, tz-agnostic; the first is "Today". */
export function dayLabel(dateIso: string, todayIso: string): string {
  if (dateIso === todayIso) return 'Today';
  // Anchored at UTC midnight so the weekday is the calendar date's own, not a
  // reading shifted across a zone boundary.
  const at = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return dateIso;
  return new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(at);
}

/** The units a panel's numbers are in, beside the temperature's own letter. */
export interface WeatherUnits {
  readonly temp: 'F' | 'C';
  readonly wind: 'mph' | 'km/h';
  readonly precip: 'in' | 'mm';
}

/** What it is like outside now, measured (NWS) or modelled (Open-Meteo). */
export interface CurrentWeather {
  /** When it was measured or modelled, ms since the epoch. */
  readonly observedAt: number;
  readonly source: 'observed' | 'modelled';
  readonly temp: number;
  readonly feelsLike?: number;
  /** Words: "Light rain", "Mostly Cloudy". Empty when the provider said none. */
  readonly condition: string;
  readonly glyph: GlyphKey | null;
  readonly isDay: boolean;
  /** Percent. */
  readonly humidity?: number;
  readonly windSpeed?: number;
  readonly windGust?: number;
  /** A compass point, "NW". */
  readonly windDir?: string;
  readonly uv?: number;
  /** Sunlight reaching the ground, W/m² — Open-Meteo's `shortwave_radiation` (plan item M5.6). */
  readonly solar?: number;
}

/** One hour of the next twenty-four, as the manifest carries it. */
export interface HourlyWeather {
  readonly at: number;
  readonly temp: number;
  readonly glyph: GlyphKey | null;
  readonly isDay: boolean;
  /** Percent. */
  readonly precipChance?: number;
}

/**
 * One hour as it is cached, which is more than the manifest carries.
 *
 * The extra fields are what NWS's fallback needs: when the station has no
 * temperature, the hourly period covering now *is* the current conditions, and
 * those need words and wind as well as a number (plan item P3.4).
 */
export interface HourRecord extends HourlyWeather {
  /** When the hour ends. */
  readonly end: number;
  readonly condition?: string;
  readonly humidity?: number;
  readonly windSpeed?: number;
  readonly windDir?: string;
}

export interface AirQuality {
  readonly aqi: number;
  readonly scale: 'us' | 'eu';
  /** "Good", "Moderate" — the scale's own category, in words. */
  readonly label: string;
  readonly observedAt: number;
  /*
   * The pollutants behind the index and the UV, for the Environment widget
   * (plan item M5.6), each spread only when the service reported it. Mass
   * concentrations in µg/m³, as the service reports them.
   */
  readonly pm25?: number;
  readonly pm10?: number;
  readonly ozone?: number;
  readonly no2?: number;
  readonly uv?: number;
  /**
   * Pollen, grains/m³, by plant — **present only where the service models
   * pollen at all**, which is Europe. There it is the plants with any pollen
   * in the air, so an empty object says "none today"; elsewhere the service
   * answers null for every plant and the field is absent, which says "not
   * available here". Two facts, two shapes.
   */
  readonly pollen?: Readonly<Partial<Record<PollenPlant, number>>>;
}

/** The plants the air-quality service models pollen for, in Europe. */
export const POLLEN_PLANTS = ['alder', 'birch', 'grass', 'mugwort', 'olive', 'ragweed'] as const;
export type PollenPlant = (typeof POLLEN_PLANTS)[number];

/**
 * A reading of the conditions, with the temperature it may not have.
 *
 * NWS stations often report `temperature: null`, and the cache keeps that
 * answer as it came so the decision to fall back is taken in one place — at
 * assembly, against the clock — rather than twice.
 */
export interface ConditionsReading extends Omit<CurrentWeather, 'temp' | 'source'> {
  readonly temp: number | null;
}

/**
 * How old "now" may be (plan item P3.4).
 *
 * Current conditions refresh every fifteen minutes, so ninety is six missed
 * refreshes — a provider that has been down for an hour and a half. Past that a
 * reading is history, and a wall drawing it as the temperature outside is
 * wrong in the way that looks right.
 */
export const CURRENT_MAX_AGE_MS = 90 * 60_000;

/**
 * How old an air-quality reading may be.
 *
 * Longer than conditions, deliberately: the service models it hourly and
 * stamps the top of the hour, so a reading fetched at 08:59 is already an hour
 * old, and one cached for its full hour is two. Three is one missed refresh.
 */
export const AIR_MAX_AGE_MS = 3 * 60 * 60_000;

/** One decimal place: enough to round honestly later, and no more. */
export function tenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function celsiusToFahrenheit(celsius: number): number {
  return tenth((celsius * 9) / 5 + 32);
}

export function kmhToMph(kmh: number): number {
  return tenth(kmh / 1.609344);
}

/*
 * Conversions into the panel's units (plan item M5.8).
 *
 * A provider that answers in a unit the household did not choose — a Home
 * Assistant entity set up in another scale, OpenWeatherMap's metres per second
 * — is converted here, once, so a panel is never half one scale. A unit
 * nobody recognises is `undefined`: a number with no unit is not a reading.
 */

/** A temperature in the panel's scale, from a provider's own unit ("°C", "C", "°F"). */
export function temperatureIn(value: number, from: string, to: 'C' | 'F'): number | undefined {
  const unit = from.replace('°', '').trim().toUpperCase();
  if (unit !== 'C' && unit !== 'F') return undefined;
  if (unit === to) return value;
  return to === 'F' ? celsiusToFahrenheit(value) : tenth(((value - 32) * 5) / 9);
}

/** Metres per second of each wind unit a provider might send. */
const WIND_MPS: Readonly<Record<string, number>> = {
  'm/s': 1,
  'km/h': 1 / 3.6,
  mph: 0.44704,
  kn: 0.514444,
  'ft/s': 0.3048,
};

/** A wind speed in the panel's unit, from a provider's own. */
export function windIn(value: number, from: string, to: 'mph' | 'km/h'): number | undefined {
  const mps = WIND_MPS[from.trim()];
  if (mps === undefined) return undefined;
  if (from.trim() === to) return value;
  const metres = value * mps;
  return tenth(to === 'mph' ? metres / 0.44704 : metres * 3.6);
}

/** A rainfall in the panel's unit, from a provider's own ("mm", "in", "cm"). */
export function precipIn(value: number, from: string, to: 'in' | 'mm'): number | undefined {
  const unit = from.trim();
  const mm = unit === 'mm' ? value : unit === 'cm' ? value * 10 : unit === 'in' ? value * 25.4 : undefined;
  if (mm === undefined) return undefined;
  if (unit === to) return value;
  return to === 'mm' ? tenth(mm) : Math.round((mm / 25.4) * 100) / 100;
}

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;

/** Degrees to one of sixteen compass points, or undefined when it is not a bearing. */
export function compassPoint(degrees: number): string | undefined {
  if (!Number.isFinite(degrees)) return undefined;
  const turned = ((degrees % 360) + 360) % 360;
  return COMPASS[Math.round(turned / 22.5) % 16];
}

/** A compass point a provider wrote, kept only when it is one. */
export function knownCompassPoint(value: string): string | undefined {
  const upper = value.trim().toUpperCase();
  return (COMPASS as readonly string[]).includes(upper) ? upper : undefined;
}

/**
 * The current conditions to put on the wall, or none.
 *
 * In this order, and each step is the plan's:
 *
 * 1. The cached reading, when it has a temperature and is at most ninety
 *    minutes old. NWS's is a station's measurement, so it is `observed`;
 *    Open-Meteo's is a model, so it says so.
 * 2. For NWS only: the hourly period covering now, as `modelled`. That is the
 *    fallback for a station that sent `null`, and for one that stopped
 *    reporting — which is also what an hourly forecast *is* for the hour you
 *    are standing in. Open-Meteo's own current conditions are already that
 *    model, so a stale one has nothing better behind it.
 * 3. Nothing. The panel omits `current` and a style falls back to today's high
 *    and low (P5.1), which is true; a two-hour-old temperature labelled "now"
 *    is not.
 *
 * `now` is an argument so the ninety minutes is a test rather than a hope.
 */
export function presentCurrent(options: {
  readonly provider: Provider;
  readonly reading: ConditionsReading | undefined;
  readonly hours: readonly HourRecord[];
  readonly now: number;
}): CurrentWeather | undefined {
  const { provider, reading, hours, now } = options;

  if (reading !== undefined && reading.temp !== null && now - reading.observedAt <= CURRENT_MAX_AGE_MS) {
    return { ...reading, temp: reading.temp, source: PROVIDER_FACTS[provider].observed ? 'observed' : 'modelled' };
  }

  if (provider !== 'nws') return undefined;

  const hour = hours.find((candidate) => candidate.at <= now && now < candidate.end);
  if (hour === undefined) return undefined;
  return {
    observedAt: hour.at,
    source: 'modelled',
    temp: hour.temp,
    condition: hour.condition ?? '',
    glyph: hour.glyph,
    isDay: hour.isDay,
    ...(hour.humidity === undefined ? {} : { humidity: hour.humidity }),
    ...(hour.windSpeed === undefined ? {} : { windSpeed: hour.windSpeed }),
    ...(hour.windDir === undefined ? {} : { windDir: hour.windDir }),
  };
}

/**
 * The next twenty-four hours, as the manifest carries them.
 *
 * The cache is refreshed hourly, so by the end of its hour its first entry is
 * over; an hour that has ended is not "next", and is left off here rather than
 * by the renderer. Slimmed to the manifest's fields, because the cached extras
 * exist for the fallback above and nothing on a wall reads them.
 */
export function presentHourly(hours: readonly HourRecord[], now: number): HourlyWeather[] {
  return hours
    .filter((hour) => hour.end > now)
    .slice(0, 24)
    .map((hour) => ({
      at: hour.at,
      temp: hour.temp,
      glyph: hour.glyph,
      isDay: hour.isDay,
      ...(hour.precipChance === undefined ? {} : { precipChance: hour.precipChance }),
    }));
}

/**
 * An air-quality number's category, in the words of the scale it is on.
 *
 * US AQI is the EPA's six bands. The European index is the European
 * Environment Agency's, as Open-Meteo reports it: 0–20 good through over 100
 * extremely poor. A number outside either scale is not labelled at all.
 */
export function airLabel(aqi: number, scale: 'us' | 'eu'): string | undefined {
  if (!Number.isFinite(aqi) || aqi < 0) return undefined;
  if (scale === 'us') {
    if (aqi <= 50) return 'Good';
    if (aqi <= 100) return 'Moderate';
    if (aqi <= 150) return 'Unhealthy for sensitive groups';
    if (aqi <= 200) return 'Unhealthy';
    if (aqi <= 300) return 'Very unhealthy';
    return 'Hazardous';
  }
  if (aqi <= 20) return 'Good';
  if (aqi <= 40) return 'Fair';
  if (aqi <= 60) return 'Moderate';
  if (aqi <= 80) return 'Poor';
  if (aqi <= 100) return 'Very poor';
  return 'Extremely poor';
}
