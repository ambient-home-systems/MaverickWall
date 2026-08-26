/**
 * Where a widget sits on the canvas, as arithmetic.
 *
 * Extracted from `layout-editor.ts` the way `widget-options.ts` and `ink.ts`
 * were, and for the same reason: the editor's pointer drag, its arrow keys and
 * the four numeric fields in the inspector all answer the same question — what
 * does this box become — and three copies of that answer is how a keyboard nudge
 * comes to stop at a different edge than a drag does. There is no DOM in this
 * package's test suite, so a rule written inside a pointer handler is a rule
 * nothing can check.
 *
 * Coordinates are fractions of the canvas throughout, the same as the manifest,
 * and every result is rounded to three places — the form the canvas is saved in,
 * so what is measured here is what is stored.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The smallest a widget may be, as a fraction of the canvas.
 *
 * The same 0.05 `widgetsForSave` clamps to and the server's schema accepts. A
 * box smaller than this is one nobody can grab again.
 */
export const MIN_SIZE = 0.05;

/**
 * One arrow key: 1% of the canvas.
 *
 * A hundred presses crosses the wall, which is the right order for a nudge —
 * the coarse move is the drag, and the exact one is the numeric field. It is
 * deliberately not the snap grid (1/24): snapping is an editor aid that can be
 * switched off, and an arrow key that moved a twenty-fourth would be a different
 * distance depending on a toggle in a popover.
 */
export const NUDGE_STEP = 0.01;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

/** The box moved so its top-left is (x, y), kept whole on the canvas. */
export function moveTo(box: Box, x: number, y: number): Box {
  return {
    x: round3(clamp(x, 0, Math.max(0, 1 - box.w))),
    y: round3(clamp(y, 0, Math.max(0, 1 - box.h))),
    w: box.w,
    h: box.h,
  };
}

/**
 * The box resized from its top-left, kept on the canvas and above the floor.
 *
 * The corner that moves is the bottom-right one — the resize handle — so the
 * origin stays put and the width is bounded by what is left of the canvas.
 */
export function resizeTo(box: Box, w: number, h: number): Box {
  return {
    x: box.x,
    y: box.y,
    w: round3(clamp(w, MIN_SIZE, Math.max(MIN_SIZE, 1 - box.x))),
    h: round3(clamp(h, MIN_SIZE, Math.max(MIN_SIZE, 1 - box.y))),
  };
}

/** One numeric field in the inspector: an exact edge, in fractions. */
export function setDimension(box: Box, field: 'x' | 'y' | 'w' | 'h', value: number): Box {
  if (!Number.isFinite(value)) return box;
  if (field === 'x') return moveTo(box, value, box.y);
  if (field === 'y') return moveTo(box, box.x, value);
  if (field === 'w') return resizeTo(box, value, box.h);
  return resizeTo(box, box.w, value);
}

/**
 * An arrow key on a focused widget: move it, or — with Shift — resize it.
 *
 * Returns nothing for every other key, which is what lets the caller leave the
 * event alone: an arrow that is not a nudge has to keep scrolling the page, and
 * a key that is a nudge must not.
 */
export function nudge(
  box: Box,
  key: string,
  options: { readonly resize: boolean; readonly step?: number },
): Box | undefined {
  const step = options.step ?? NUDGE_STEP;
  const along =
    key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const down = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  if (along === 0 && down === 0) return undefined;
  return options.resize
    ? resizeTo(box, box.w + along, box.h + down)
    : moveTo(box, box.x + along, box.y + down);
}
