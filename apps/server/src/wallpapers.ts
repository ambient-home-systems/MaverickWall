/**
 * The bundled wallpapers (plan item P6.1): the catalogue a canvas background
 * of the kind `{ type: 'wallpaper', id }` is checked against.
 *
 * **One copy, on the server.** A stored background names a wallpaper by id and
 * nothing else; `parseBackground` resolves the id here into the two file names
 * the wall chooses between, and the editor's picker is handed this list in its
 * bootstrap. So the display bundle carries no catalogue of its own — the
 * vocabulary is not transcribed anywhere, and there is no parity test to keep,
 * because there is nothing for a second copy to drift from.
 *
 * The files are `apps/server/assets/wallpapers/`, served at
 * `/assets/wallpapers/<file>` by `http/static.ts` with a year-long immutable
 * cache, which is why every name is content-hashed: an edited picture is a new
 * URL. `wallpapers.test.ts` holds every name below to the bytes on disk, so a
 * picture regenerated without renaming it fails the build rather than a wall
 * serving last year's version for a year.
 *
 * **These three are placeholders** from `scripts/wallpapers/placeholders.mjs`,
 * shipped so the kind and its picker can be driven end to end before the set
 * exists (P6.2, session S23). An id this list stops naming is not an error:
 * `parseBackground` drops it and the canvas falls back to its theme's ground
 * (rules five and nine).
 */

import { isLight } from './api/themes.js';

/**
 * Whether a wallpaper is drawn for a dark theme or a light one.
 *
 * The picker offers the wallpapers whose tone matches the wall's theme (P6.3),
 * because every contrast guarantee on the wall is measured against the theme's
 * flat `--bg`, and a light picture under a dark theme's light ink is exactly
 * the case nothing measures.
 */
export type WallpaperTone = 'light' | 'dark';

export interface Wallpaper {
  /** The catalogue id a stored background names. Never a file name. */
  readonly id: string;
  /** What the picker calls it. */
  readonly name: string;
  readonly tone: WallpaperTone;
  /**
   * The picture's dominant colour, for the picker's tile while its thumbnail
   * loads. Deliberately *not* the canvas's colour while the wallpaper loads:
   * that is the theme's ground, which is also what a missing file falls back
   * to, so there is one fallback rather than two (rule nine).
   */
  readonly color: string;
  /** About 320px square: the picker's thumbnail. */
  readonly thumb: string;
  /** A long edge of about 1600px: tablets, monitors, the editor's preview. */
  readonly small: string;
  /** A long edge of about 2880px: a television, or a tablet at 2x. */
  readonly large: string;
}

export const WALLPAPERS: readonly Wallpaper[] = [
  {
    id: 'dusk',
    name: 'Dusk',
    tone: 'dark',
    color: '#1C2233',
    thumb: 'dusk-320.1409b210fa.jpg',
    small: 'dusk-1600.82505dfb45.jpg',
    large: 'dusk-2880.2be39b376b.jpg',
  },
  {
    id: 'hills',
    name: 'Hills',
    tone: 'dark',
    color: '#1A2A28',
    thumb: 'hills-320.f411ce1b2d.jpg',
    small: 'hills-1600.54b4139725.jpg',
    large: 'hills-2880.e3f590a206.jpg',
  },
  {
    id: 'paper',
    name: 'Paper',
    tone: 'light',
    color: '#EFEAE0',
    thumb: 'paper-320.0629345ec8.jpg',
    small: 'paper-1600.b02d2ac72a.jpg',
    large: 'paper-2880.1db3fcd443.jpg',
  },
];

/**
 * A wallpaper file name: an id, the long edge, a content hash, `.jpg`.
 *
 * Also the only shape `/assets/wallpapers/:name` serves, and — transcribed as
 * one regex — the only shape the display will put inside a `url()`.
 */
export const WALLPAPER_FILE = /^[a-z0-9][a-z0-9-]*-[0-9]{2,4}\.[0-9a-f]{8,64}\.jpe?g$/;

const BY_ID: ReadonlyMap<string, Wallpaper> = new Map(WALLPAPERS.map((w) => [w.id, w]));

/** The wallpaper an id names, or undefined for one the catalogue does not. */
export function wallpaperById(id: string): Wallpaper | undefined {
  return BY_ID.get(id);
}

export function isWallpaperId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * What each widget draws behind itself (plan item P6.3): nothing, the theme's
 * `--panel` at a high opacity, or `--panel` opaque. A wall setting, stored in
 * `screens.widget_ground`, where null is "never chosen" — which the wall reads
 * as Soft over a wallpaper and nothing otherwise (`widgetGroundFor` in the
 * display's `wallpaper.ts`), so every wall that existed before this draws what
 * it drew.
 */
export const WIDGET_GROUNDS = ['none', 'soft', 'solid'] as const;
export type WidgetGround = (typeof WIDGET_GROUNDS)[number];

export function isWidgetGround(value: unknown): value is WidgetGround {
  return typeof value === 'string' && (WIDGET_GROUNDS as readonly string[]).includes(value);
}

/**
 * Whether a theme is dark or light, from its own `--bg` (P6.3) — by
 * `isLight`, the reading `withTints` already takes of a theme's ground to
 * choose its tint strength, so "is this a light theme" has one answer on this
 * server. It puts the five built-ins exactly where the plan names them —
 * Panels and Swiss dark; Household, Almanac and Blueprint light — and answers
 * a custom theme by the same rule rather than by a list.
 */
export function themeTone(bg: string): WallpaperTone {
  return isLight(bg) ? 'light' : 'dark';
}
