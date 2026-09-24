import { matchWallSize } from './wall-sizes.js';

/**
 * Whether a browser wall may move (plan P4.3, decision D7), read one way.
 *
 * `screens.motion` is `1`, `0`, or null for "never chosen". **Null is on**
 * (Q6): motion only exists in the styles a household picks for a widget, and
 * `prefers-reduced-motion` is honoured by the stylesheet whatever this says,
 * so a wall that has not been asked moves only where somebody chose a style
 * that moves.
 *
 * **Except on an e-ink size**, where null is off. A browser wall on an e-ink
 * tablet repaints the whole panel for each frame of an animation, and a
 * drifting cloud there is a flashing, ghosting smear rather than a cloud — so
 * the e-ink presets of the wall-size picker default the switch off. It is a
 * *default* and nothing more: a household who turns motion on for one keeps
 * it on, and one who never touches the switch has the default follow the
 * size, which is why the settings form leaves the column alone when the
 * switch was not moved (`admin.ts`).
 *
 * Only a preset counts, matched on its millimetres whichever way up it was
 * stored (`matchWallSize`). A household who typed their own size has said
 * nothing about what kind of screen it is, and a guess from the dimensions
 * would be a lit tablet the size of a 7.5" panel losing its motion for
 * nothing.
 *
 * One reader for the manifest and the form, so the switch the settings page
 * draws is exactly what the wall does.
 */
export function wallMotion(
  motion: number | null | undefined,
  panelWidthMm: number | null | undefined,
  panelHeightMm: number | null | undefined,
): boolean {
  if (motion === 1) return true;
  if (motion === 0) return false;
  return matchWallSize(panelWidthMm ?? null, panelHeightMm ?? null)?.eink !== true;
}
