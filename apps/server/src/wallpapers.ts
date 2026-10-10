/**
 * The bundled wallpapers (plan items P6.1 and P6.2): the catalogue a canvas
 * background of the kind `{ type: 'wallpaper', id }` is checked against.
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
 * URL. `wallpapers.test.ts` holds every name to the bytes on disk, so a
 * picture regenerated without renaming it fails the build rather than a wall
 * serving last year's version for a year.
 *
 * **The set is generated, and so is this list.** `scripts/wallpapers/generate.mjs`
 * draws twenty-six parametric SVGs from seeds, rasterises them with the
 * bundled Chromium, and writes `wallpaper-catalogue.ts` with each picture's
 * mean colour and luminance measured off the raster. Beside them,
 * `scripts/wallpapers/photos.mjs` fetches sixteen public-domain paintings and
 * photographs from sources on the plan's allowlist (M4.5) and writes
 * `wallpaper-photos.ts`, each with its credit and licence. An id that list stops
 * naming is not an error: `parseBackground` drops it and the canvas falls back
 * to its theme's ground (rules five and nine).
 */

import { isLight } from './api/themes.js';
import { WALLPAPER_CATALOGUE } from './wallpaper-catalogue.js';
import { WALLPAPER_GLASS } from './wallpaper-glass.js';
import { PHOTO_LICENCES, WALLPAPER_PHOTOS } from './wallpaper-photos.js';

/**
 * Whether a wallpaper is drawn for a dark theme or a light one.
 *
 * The picker offers the wallpapers whose tone matches the wall's theme (P6.3),
 * because every contrast guarantee on the wall is measured against the theme's
 * flat `--bg`, and a light picture under a dark theme's light ink is exactly
 * the case nothing measures.
 */
export type WallpaperTone = 'light' | 'dark';

/**
 * The seven categories of Q10, in the order the picker groups them. A
 * category is a fact about the drawing rather than about the wall, so it is
 * not something a household filters by; it is how twenty-six tiles read as a
 * set rather than as a heap.
 */
export const WALLPAPER_CATEGORIES = [
  'gradient',
  'texture',
  'contour',
  'geometric',
  'landscape',
  'seasonal',
  'fun',
  'painting',
  'space',
] as const;
export type WallpaperCategory = (typeof WALLPAPER_CATEGORIES)[number];

export const WALLPAPER_CATEGORY_NAMES: Readonly<Record<WallpaperCategory, string>> = {
  gradient: 'Soft gradients',
  texture: 'Paper and textures',
  contour: 'Contour lines',
  geometric: 'Geometric',
  landscape: 'Landscapes',
  seasonal: 'Seasons',
  fun: 'Fun',
  painting: 'Paintings',
  space: 'From space',
};

/**
 * The categories drawn by `scripts/wallpapers/generate.mjs` (Q10), as against
 * the photographs and paintings fetched by `photos.mjs` (plan item M4.5).
 */
export const DRAWN_CATEGORIES: readonly WallpaperCategory[] = [
  'gradient',
  'texture',
  'contour',
  'geometric',
  'landscape',
  'seasonal',
  'fun',
];

/** A licence a bundled photograph may carry: the MD5 allowlist, one row per source. */
export type PhotoLicence = keyof typeof PHOTO_LICENCES;
export { PHOTO_LICENCES };

/**
 * Where a bundled photograph came from (plan item M4.5): the work, its author
 * and date, the page it was found on, the address its bytes were fetched from,
 * the licence, the day it was fetched and the sha256 of what was fetched.
 */
export interface PhotoCredit {
  readonly title: string;
  readonly author: string;
  readonly date: string;
  readonly source: string;
  readonly image: string;
  readonly licence: PhotoLicence;
  readonly retrieved: string;
  readonly sha256: string;
}

export interface Wallpaper {
  /** The catalogue id a stored background names. Never a file name. */
  readonly id: string;
  /** What the picker calls it. */
  readonly name: string;
  readonly category: WallpaperCategory;
  readonly tone: WallpaperTone;
  /**
   * The built-in themes this picture is drawn to sit under, as a suggestion
   * the picker names. Always of the wallpaper's own tone, and never the
   * contrast promise: that is held against *every* theme of the tone by
   * `browser-wallpaper-contrast.test.ts`, whatever this list says.
   */
  readonly themes: readonly string[];
  /**
   * Where the picture's interest is, as a percentage of the master, for the
   * canvas's `background-position`. Absent is the centre. Every drawn master
   * is composed with nothing near its edges, so `cover` crops one square to
   * portrait and to landscape; a focal point only nudges which band of it a
   * wall looks at. A photograph is not square, so this is its point on a
   * landscape wall, and `portraitFocal` its point on a portrait one.
   */
  readonly focal?: { readonly x: number; readonly y: number };
  /**
   * Where the picture's interest is on a portrait wall (plan item M4.5). A
   * photograph is not square, so `cover` crops a landscape picture to a narrow
   * vertical slice on a portrait wall, and which slice is a separate choice
   * from where a landscape wall's band sits. Absent is `focal`.
   */
  readonly portraitFocal?: { readonly x: number; readonly y: number };
  /**
   * The picture's mean colour, measured, for the picker's tile while its
   * thumbnail loads. Deliberately *not* the canvas's colour while the
   * wallpaper loads: that is the theme's ground, which is also what a missing
   * file falls back to, so there is one fallback rather than two (rule nine).
   */
  readonly color: string;
  /**
   * The picture's mean relative luminance (0 black, 1 white), measured off the
   * raster. Above `OLED_LUMINANCE` it is bright enough to burn into an OLED
   * screen.
   */
  readonly luminance: number;
  /** About 320px on the long edge: the picker's thumbnail. */
  readonly thumb: string;
  /** A long edge of about 1600px: tablets, monitors, the editor's preview. */
  readonly small: string;
  /** A long edge of about 2880px: a television, or a tablet at 2x. */
  readonly large: string;
  /**
   * The lightest and darkest patch the picture shows through Glass, blurred
   * and saturated as Glass draws it (plan item M4.2), from `wallpaper-glass.ts`.
   * A wall solves its Glass opacity from these for the theme it is wearing.
   */
  readonly glass?: { readonly light: string; readonly dark: string };
  /**
   * The lightest and darkest of the shipped 1600px file's 40x40 blocks,
   * unblurred (plan item M4.5): what a widget's Soft ground sits over. Only a
   * photograph carries it. A drawn wallpaper is drawn to keep 4.5:1 at Soft's
   * fixed 0.86; a painting has a bright sky and a dark wood at once and keeps
   * it at almost no single opacity, so the wall solves Soft's from these for
   * its own inks, never below 0.86.
   */
  readonly soft?: { readonly light: string; readonly dark: string };
  /** Where a photograph came from, and under which licence (plan item M4.5). Absent for a drawn wallpaper. */
  readonly credit?: PhotoCredit;
}

export const WALLPAPERS: readonly Wallpaper[] = [...WALLPAPER_CATALOGUE, ...WALLPAPER_PHOTOS].map((one) => {
  const glass = WALLPAPER_GLASS[one.id];
  return glass === undefined ? one : { ...one, glass: { light: glass.light, dark: glass.dark } };
});

/**
 * The mean luminance above which a wallpaper is bright enough to burn into an
 * OLED screen (P6.3). A bright static picture is the burn-in the shadow rule
 * was written about; every light wallpaper in the set sits far above this and
 * every dark one far below, so the line is a statement of which half is which
 * rather than a threshold anything lands near.
 *
 * The wallpaper picker no longer says so. It marked every light picture "not
 * for OLED screens", which was true of all twelve and so told none of them
 * apart, and a static calendar does not belong on an OLED panel whatever is
 * behind it. The owner is moving that notice to where a household chooses a
 * screen; this is kept as the one statement of which pictures it concerns,
 * and `wallpapers.test.ts` holds it to the set.
 */
export const OLED_LUMINANCE = 0.4;

export function notForOled(wallpaper: Pick<Wallpaper, 'luminance'>): boolean {
  return wallpaper.luminance > OLED_LUMINANCE;
}

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

/** What a rotating background rotates through (plan item M4.10): a category, or every picture of a tone. */
export type RotationCollection = WallpaperCategory | 'all';
export const ROTATION_COLLECTIONS: readonly RotationCollection[] = [...WALLPAPER_CATEGORIES, 'all'];

/**
 * The pictures a rotation shows, in the catalogue's own order: one category
 * of one tone, or every picture of that tone. The tone is part of the choice
 * because a wallpaper is drawn for its theme's ink (P6.3) — a rotation must
 * not wander onto a picture the wall's text was never measured against.
 */
export function rotationPictures(collection: RotationCollection, tone: WallpaperTone): Wallpaper[] {
  return WALLPAPERS.filter((one) => one.tone === tone && (collection === 'all' || one.category === collection));
}

/**
 * What each widget draws behind itself (plan item P6.3): nothing, the theme's
 * `--panel` at a high opacity, or `--panel` opaque. A wall setting, stored in
 * `screens.widget_ground`, where null is "never chosen" — which the wall reads
 * as Soft over a wallpaper and nothing otherwise (`widgetGroundFor` in the
 * display's `wallpaper.ts`), so every wall that existed before this draws what
 * it drew.
 *
 * **Glass** is the fourth (plan items M4.1–M4.3): the picture behind each widget
 * blurred and saturated under the card colour at the opacity the wall solves
 * for the picture and its theme. It shipped once it passed MQ1, and only as a
 * choice: never chosen is still Soft over a wallpaper.
 */
export const WIDGET_GROUNDS = ['none', 'soft', 'solid', 'glass'] as const;
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

/**
 * The bundled picture a slideshow box draws when it has no photo to show
 * (plan item M3.8): a photo the wall could not fetch, or an Immich or folder
 * source with nothing in it. A quiet gradient of the wall's own tone — Dusk on
 * a dark theme, Mist on a light one — so a box that has lost its photos reads
 * as a picture frame resting rather than as a hole, and its contrast promise
 * is the one every wallpaper of the tone already keeps.
 */
export const PHOTO_FALLBACK: Readonly<Record<WallpaperTone, string>> = { dark: 'dusk', light: 'mist' };

/** What follows the reason a photo could not be fetched, on the Photos screen (plan item M3.8). */
export const PHOTO_UNFETCHED = 'Until it can be fetched, a wall shows a bundled picture in its place.';

export interface PhotoFallback {
  readonly small: string;
  readonly large: string;
  readonly focal?: { readonly x: number; readonly y: number };
}

export function photoFallback(tone: WallpaperTone): PhotoFallback | undefined {
  const picture = wallpaperById(PHOTO_FALLBACK[tone]);
  if (picture === undefined) return undefined;
  return { small: picture.small, large: picture.large, ...(picture.focal === undefined ? {} : { focal: picture.focal }) };
}
