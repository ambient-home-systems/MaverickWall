import type { GlyphKey } from './glyphs.js';
import { isGlyphKey } from './glyphs.js';

/**
 * The forecast's second picture set (plan item M5.9): Meteocons, by Bas
 * Milius, MIT, bundled under `apps/server/assets/meteocons/` and served
 * same-origin from `/assets/meteocons/<set>/<name>.svg` (rule three).
 *
 * **The static files, never the animated ones.** Meteocons ships each picture
 * twice, and the moving set moves by SVG's own `<animate>` — which nothing in
 * this repository could scope to reduced motion or to a wall's Motion switch,
 * and which would restart on every fifteen-second rebuild (MQ7, decided:
 * ship them still, or move them through `motion.ts`, never SVG's own). So the
 * bundled files are `@meteocons/svg-static`, and the server's test holds every
 * one of them to carrying no `<animate>`, `<set>`, `<style>` or script. What
 * moves a picture here is what moves everything else on a wall: a class this
 * module names, keyframes in `display.css`'s scoped block, and a phase
 * `render.ts` locks to the wall clock.
 *
 * Pure apart from `meteoconNode`, which builds one `<img>`: which file a sky
 * wears, what the moon is doing tonight, and how each picture moves are all
 * answered here without a DOM, so `weather-icons.test.ts` reads them.
 */

/** The picture sets a forecast can wear: the drawn glyphs, and Meteocons' two. */
export const WEATHER_ICON_SETS = ['drawn', 'fill', 'line'] as const;
export type WeatherIconSet = (typeof WEATHER_ICON_SETS)[number];

/** The set a widget asked for; absent, or anything this bundle does not know, is the drawn one. */
export function iconSetOf(config: unknown): WeatherIconSet {
  const value =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['icons'] : undefined;
  return value === 'fill' || value === 'line' ? value : 'drawn';
}

/** The eight names Meteocons draws the moon by, from new round to new. */
export const MOON_PHASES = [
  'moon-new',
  'moon-waxing-crescent',
  'moon-first-quarter',
  'moon-waxing-gibbous',
  'moon-full',
  'moon-waning-gibbous',
  'moon-last-quarter',
  'moon-waning-crescent',
] as const;
export type MoonPhase = (typeof MOON_PHASES)[number];

/** A new moon to count from (6 January 2000, 18:14 UTC) and the mean length of a lunation. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MS = 29.530588853 * 86_400_000;

/**
 * The moon's phase at an instant, as the nearest of the eight.
 *
 * The mean lunation, counted from a known new moon. The real moon runs up to
 * about fourteen hours either side of the mean, which on an eighth-of-a-month
 * picture is never more than one day's step; a wall drawing tonight's moon
 * needs nothing finer, and the test holds it to real phases within that.
 */
export function moonPhase(instantMs: number): MoonPhase {
  const age = (((instantMs - NEW_MOON_MS) % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS;
  return MOON_PHASES[Math.round((age / SYNODIC_MS) * 8) % 8]!;
}

/**
 * The file a sky wears, day or night — and on a clear night, tonight's moon.
 *
 * Meteocons has a picture for nearly every pairing of sky and hour, so only
 * the skies with a sun in them follow the clock (the `skyFor` rule in
 * `weather-looks.ts`): a clear, mostly clear or partly cloudy sky, fog over a
 * sun, and showers, which are sun and rain. Overcast, rain, snow, sleet, storm
 * and wind are their weather's picture at any hour. A key this bundle does not
 * know has no picture, and draws none.
 */
export function meteoconFor(glyph: GlyphKey | undefined, isDay: boolean, instantMs: number): string | undefined {
  const half = isDay ? 'day' : 'night';
  switch (glyph) {
    case 'clear':
      return isDay ? 'clear-day' : moonPhase(instantMs);
    case 'mostly-clear':
      return `mostly-clear-${half}`;
    case 'partly-cloudy':
      return `partly-cloudy-${half}`;
    case 'cloudy':
      return 'cloudy';
    case 'fog':
      return `fog-${half}`;
    case 'drizzle':
      return 'drizzle';
    case 'rain':
      return 'rain';
    case 'showers':
      return `partly-cloudy-${half}-rain`;
    case 'snow':
      return 'snow';
    case 'sleet':
      return 'sleet';
    case 'thunderstorm':
      return 'thunderstorms-rain';
    case 'wind':
      return 'wind';
    default:
      return undefined;
  }
}

/** Every file `meteoconFor` can name, so the server's test can hold the bundle to it. */
export const METEOCON_FILES: readonly string[] = [
  'clear-day',
  'mostly-clear-day',
  'mostly-clear-night',
  'partly-cloudy-day',
  'partly-cloudy-night',
  'cloudy',
  'fog-day',
  'fog-night',
  'drizzle',
  'rain',
  'partly-cloudy-day-rain',
  'partly-cloudy-night-rain',
  'snow',
  'sleet',
  'thunderstorms-rain',
  'wind',
  ...MOON_PHASES,
];

/**
 * How a picture moves, which is whole: a sun turns, anything with cloud in it
 * sways, and the night sky is still — `skyMotion`'s rule that a still dark sky
 * is doing nothing, and a screen somebody may be sleeping beside is not the
 * place to invent something for it to do.
 */
export type IconMotion = 'spin' | 'sway' | 'none';

export function iconMotion(glyph: GlyphKey | undefined, isDay: boolean): IconMotion {
  if (glyph === undefined) return 'none';
  if (glyph === 'clear') return isDay ? 'spin' : 'none';
  if (!isDay && (glyph === 'mostly-clear' || glyph === 'partly-cloudy')) return 'none';
  return 'sway';
}

/**
 * One cycle of each, in milliseconds, stated here and nowhere else (`motion.ts`
 * computes the phase from it), and each held to the sky cycles' rule about the
 * fifteen-second rebuild: a restart must land at least a quarter of a cycle
 * from where a continuous loop is, or the fault would be invisible. 15 s is
 * 0.56 of a 27 s turn and 0.42 of a 6.2 s sway.
 */
export const ICON_MOTION_MS: Readonly<Record<Exclude<IconMotion, 'none'>, number>> = {
  spin: 27_000,
  sway: 6_200,
};

/** Where the pictures are served: absolute on a wall, relative under the admin's `<base>`. */
const WALL_ICON_BASE = '/assets/meteocons/';
export const ADMIN_ICON_BASE = 'assets/meteocons/';
let base = WALL_ICON_BASE;

/**
 * Point the pictures at the admin's relative base, for a page that draws a
 * wall inside the admin — the editor, the CSS editor and the gallery. The
 * wallpapers' split (`ADMIN_WALLPAPER_BASE`), set once by the page rather than
 * threaded through every renderer, because a page is one or the other for its
 * whole life.
 */
export function useAdminIconBase(): void {
  base = ADMIN_ICON_BASE;
}

/**
 * The picture for a sky in a set, as an `<img>`, or `null` for the drawn set
 * and for a sky with no picture — `glyphNode`'s rule, so every caller draws
 * nothing rather than a broken image.
 *
 * Decorative, as the drawn glyph is (`aria-hidden`): the words beside it say
 * the weather, and a screen reader saying it twice is noise.
 */
export function meteoconNode(
  set: WeatherIconSet,
  glyph: unknown,
  isDay: boolean,
  instantMs: number,
  className: string,
): HTMLImageElement | null {
  if (set === 'drawn' || !isGlyphKey(glyph)) return null;
  const file = meteoconFor(glyph, isDay, instantMs);
  if (file === undefined) return null;
  const img = document.createElement('img');
  img.src = `${base}${set}/${file}.svg`;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.className = className;
  img.setAttribute('data-icon', `${set}/${file}`);
  return img;
}
