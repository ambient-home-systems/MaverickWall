/**
 * Wallpapers on the wall (plan items P6.1 and P6.3): which of a wallpaper's
 * two files to draw, and what each widget draws behind itself over one.
 *
 * Pure, and a module of its own, for the reason `widget-options.ts`, `ink.ts`
 * and `placement.ts` are: this package's tests have no DOM, so a rule decided
 * inside `renderFreeform` is a rule nothing can check.
 *
 * The catalogue is not here. A stored background names a wallpaper by id; the
 * server resolves that id against `apps/server/src/wallpapers.ts` and hands
 * the wall the two file names, so the only thing this bundle has to know about
 * a file is that its name is safe to put inside a `url()`.
 */
import type { CanvasBackground } from './manifest.js';

/**
 * Where the wallpapers are served: absolute on the wall, which is always at
 * the root of its own origin, and relative in every admin preview, which sits
 * under the admin's `<base>` — under Home Assistant ingress that base carries
 * the add-on's prefix, and an absolute `/assets/…` would ask Home Assistant
 * for the file. The media store's `/d/media/` and `admin/media/` split, one
 * asset along; `admin-asset-urls.test.ts` is where that class of 404 is held.
 */
export const WALLPAPER_BASE = '/assets/wallpapers/';
export const ADMIN_WALLPAPER_BASE = 'assets/wallpapers/';

/**
 * A wallpaper file name: an id, the long edge, a content hash, `.jpg`.
 *
 * Transcribed from `apps/server/src/wallpapers.ts` and held to it as text by
 * `wallpaper-parity.test.ts`. The manifest is the server's, but this is the
 * last check before a string goes inside a `url()`, and a name that fails it is
 * no wallpaper at all rather than a request for something else.
 */
export const WALLPAPER_FILE = /^[a-z0-9][a-z0-9-]*-[0-9]{2,4}\.[0-9a-f]{8,64}\.jpe?g$/;

/**
 * The smaller file's long edge, in device pixels. A canvas whose longer side is
 * no more than this draws the small file; anything larger draws the large one.
 *
 * `cover` scales a square picture to the canvas's *longer* side, so that side
 * is the one the file has to reach without upscaling. The admin's previews are
 * a few hundred pixels across and always take the small file — the editor
 * redraws on every drag, and decoding eight megapixels for a thumbnail is
 * decode spent on nothing.
 */
export const SMALL_WALLPAPER_EDGE = 1600;

type WallpaperBackground = Extract<CanvasBackground, { type: 'wallpaper' }>;

/**
 * The file this canvas should draw, or undefined for none.
 *
 * Undefined when either name is not a wallpaper file — both are checked, not
 * only the one chosen, because a document with one bad name in it is not a
 * document to half-trust. The canvas then draws its theme's ground, which is
 * also what a file that fails to load leaves showing (rule nine).
 *
 * A size of zero — a canvas not yet in a document — takes the small file.
 */
export function wallpaperFile(
  background: WallpaperBackground,
  canvas: { readonly width: number; readonly height: number },
  devicePixelRatio: number,
): string | undefined {
  if (!WALLPAPER_FILE.test(background.small) || !WALLPAPER_FILE.test(background.large)) return undefined;
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const edge = Math.max(canvas.width, canvas.height) * ratio;
  return Number.isFinite(edge) && edge > SMALL_WALLPAPER_EDGE ? background.large : background.small;
}

/**
 * What each widget draws behind itself (P6.3): nothing, the theme's `--panel`
 * at a high opacity, or `--panel` opaque.
 */
export type WidgetGround = 'none' | 'soft' | 'solid';

export const WIDGET_GROUNDS: readonly WidgetGround[] = ['none', 'soft', 'solid'];

/**
 * The ground a canvas's widgets draw, from what the household chose and what
 * the canvas is drawn on.
 *
 * **Never chosen is Soft over a wallpaper and nothing otherwise.** Every
 * contrast guarantee on this wall — `--ink-scaffold`'s 4.5:1, the tints, the
 * editor's guidance — is measured against a flat ground, and a widget is
 * transparent, so without a ground its text sits straight on the picture. The
 * default is per canvas because the background is: a wall with a wallpaper in
 * portrait and a solid colour in landscape draws each as its own. Nothing
 * other than a wallpaper changes, so a wall with an uploaded image or no
 * background at all draws exactly what it drew before this existed.
 *
 * An answer this bundle does not know is "never chosen" rather than a guess.
 */
export function widgetGroundFor(stored: unknown, background: CanvasBackground | undefined): WidgetGround {
  if (stored === 'none' || stored === 'soft' || stored === 'solid') return stored;
  return background?.type === 'wallpaper' ? 'soft' : 'none';
}
