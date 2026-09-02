/**
 * The glyph vocabulary and the drawings, server-side.
 *
 * The modules choose a glyph — `nws.ts` from the provider's own wording,
 * `open-meteo.ts` from a WMO code, `homeassistant/entities.ts` from a device
 * class — and what travels in the manifest is that **key**, never a picture and
 * never a character. What used to travel was an emoji, which is a third-party
 * asset resolved on the device: rule three broken in the one way this
 * repository could not see, since nothing here fetches anything.
 *
 * Both renderers hold a drawing. `apps/display/src/glyphs.ts` has these paths
 * for the glass; `epaper/glyphs.ts` has a 1-bit cell per key, redrawn rather
 * than rasterised, for a panel. The admin's store cards draw the paths below,
 * which is why they are here as well as there.
 *
 * **The two blocks below are transcribed from `apps/display/src/glyphs.ts`
 * character for character** and `glyph-parity.test.ts` compares them as text.
 * The display bundle has no bundler and cannot import this file, and a server
 * test cannot import *from* it — the seam `epaper-ladder-parity`,
 * `month-spans-parity`, `tier-parity` and `calendar-view-parity` already sit at.
 * Read the drawing conventions — the 24 grid, and why every subpath is
 * clockwise but a counter — out of that file's own docstring.
 */

export const GLYPH_KEYS = [
  // Sky, from the clearest to the loudest, then wind.
  'clear',
  'mostly-clear',
  'partly-cloudy',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'showers',
  'snow',
  'sleet',
  'thunderstorm',
  'wind',
  // Device classes, in Home Assistant's own words.
  'temperature',
  'humidity',
  'pressure',
  'battery',
  'power',
  'illuminance',
  'door',
  'garage',
  'window',
  'motion',
  'occupancy',
  'moisture',
  'smoke',
  'gas',
  'problem',
  'lock',
  'person',
] as const;

/** The cloud every overcast sky is built on, so all six read as one family. */
const CLOUD =
  'M5 11.5a4.5 4.5 0 1 1 9 0a4.5 4.5 0 1 1-9 0Z' +
  'M11.9 13.4a3.6 3.6 0 1 1 7.2 0a3.6 3.6 0 1 1-7.2 0Z' +
  'M2.8 13.8a3.2 3.2 0 1 1 6.4 0a3.2 3.2 0 1 1-6.4 0Z' +
  'M2.8 13.5h16.3v3.5h-16.3Z';

/** One drawing per key, on the 24 grid, every subpath clockwise but a counter. */
export const GLYPH_PATHS: Readonly<Record<GlyphKey, string>> = {
  /* A disc and eight rays. The rays are separated from the disc by a whole
     grid unit, because at 8 pixels a ray touching the disc is a lumpy disc. */
  clear:
    'M6.8 12a5.2 5.2 0 1 1 10.4 0a5.2 5.2 0 1 1-10.4 0Z' +
    'M11 2.5h2v3h-2ZM11 18.5h2v3h-2ZM2.5 11h3v2h-3ZM18.5 11h3v2h-3Z' +
    'M17.31 15.89L19.43 18.01L18.01 19.43L15.89 17.31Z' +
    'M15.89 6.69L18.01 4.57L19.43 5.99L17.31 8.11Z' +
    'M8.11 17.31L5.99 19.43L4.57 18.01L6.69 15.89Z' +
    'M6.69 8.11L4.57 5.99L5.99 4.57L8.11 6.69Z',
  /* Sun with a small cloud under it: mostly sun, and the cloud is the minority
     of the ink, which is the whole difference from `partly-cloudy`. */
  'mostly-clear':
    'M5.3 9a4.2 4.2 0 1 1 8.4 0a4.2 4.2 0 1 1-8.4 0Z' +
    'M8.5 1.2h2v2.6h-2ZM1.2 8h2.6v2h-2.6Z' +
    'M5.04 5.82L3.2 3.98L4.48 2.7L6.32 4.54Z' +
    'M12.68 4.54L14.52 2.7L15.8 3.98L13.96 5.82Z' +
    'M10.1 16.2a3.4 3.4 0 1 1 6.8 0a3.4 3.4 0 1 1-6.8 0Z' +
    'M14.6 16.8a2.8 2.8 0 1 1 5.6 0a2.8 2.8 0 1 1-5.6 0Z' +
    'M10.1 16.6h10.1v3h-10.1Z',
  /* The same two objects with the weights swapped: a small sun behind the full
     cloud, so the pair reads as a scale rather than as two unrelated pictures. */
  'partly-cloudy':
    'M4.6 6.6a3.4 3.4 0 1 1 6.8 0a3.4 3.4 0 1 1-6.8 0Z' +
    'M7.2 0.8h1.6v2.2h-1.6ZM0.8 5.8h2.2v1.6h-2.2Z' +
    'M4.25 3.99L2.76 2.5L3.9 1.36L5.39 2.85Z' +
    'M10.61 2.85L12.1 1.36L13.24 2.5L11.75 3.99Z' +
    'M6.5 13.1a4.5 4.5 0 1 1 9 0a4.5 4.5 0 1 1-9 0Z' +
    'M13.4 15a3.6 3.6 0 1 1 7.2 0a3.6 3.6 0 1 1-7.2 0Z' +
    'M4.3 15.4a3.2 3.2 0 1 1 6.4 0a3.2 3.2 0 1 1-6.4 0Z' +
    'M4.3 15.1h16.3v3.5h-16.3Z',
  cloudy: CLOUD,
  /* The cloud, with two bands of mist lying under it rather than falling out of
     it. Drawn first as four staggered bars with no cloud at all, which rendered
     as an unmistakable hamburger menu — the horizontal-bars idiom belongs to
     `wind` on this sheet, and fog has to be a *sky*. */
  fog: `${CLOUD}M4.4 18.6h15.2v2h-15.2ZM2.6 21.4h14v2h-14Z`,
  drizzle: `${CLOUD}M8.2 18.6h1.8v2.6h-1.8ZM12.2 18.6h1.8v2.6h-1.8ZM16.2 18.6h1.8v2.6h-1.8Z`,
  rain: `${CLOUD}M7.6 18.2h1.8v5h-1.8ZM11.6 18.2h1.8v5h-1.8ZM15.6 18.2h1.8v5h-1.8Z`,
  /* Rain's bars, slanted. The slant is the only difference and it is enough:
     three verticals and three diagonals are two silhouettes at 8 pixels. */
  showers: `${CLOUD}M10 18.2h1.8l-2.2 5h-1.8ZM14 18.2h1.8l-2.2 5h-1.8ZM18 18.2h1.8l-2.2 5h-1.8Z`,
  snow:
    `${CLOUD}M8.5 18.6L10.3 20.4L8.5 22.2L6.7 20.4Z` +
    'M12 18.6L13.8 20.4L12 22.2L10.2 20.4ZM15.5 18.6L17.3 20.4L15.5 22.2L13.7 20.4Z',
  /* A drop, a flake, a drop — sleet is the mixture, so the glyph is too. */
  sleet:
    `${CLOUD}M7.7 18.4h1.8v4.4h-1.8Z` +
    'M12 18.8L13.8 20.6L12 22.4L10.2 20.6ZM14.5 18.4h1.8v4.4h-1.8Z',
  thunderstorm: `${CLOUD}M14 17.4L12.5 19.6L15.2 19.6L10.4 23.6L11.9 21.4L9.2 21.4Z`,
  /* Three gusts with round terminals. The terminals are what separate this from
     `fog` at small sizes, where both are otherwise a stack of bars. */
  wind:
    'M2.5 5.8h13v2.4h-13ZM13.8 7a2.6 2.6 0 1 1 5.2 0a2.6 2.6 0 1 1-5.2 0Z' +
    'M2.5 10.8h17.5v2.4h-17.5Z' +
    'M2.5 15.8h10v2.4h-10ZM10.8 17a2.6 2.6 0 1 1 5.2 0a2.6 2.6 0 1 1-5.2 0Z',
  temperature:
    'M10.2 3.6h3.6v12.4h-3.6ZM10.2 3.6a1.8 1.8 0 1 1 3.6 0a1.8 1.8 0 1 1-3.6 0Z' +
    'M7.6 18a4.4 4.4 0 1 1 8.8 0a4.4 4.4 0 1 1-8.8 0Z',
  humidity: 'M12 2.4C16.4 7.6 19 11.1 19 14.1A7 7 0 0 1 5 14.1C5 11.1 7.6 7.6 12 2.4Z',
  /* A ring, a needle and a hub. The needle and the hub sit *inside* the ring's
     anticlockwise counter and are wound clockwise, so they fill: +1 -1 +1. */
  pressure:
    'M2.8 12a9.2 9.2 0 1 1 18.4 0a9.2 9.2 0 1 1-18.4 0Z' +
    'M5.6 12a6.4 6.4 0 1 0 12.8 0a6.4 6.4 0 1 0-12.8 0Z' +
    'M11.43 11.43L16.03 6.83L17.17 7.97L12.57 12.57Z' +
    'M10.1 12a1.9 1.9 0 1 1 3.8 0a1.9 1.9 0 1 1-3.8 0Z',
  battery:
    'M4 6.8h13.6a2 2 0 0 1 2 2v6.4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.8a2 2 0 0 1 2-2Z' +
    'M4.4 9.2v5.6h12.8v-5.6ZM5.6 10.4h6.4v3.2h-6.4Z' +
    'M20.4 9.6h1.2a1 1 0 0 1 1 1v2.8a1 1 0 0 1-1 1h-1.2Z',
  power: 'M14.6 1.8L12.8 10.2L19 10.2L9.4 22.2L11.2 13.8L5 13.8Z',
  /* A bulb rather than a second sun: `clear` is already a disc with rays, and
     two glyphs that differ only in ray count is two glyphs nobody can tell
     apart on a panel. */
  illuminance:
    'M6 9.4a6 6 0 1 1 12 0a6 6 0 1 1-12 0Z' +
    'M9.4 13h5.2v3.4h-5.2ZM9 17h6v2.2h-6ZM9.8 19.8h4.4v2h-4.4Z',
  door:
    'M4.6 2h14.8v20h-14.8ZM7 4.4v15.6h10v-15.6Z' +
    'M13.7 12.4a1.3 1.3 0 1 1 2.6 0a1.3 1.3 0 1 1-2.6 0Z',
  garage:
    'M12 1.6L23 8.4L1 8.4ZM2.4 8.4h19.2v13.6h-19.2ZM5.4 11v11h13.2v-11Z' +
    'M6.8 12.4h10.4v1.6h-10.4ZM6.8 15.6h10.4v1.6h-10.4ZM6.8 18.8h10.4v1.6h-10.4Z',
  window:
    'M3.4 3.4h17.2v17.2h-17.2ZM6 6v12h12v-12Z' +
    'M11.2 6h1.6v12h-1.6ZM6 11.2h12v1.6h-12Z',
  /* A person with movement behind them. `occupancy` is the same person inside a
     room: the two device classes answer different questions about one body, and
     drawing them as one glyph is what the emoji did. */
  motion:
    'M11.8 6.2a3.2 3.2 0 1 1 6.4 0a3.2 3.2 0 1 1-6.4 0Z' +
    'M9 21.8c0-3.6 2.7-6 6-6s6 2.4 6 6Z' +
    'M1.4 8h5.2v2h-5.2ZM1.4 12h5.2v2h-5.2ZM1.4 16h5.2v2h-5.2Z',
  occupancy:
    'M2.2 3.6h19.6v16.8h-19.6ZM4.8 6.2v11.6h14.4v-11.6Z' +
    'M9.7 10a2.3 2.3 0 1 1 4.6 0a2.3 2.3 0 1 1-4.6 0Z' +
    'M7.6 17.8c0-2.4 2-4 4.4-4s4.4 1.6 4.4 4Z',
  /* A drop *and* the puddle it landed in. `humidity` is the drop alone: one is
     how wet the air is and the other is water where it should not be. */
  moisture:
    'M12 2.2C15.6 6.4 17.8 9.4 17.8 11.8A5.8 5.8 0 0 1 6.2 11.8C6.2 9.4 8.4 6.4 12 2.2Z' +
    'M4.3 19h15.4a1.3 1.3 0 0 1 0 2.6H4.3a1.3 1.3 0 0 1 0-2.6Z',
  /* Two curls rising. Vertical, because `fog` is horizontal bands and the two
     are the same idea in different media — a smoke alarm and a foggy morning
     must not resolve to one silhouette. Drawn first as a diagonal string of
     discs, which read as a caterpillar. */
  smoke:
    'M6 21.5C3.6 18.5 8.4 15.5 6 12.5C3.6 9.5 8.4 6.5 6 3.5H9.2C11.6 6.5 6.8 9.5 9.2 12.5C11.6 15.5 6.8 18.5 9.2 21.5Z' +
    'M14.8 21.5C12.4 18.5 17.2 15.5 14.8 12.5C12.4 9.5 17.2 6.5 14.8 3.5H18C20.4 6.5 15.6 9.5 18 12.5C20.4 15.5 15.6 18.5 18 21.5Z',
  gas: 'M12 21.8A6.4 6.4 0 0 1 5.6 15.4C5.6 11 12 7 12 2.2C12 7 18.4 11 18.4 15.4A6.4 6.4 0 0 1 12 21.8Z',
  problem:
    'M12 2.2L23 21.4H1Z' +
    'M10.7 9.2v7h2.6v-7ZM10.5 18.6a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z',
  lock:
    'M7 11.4V8.6a5 5 0 0 1 10 0v2.8h-2.7V8.6a2.3 2.3 0 0 0-4.6 0v2.8Z' +
    'M6 10.8h12a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6.8a2 2 0 0 1 2-2Z' +
    'M10 16.2a2 2 0 1 0 4 0a2 2 0 1 0-4 0Z',
  person:
    'M8 6.4a4 4 0 1 1 8 0a4 4 0 1 1-8 0Z' +
    'M4.5 21.6c0-4.2 3.3-7 7.5-7s7.5 2.8 7.5 7Z',
};

export type GlyphKey = (typeof GLYPH_KEYS)[number];

/**
 * Whether a string names a glyph. Used at every boundary a key crosses: the
 * store catalogue at build time, a module's panel body, and the renderers.
 */
export function isGlyphKey(value: unknown): value is GlyphKey {
  return typeof value === 'string' && (GLYPH_KEYS as readonly string[]).includes(value);
}

/**
 * One glyph as inline SVG markup, or `''` for a key with no drawing.
 *
 * For the server-rendered admin only — the wall builds a node instead, because
 * the display bundle has no `innerHTML` anywhere. The path data is ours and the
 * key is checked against the vocabulary before it is used, so nothing a
 * household or a module typed reaches this string.
 */
export function glyphSvg(key: unknown, className: string): string {
  if (!isGlyphKey(key)) return '';
  return (
    `<svg class="${className}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" ` +
    `focusable="false"><path d="${GLYPH_PATHS[key]}"/></svg>`
  );
}
