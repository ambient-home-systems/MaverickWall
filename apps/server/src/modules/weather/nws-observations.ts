import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';
import { glyphFor } from './nws.js';
import {
  celsiusToFahrenheit,
  compassPoint,
  kmhToMph,
  tenth,
  type ConditionsReading,
} from './readings.js';

/**
 * What it is like outside now, from the nearest NWS station (plan item P3.1).
 *
 * Two requests, and the first is kept: the points document names a list of
 * stations nearest the gridpoint, which is resolved once and cached like the
 * gridpoint itself (`nws:stations`), and the nearest one's latest observation
 * is read every fifteen minutes.
 *
 * **A station often has no temperature.** Automated stations drop fields, and
 * the answer is `"temperature": {"value": null}` rather than a missing field —
 * the captured Washington observation has four such nulls in it (wind speed,
 * direction and gust, and the sea-level pressure). The reading is kept with its
 * null, and the fallback to the hourly forecast is decided once, at assembly
 * (`presentCurrent`), where the clock is.
 *
 * **The values are SI and the panel is not.** NWS answers a forecast in
 * Fahrenheit and mph, and an observation in Celsius and km/h; a panel that
 * mixed them would say 12 beside 66. Each quantity is converted by the unit
 * code it carries, and a code this does not know is not a number to draw.
 */

/** A station identifier: "KDCA", "KCGS". Letters and digits, nothing a path could hide in. */
const STATION_ID = /^[A-Z0-9]{3,8}$/;

/**
 * How many stations to keep from the list.
 *
 * The owner's capture asked for five and the parser keeps five. Only the
 * nearest is read; the rest are the list a later change would try in turn.
 */
export const STATION_LIMIT = 5;

export function stationsUrl(listUrl: string): string {
  const url = new URL(listUrl);
  url.searchParams.set('limit', String(STATION_LIMIT));
  return url.toString();
}

/**
 * The latest-observation URL for a station.
 *
 * Built on a constant host from an identifier this has already validated,
 * rather than followed from the document: the station list is the one answer
 * here that names a *station*, and a name is all it needs to have given.
 */
export function observationUrl(stationId: string): string {
  return `https://api.weather.gov/stations/${stationId}/observations/latest`;
}

const stationsDocument = z.looseObject({
  features: z
    .array(
      z.looseObject({
        properties: z.looseObject({ stationIdentifier: z.string() }).catch({ stationIdentifier: '' }),
      }),
    )
    .catch([]),
});

/** The station identifiers, nearest first, as the list gives them. */
export function parseStations(body: string): string[] {
  const document = parseJsonOr(stationsDocument, body, { features: [] });
  const ids: string[] = [];
  for (const feature of document.features) {
    const id = feature.properties.stationIdentifier.toUpperCase();
    if (STATION_ID.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length >= STATION_LIMIT) break;
  }
  return ids;
}

/**
 * One of NWS's quantities: a value, a WMO unit code, and a quality flag.
 *
 * `X` is NWS's "rejected" flag, and a value it rejected is read as the null it
 * should have been.
 */
const quantity = z
  .looseObject({
    unitCode: z.string().catch(''),
    value: z.number().nullish().catch(null),
    qualityControl: z.string().optional().catch(undefined),
  })
  .nullish()
  .catch(null);

type Quantity = z.infer<typeof quantity>;

const observationDocument = z.looseObject({
  properties: z.looseObject({
    timestamp: z.string(),
    textDescription: z.string().nullish().catch(''),
    temperature: quantity,
    windChill: quantity,
    heatIndex: quantity,
    relativeHumidity: quantity,
    windSpeed: quantity,
    windGust: quantity,
    windDirection: quantity,
  }),
});

function valueOf(q: Quantity): number | undefined {
  if (q === null || q === undefined || q.qualityControl === 'X') return undefined;
  const value = q.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A temperature in Fahrenheit, by the unit code it came with. */
function fahrenheit(q: Quantity): number | undefined {
  const value = valueOf(q);
  if (value === undefined) return undefined;
  if (q?.unitCode === 'wmoUnit:degC') return celsiusToFahrenheit(value);
  if (q?.unitCode === 'wmoUnit:degF') return tenth(value);
  return undefined;
}

/** A speed in mph, by the unit code it came with. */
function mph(q: Quantity): number | undefined {
  const value = valueOf(q);
  if (value === undefined) return undefined;
  if (q?.unitCode === 'wmoUnit:km_h-1') return kmhToMph(value);
  if (q?.unitCode === 'wmoUnit:m_s-1') return kmhToMph(value * 3.6);
  return undefined;
}

/**
 * Read a latest-observation document.
 *
 * Undefined when it is not one, or its timestamp is not a time — a reading
 * that cannot say when it was taken cannot be held to the ninety minutes.
 * `isDayAt` is the NOAA sun at the station's reading, which the observation
 * does not state.
 */
export function parseObservation(
  body: string,
  isDayAt: (instantMs: number) => boolean | undefined,
): ConditionsReading | undefined {
  const document = parseJsonOr(observationDocument, body, null);
  if (document === null) return undefined;
  const p = document.properties;
  const observedAt = Date.parse(p.timestamp);
  if (!Number.isFinite(observedAt)) return undefined;

  const temp = fahrenheit(p.temperature);
  // The plan's order: wind chill, then heat index, then the air temperature.
  const feelsLike = fahrenheit(p.windChill) ?? fahrenheit(p.heatIndex) ?? temp;
  const condition = (p.textDescription ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const humidity =
    p.relativeHumidity?.unitCode === 'wmoUnit:percent' ? valueOf(p.relativeHumidity) : undefined;
  const windSpeed = mph(p.windSpeed);
  const windGust = mph(p.windGust);
  const bearing =
    p.windDirection?.unitCode === 'wmoUnit:degree_(angle)' ? valueOf(p.windDirection) : undefined;
  const windDir = bearing === undefined ? undefined : compassPoint(bearing);

  return {
    observedAt,
    temp: temp ?? null,
    ...(feelsLike === undefined ? {} : { feelsLike }),
    condition,
    glyph: glyphFor(condition),
    isDay: isDayAt(observedAt) ?? true,
    ...(humidity === undefined ? {} : { humidity: Math.round(humidity) }),
    ...(windSpeed === undefined ? {} : { windSpeed }),
    ...(windGust === undefined ? {} : { windGust }),
    ...(windDir === undefined ? {} : { windDir }),
  };
}

const fetchOptions = {
  policy: {},
  maxBytes: FETCH_LIMITS.json,
  acceptContentTypes: ['application/geo+json', 'application/json'],
  timeoutMs: 12_000,
  userAgent: DEFAULT_USER_AGENT,
} as const;

/** The stations nearest the gridpoint, or undefined when the list could not be had. */
export async function fetchStations(fetcher: Fetcher, listUrl: string): Promise<string[] | undefined> {
  const response = await fetcher.fetch({ url: stationsUrl(listUrl), ...fetchOptions });
  if (response.status !== 'ok') return undefined;
  const ids = parseStations(response.body);
  return ids.length === 0 ? undefined : ids;
}

/** A station's latest observation, or undefined when it could not be had. */
export async function fetchObservation(
  fetcher: Fetcher,
  stationId: string,
  isDayAt: (instantMs: number) => boolean | undefined,
): Promise<ConditionsReading | undefined> {
  if (!STATION_ID.test(stationId)) return undefined;
  const response = await fetcher.fetch({ url: observationUrl(stationId), ...fetchOptions });
  return response.status === 'ok' ? parseObservation(response.body, isDayAt) : undefined;
}
