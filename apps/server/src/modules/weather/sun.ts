/**
 * Sunrise and sunset, calculated rather than fetched (plan item P3.3).
 *
 * NWS has no per-day sun times — `astronomicalData` on the points document is
 * today's only — and a forecast that says when it gets dark on Saturday is
 * worth more than one that does not. So they are worked out here, for every
 * provider, and Open-Meteo's own values are preferred where it sends them.
 *
 * This is the NOAA solar-position algorithm (the one behind NOAA's online
 * solar calculator, from Meeus's *Astronomical Algorithms*): the sun's
 * declination and the equation of time at an instant, the hour angle at which
 * its centre is 0.833° below the horizon (half its disc plus the standard
 * refraction), and one refinement at the estimate itself, because the sun
 * moves during the hours between local noon and the event.
 *
 * **Pure, and no `Intl`.** The zone offset is passed in by the caller, the way
 * `packages/core`'s interrupts are handed their wall-clock reading, so every
 * branch here is arithmetic a test can reach without a platform time zone
 * database. The offset is minutes east of UTC — `-240` for New York in summer.
 *
 * **A day with no sunrise is a fact, not a failure.** Above the polar circles
 * the sun stays up (or down) for weeks, and the answer then is a kind rather
 * than a time: a wall drawing "sunrise 00:00" on a Tromsø midsummer is the
 * sentinel Open-Meteo uses, not something a household can read.
 */

export type SunDay =
  | {
      readonly kind: 'rises';
      /** Instants, ms since the epoch. */
      readonly sunriseAt: number;
      readonly sunsetAt: number;
      /** Local ISO, `YYYY-MM-DDTHH:MM`, in the offset the caller passed. */
      readonly sunrise: string;
      readonly sunset: string;
    }
  | { readonly kind: 'polar-day' }
  | { readonly kind: 'polar-night' };

const RADIANS = Math.PI / 180;
const DEGREES = 180 / Math.PI;
const MINUTE = 60_000;
const DAY = 86_400_000;
/** 0.833° below the geometric horizon: half the sun's disc plus refraction. */
const ZENITH = 90.833;

/** Julian centuries since J2000.0 for an instant. */
function julianCentury(instantMs: number): number {
  const julianDay = instantMs / DAY + 2440587.5;
  return (julianDay - 2451545.0) / 36525.0;
}

function normalise(degrees: number): number {
  const reduced = degrees % 360;
  return reduced < 0 ? reduced + 360 : reduced;
}

interface SolarPosition {
  /** Degrees. */
  readonly declination: number;
  /** Minutes: apparent solar time minus mean solar time. */
  readonly equationOfTime: number;
}

function solarPosition(t: number): SolarPosition {
  const meanLongitude = normalise(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const m = meanAnomaly * RADIANS;
  const centre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RADIANS);

  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const meanObliquity = 23 + (26 + seconds / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RADIANS);

  const declination =
    Math.asin(Math.sin(obliquity * RADIANS) * Math.sin(apparentLongitude * RADIANS)) * DEGREES;

  const y = Math.tan((obliquity * RADIANS) / 2) ** 2;
  const l0 = meanLongitude * RADIANS;
  const equation =
    y * Math.sin(2 * l0) -
    2 * eccentricity * Math.sin(m) +
    4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * m);

  return { declination, equationOfTime: 4 * equation * DEGREES };
}

/**
 * The cosine of the hour angle at which the sun crosses the horizon.
 *
 * Outside [-1, 1] there is no crossing: above 1 the sun never climbs to the
 * horizon, below -1 it never falls to it.
 */
function horizonCosine(latitude: number, declination: number): number {
  const phi = latitude * RADIANS;
  const delta = declination * RADIANS;
  return Math.cos(ZENITH * RADIANS) / (Math.cos(phi) * Math.cos(delta)) - Math.tan(phi) * Math.tan(delta);
}

/**
 * One event, as minutes after 00:00 UTC of `dayStart`, evaluated at `atMs`.
 * Undefined when the sun does not cross the horizon at that instant.
 */
function eventMinutes(
  rising: boolean,
  atMs: number,
  latitude: number,
  longitude: number,
): number | undefined {
  const { declination, equationOfTime } = solarPosition(julianCentury(atMs));
  const cosine = horizonCosine(latitude, declination);
  if (cosine > 1 || cosine < -1) return undefined;
  const hourAngle = Math.acos(cosine) * DEGREES;
  // Longitude is east-positive; the sun reaches it earlier the further east.
  return 720 - 4 * (longitude + (rising ? hourAngle : -hourAngle)) - equationOfTime;
}

/** `YYYY-MM-DD` as 00:00 UTC of that date, or undefined when it is not one. */
function utcMidnight(date: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const check = new Date(at);
  // Reject 2026-02-30 rather than rolling it into March.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return at;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * An instant as local ISO in a fixed offset, rounded to the nearest minute.
 *
 * Rounded rather than truncated: a sunset at 19:01:40 is closer to 19:02, and
 * a minute is the resolution anybody reads it at.
 */
export function localIso(instantMs: number, offsetMinutes: number): string {
  const rounded = Math.round(instantMs / MINUTE) * MINUTE;
  const local = new Date(rounded + offsetMinutes * MINUTE);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/**
 * Sunrise and sunset for a civil date at a place.
 *
 * `date` is the household's own calendar date. The events are the ones nearest
 * that date's local solar noon — which is the date's own morning and evening
 * everywhere a person lives, including either side of the date line, because
 * the estimate starts from the longitude rather than from UTC midnight.
 *
 * Undefined for a date that is not one or coordinates that are not finite, so
 * a caller can leave the field absent rather than draw a guess.
 */
export function sunDay(
  date: string,
  latitude: number,
  longitude: number,
  offsetMinutes: number,
): SunDay | undefined {
  const midnight = utcMidnight(date);
  if (
    midnight === undefined ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(offsetMinutes) ||
    Math.abs(latitude) > 90
  ) {
    return undefined;
  }

  /*
   * Evaluated first at local solar noon, which is where the sun is highest, so
   * "no crossing" there means it never rises and "no crossing" at midnight's
   * geometry means it never sets. The NOAA spreadsheet evaluates at 00:00 UTC,
   * which is fine in Greenwich and half a day off in Sydney.
   */
  const noon = midnight + (720 - 4 * longitude) * MINUTE;
  const { declination } = solarPosition(julianCentury(noon));
  const cosine = horizonCosine(latitude, declination);
  if (cosine > 1) return { kind: 'polar-night' };
  if (cosine < -1) return { kind: 'polar-day' };

  const refine = (rising: boolean): number => {
    // Approximate at noon, then once more at the approximation itself.
    const first = eventMinutes(rising, noon, latitude, longitude) as number;
    const second = eventMinutes(rising, midnight + first * MINUTE, latitude, longitude);
    // The sun skimming the horizon on the edge of a polar season can cross at
    // noon's declination and not at the event's; the first answer stands then.
    return midnight + (second ?? first) * MINUTE;
  };

  const sunriseAt = refine(true);
  const sunsetAt = refine(false);
  return {
    kind: 'rises',
    sunriseAt,
    sunsetAt,
    sunrise: localIso(sunriseAt, offsetMinutes),
    sunset: localIso(sunsetAt, offsetMinutes),
  };
}

/**
 * Whether the sun is up at an instant, for a provider that does not say.
 *
 * Asked of the local date the instant falls on in the caller's offset, and of
 * the day before it: a Reykjavik midsummer sunset is at 00:02 the next morning,
 * so at 00:01 the sun belongs to yesterday's arc. A polar day is up and a
 * polar night is down; `undefined` only for input that is not a place or a
 * time.
 */
export function sunIsUp(
  instantMs: number,
  latitude: number,
  longitude: number,
  offsetMinutes: number,
): boolean | undefined {
  if (!Number.isFinite(instantMs)) return undefined;
  const date = localIso(instantMs, offsetMinutes).slice(0, 10);
  const day = sunDay(date, latitude, longitude, offsetMinutes);
  if (day === undefined) return undefined;
  if (day.kind === 'polar-day') return true;
  if (day.kind === 'polar-night') return false;
  if (instantMs >= day.sunriseAt && instantMs < day.sunsetAt) return true;
  const yesterday = localIso(instantMs - DAY, offsetMinutes).slice(0, 10);
  const before = sunDay(yesterday, latitude, longitude, offsetMinutes);
  return before?.kind === 'rises' && instantMs >= before.sunriseAt && instantMs < before.sunsetAt;
}
