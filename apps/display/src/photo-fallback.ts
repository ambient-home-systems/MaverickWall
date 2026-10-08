/**
 * A slideshow box never goes blank (plan item M3.8).
 *
 * A photo the wall cannot fetch — Immich down before this box had kept a
 * copy, a NAS asleep, a stored file gone — used to leave the box showing the
 * theme's ground, which on a dark theme is a black rectangle where a picture
 * was. Now the box draws a bundled picture instead, chosen by the server for
 * the wall's tone and carried in the album's config as `fallback`, and the
 * Photos screen says why.
 *
 * What failed is remembered here, in this browser, for a few minutes, so the
 * fifteen-second rebuild draws the stand-in straight away rather than an empty
 * box until the image fails again — and then tries the photo again, because
 * a source that was down comes back. Pure, with no DOM, for the reason
 * `widget-options.ts` is.
 */

import { SMALL_WALLPAPER_EDGE, WALLPAPER_FILE, wallpaperPosition } from './wallpaper.js';

/** How long a photo that failed is drawn as the stand-in before it is tried again. */
export const FAILED_PHOTO_MS = 5 * 60_000;
/** The most failures remembered: an album of a hundred photos all failing needs no more than a handful at once. */
export const MAX_FAILED_PHOTOS = 64;

export interface FailedPhotos {
  /** Remember that `url` would not load, at `at` on the wall clock. */
  mark(url: string, at: number): void;
  /** Whether `url` failed within the last `FAILED_PHOTO_MS`. */
  failed(url: string, at: number): boolean;
}

export function createFailedPhotos(): FailedPhotos {
  const failures = new Map<string, number>();
  return {
    mark(url, at) {
      if (!Number.isFinite(at)) return;
      failures.delete(url);
      failures.set(url, at);
      while (failures.size > MAX_FAILED_PHOTOS) {
        const oldest = failures.keys().next().value;
        if (oldest === undefined) break;
        failures.delete(oldest);
      }
    },
    failed(url, at) {
      const when = failures.get(url);
      if (when === undefined) return false;
      if (!(at - when < FAILED_PHOTO_MS) || at < when) {
        failures.delete(url);
        return false;
      }
      return true;
    },
  };
}

export interface StandIn {
  readonly small: string;
  readonly large: string;
  readonly position: string;
}

/** The stand-in the server sent, or nothing when it sent none or either file name is not a wallpaper's. */
export function standIn(value: unknown): StandIn | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { small, large } = value as { small?: unknown; large?: unknown };
  if (typeof small !== 'string' || typeof large !== 'string') return undefined;
  if (!WALLPAPER_FILE.test(small) || !WALLPAPER_FILE.test(large)) return undefined;
  return { small, large, position: wallpaperPosition(value as { focal?: unknown }) };
}

/**
 * The stand-in's file for a box on this screen. A widget box is never larger
 * than the screen, so the screen's longer side decides, by the wallpaper's own
 * rule (`SMALL_WALLPAPER_EDGE`).
 */
export function standInFile(stand: StandIn, screen: { readonly width: number; readonly height: number }, devicePixelRatio: number): string {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const edge = Math.max(screen.width, screen.height) * ratio;
  return Number.isFinite(edge) && edge > SMALL_WALLPAPER_EDGE ? stand.large : stand.small;
}
