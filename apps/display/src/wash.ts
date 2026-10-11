/**
 * Toning a picture down towards the canvas's own ground (plan item M4.7).
 *
 * Pure, and a module of its own, for the reason `wallpaper.ts` is: this
 * package's tests have no DOM, so a rule decided inside `renderFreeform` is a
 * rule nothing can check.
 *
 * A wash is the theme's `--panel` — the colour the canvas is without a picture,
 * and the one its inks were measured against — laid over the picture as a
 * vignette: thinnest in the middle and thickest at the edges, where a clock or
 * a heading usually sits. Two numbers say how much, the opacity at the centre
 * and at the edge; the stylesheet draws the layer at the edge's opacity and
 * masks it down to the centre's.
 *
 * **Light is a look; Strong is a promise when nothing else is.** Over a widget
 * ground (Soft, Solid, Glass) the words sit on the ground and the wash only
 * changes how the picture between them looks, so both are fixed. With no
 * ground the words sit on the wash itself, and Strong's centre — its thinnest
 * point — is then solved for the picture and the theme the way Soft's opacity
 * is (`glass-alpha.ts`): the lowest that keeps `--ink` and `--ink-scaffold` at
 * 4.5:1 over the picture's own lightest and darkest patch, never below the
 * preset. Light makes no such promise, and the editor says so beside it.
 */
import type { CanvasBackground, PictureWash } from './manifest.js';

/** The opacity at the centre and at the edge of each wash. */
export const WASH_PRESETS: Readonly<Record<PictureWash, { readonly centre: number; readonly edge: number }>> = {
  light: { centre: 0.25, edge: 0.55 },
  strong: { centre: 0.5, edge: 0.8 },
};

/**
 * The wash a canvas draws, or undefined for none: a picture's own (an uploaded
 * image or a wallpaper — a rotation arrives here already turned into the
 * wallpaper due now), read defensively because a stored copy of the manifest
 * may carry any shape. A colour or a gradient takes none.
 */
export function washOf(background: CanvasBackground | undefined): PictureWash | undefined {
  if (background?.type !== 'wallpaper' && background?.type !== 'image') return undefined;
  const wash = (background as { readonly wash?: unknown }).wash;
  return wash === 'light' || wash === 'strong' ? wash : undefined;
}

/**
 * The two opacities to draw: the preset, or — for a Strong wash solved for
 * text with no ground — the solved centre where it is higher, with the edge
 * never thinner than the centre. Rounded to hundredths, the solver's own unit.
 */
export function washOpacities(
  wash: PictureWash,
  solved?: number,
): { readonly centre: number; readonly edge: number } {
  const preset = WASH_PRESETS[wash];
  if (solved === undefined || !Number.isFinite(solved)) return preset;
  const centre = Math.min(1, Math.max(preset.centre, solved));
  return { centre, edge: Math.max(preset.edge, centre) };
}

/** The mask's ratio at the centre: the centre's opacity over the edge's, which the layer is drawn at. */
export function washRatio(opacities: { readonly centre: number; readonly edge: number }): number {
  if (opacities.edge <= 0) return 0;
  return Math.round((opacities.centre / opacities.edge) * 1000) / 1000;
}
