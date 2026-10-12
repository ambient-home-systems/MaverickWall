import { wallClockInZone } from '@maverick-wall/calendar';

import { sunDay } from '../modules/weather/sun.js';

/**
 * What switches a wall to its daylight theme, resolved (plan item M8.7).
 *
 * Three answers to one question, and the clock is the floor under the other
 * two. A wall used to switch at two times the household typed, which is right
 * in June and an hour wrong by October; it can now switch at sunrise and
 * sunset where the house is, or when a Home Assistant entity says so — `sun.sun`
 * above the horizon, or any on/off sensor the household trusts more than the
 * sun (a light level, a "dark outside" helper).
 *
 * **Pure.** The caller reads the row and the household's location; this turns
 * them into what the wall is sent:
 *
 * - **A window** for the sun: today's sunrise and sunset as `HH:MM` in the
 *   wall's zone, which the wall evaluates on every draw exactly as it
 *   evaluates the hours a household typed. So a wall drawing from its stored
 *   copy with the server gone goes on switching, a minute or two off by the
 *   end of a week — the sun moves that little.
 * - **A state** for an entity: day or night, now. It cannot be a window,
 *   because a sensor says what it says and not when it will change. The
 *   server sends it only while Home Assistant's reading is fresh, and the
 *   wall honours it only while its own copy is (`DAYLIGHT_TRUST_MS` in the
 *   bundle), so a wall cut off from its server falls back to its hours
 *   rather than holding a night that ended.
 * - **Nothing**, which is the hours the household typed: the source is the
 *   clock, or the sun with no location set, or an entity Home Assistant has
 *   not answered for.
 */

/** A reading older than this is no longer the sky's; the clock decides. */
export const DAYLIGHT_FRESH_MS = 10 * 60_000;

export type DaylightSource = 'sun' | 'entity';

export const DAYLIGHT_SOURCES: readonly DaylightSource[] = ['sun', 'entity'];

/** The entity domains whose state can say day or night, and nothing else. */
export const DAYLIGHT_ENTITY_PATTERN = /^(sun|binary_sensor|input_boolean)\.[a-z0-9_]{1,200}$/;

export type ResolvedDaylight =
  | { readonly startsAt: string; readonly endsAt: string }
  | { readonly now: boolean };

export interface DaylightInput {
  readonly source: string | null;
  readonly state: number | null;
  readonly readAt: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly timezone: string;
  readonly now: number;
}

/**
 * Whether a Home Assistant state says daylight: `sun.*` by its own two words,
 * anything else as a switch, `on` for daylight. Null is a state that is
 * neither — `unavailable`, `unknown` — which is no reading at all.
 */
export function daylightFromState(entityId: string, state: string): 0 | 1 | null {
  if (entityId.startsWith('sun.')) {
    return state === 'above_horizon' ? 1 : state === 'below_horizon' ? 0 : null;
  }
  return state === 'on' ? 1 : state === 'off' ? 0 : null;
}

function hhmm(instantMs: number, timezone: string): string {
  // Rounded to the minute, as `localIso` rounds a sunset for the forecast.
  const wc = wallClockInZone(Math.round(instantMs / 60_000) * 60_000, timezone);
  return `${String(wc.hour).padStart(2, '0')}:${String(wc.minute).padStart(2, '0')}`;
}

export function resolveDaylight(input: DaylightInput): ResolvedDaylight | undefined {
  if (input.source === 'entity') {
    if (input.state !== 0 && input.state !== 1) return undefined;
    if (input.readAt === null || input.now - input.readAt > DAYLIGHT_FRESH_MS) return undefined;
    return { now: input.state === 1 };
  }
  if (input.source !== 'sun' || input.latitude === null || input.longitude === null) return undefined;
  let date: string;
  try {
    const wc = wallClockInZone(input.now, input.timezone);
    date = `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')}`;
  } catch {
    return undefined;
  }
  // The events depend on the date and the longitude alone; the zone decides
  // only how each is printed.
  const day = sunDay(date, input.latitude, input.longitude, 0);
  if (day === undefined) return undefined;
  // A polar day is day all day, and a polar night is a window of no length —
  // which `daytimeActive` reads as never, rather than as a fault.
  if (day.kind === 'polar-day') return { startsAt: '00:00', endsAt: '24:00' };
  if (day.kind === 'polar-night') return { startsAt: '00:00', endsAt: '00:00' };
  try {
    return { startsAt: hhmm(day.sunriseAt, input.timezone), endsAt: hhmm(day.sunsetAt, input.timezone) };
  } catch {
    return undefined;
  }
}
