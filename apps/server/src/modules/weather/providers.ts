/**
 * Where a forecast can come from (plan item M5.8), as one table.
 *
 * Seven sources, and each is a fact about where it works and what it asks of
 * a household: an account, a key, a Home Assistant connection, or nothing.
 * The Weather screen draws its choices from this table, the settings reader
 * refuses anything not in it, and the job routes by it — so a provider added
 * here is offered, stored and fetched, and one missing from it is none of the
 * three. No imports: `api/queries.ts` reads it, and it must not pull the
 * fetchers in with it.
 */

export const WEATHER_PROVIDERS = [
  'nws',
  'openmeteo',
  'dwd',
  'homeassistant',
  'openweathermap',
  'pirateweather',
  'wunderground',
] as const;

export type Provider = (typeof WEATHER_PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (WEATHER_PROVIDERS as readonly string[]).includes(value);
}

/**
 * A stored or posted provider, or the shipped default.
 *
 * NWS rather than nothing on a value nobody recognises, as it always was: a
 * typo must not cost a household their forecast strip.
 */
export function providerOr(value: unknown): Provider {
  return isProvider(value) ? value : 'nws';
}

/** The three that need a key the household pastes in, each sealed in `weather_keys`. */
export const KEYED_PROVIDERS = ['openweathermap', 'pirateweather', 'wunderground'] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export function isKeyedProvider(value: unknown): value is KeyedProvider {
  return typeof value === 'string' && (KEYED_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderFacts {
  /** What the household reads in the "Forecast from" list. */
  readonly name: string;
  /** Where it works, said in the list beside the name. */
  readonly reach: string;
  /** What each gives a wall, for the hint under the choice (plan item P3.8). */
  readonly about: string;
  /** The host a request goes to, named before anybody has asked it anything. */
  readonly host?: string;
  /** Whether "now" is measured (a station) or modelled. */
  readonly observed: boolean;
}

export const PROVIDER_FACTS: Readonly<Record<Provider, ProviderFacts>> = Object.freeze({
  nws: {
    name: 'National Weather Service',
    reach: 'US only',
    about:
      'The United States only. The conditions now are measured at the nearest weather station, and ' +
      'come from its hourly forecast when the station has no reading. Each day has its chance of ' +
      'rain, its wind and the forecaster’s own words.',
    host: 'api.weather.gov',
    observed: true,
  },
  openmeteo: {
    name: 'Open-Meteo',
    reach: 'worldwide',
    about:
      'Worldwide, with no account or key. The conditions now are modelled rather than measured. ' +
      'Each day also has its UV index and how much rain is expected.',
    host: 'api.open-meteo.com',
    observed: false,
  },
  dwd: {
    name: 'DWD ICON',
    reach: 'worldwide, finest over Europe',
    about:
      'The German weather service’s ICON model, through Open-Meteo, with no account or key. It is ' +
      'at its most detailed over Germany and the rest of Europe, and covers the whole world more ' +
      'coarsely. The conditions now are modelled. It reports no UV index.',
    host: 'api.open-meteo.com',
    observed: false,
  },
  homeassistant: {
    name: 'Home Assistant',
    reach: 'a weather entity of yours',
    about:
      'Whatever weather entity you choose from your Home Assistant — Met.no, a local station, or ' +
      'any integration that makes one. The forecast is read with Home Assistant’s own ' +
      '“get forecasts” service, which only reads. Nothing about the entity is sent to a wall.',
    observed: false,
  },
  openweathermap: {
    name: 'OpenWeatherMap',
    reach: 'worldwide, needs a key',
    about:
      'Worldwide, with a free key from openweathermap.org. Its forecast comes in three-hour steps, ' +
      'so each day’s high and low are the highest and lowest of those steps, and the hours ahead ' +
      'are three hours apart. A new key can take a couple of hours to start working.',
    host: 'api.openweathermap.org',
    observed: false,
  },
  pirateweather: {
    name: 'Pirate Weather',
    reach: 'worldwide, needs a key',
    about:
      'Worldwide, with a free key from pirateweather.net. The conditions now are modelled. Each ' +
      'day has its chance of rain, how much is expected and its UV index. The key travels in a ' +
      'header, never in the address.',
    host: 'api.pirateweather.net',
    observed: false,
  },
  wunderground: {
    name: 'Weather Underground',
    reach: 'needs a station owner’s key',
    about:
      'The five-day forecast from The Weather Company, with the free key Weather Underground gives ' +
      'the owner of a personal weather station. Name a station and the conditions now are measured ' +
      'there; without one there is no “now”. That key does not reach an hourly forecast, so there ' +
      'are no hours ahead.',
    host: 'api.weather.com',
    observed: true,
  },
});
