/**
 * Which boxes are selected, as a set with an order.
 *
 * The editor used to hold one id, and every rule about it lived in `boot()`:
 * a tap chose a box, and that was the whole of selection. Grouping (RFC 014
 * §5.1) needs two or more, chosen by Shift+click or by dragging a marquee
 * over empty layout, and the rules for what that set becomes — what a second
 * Shift+click on the same box does, which boxes a rectangle encloses — are
 * arithmetic on ids and boxes that no test could reach inside a pointer
 * handler. There is no DOM in this package's test suite, so they are here.
 *
 * The set is an array rather than a `Set` because its order is meaningful:
 * the first entry is the *primary* selection, the one the inspector describes
 * when only one is chosen and the one focus returns to when the sheet closes.
 */

import type { Box } from './placement.js';

/** Shift+click: in if it was out, out if it was in; the order is otherwise kept. */
export function toggleSelected(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((one) => one !== id) : [...selection, id];
}

/**
 * The rectangle between two pointer positions, in the same fractions of the
 * layout the boxes are stored in — whichever corner the drag started from.
 */
export function marqueeBetween(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Box {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

/**
 * The boxes a marquee *encloses* — every edge inside it, never merely touched.
 *
 * Enclosure rather than intersection, because a drag across a busy layout
 * that grabbed everything it brushed would select the box the household was
 * dragging *over* to reach the ones behind it. The boxes are handed over with
 * their rectangles already on the canvas (a child's is resolved through its
 * group first), so this reads nothing about parents; what to offer it is the
 * caller's — a marquee selects the boxes on the layout itself, not the boxes
 * inside a group, which are reached by tapping into it.
 */
export function enclosedBy<T extends Box & { readonly id: string }>(
  boxes: readonly T[],
  marquee: Box,
): string[] {
  const right = marquee.x + marquee.w;
  const bottom = marquee.y + marquee.h;
  const eps = 1e-9;
  return boxes
    .filter(
      (box) =>
        box.x >= marquee.x - eps &&
        box.y >= marquee.y - eps &&
        box.x + box.w <= right + eps &&
        box.y + box.h <= bottom + eps,
    )
    .map((box) => box.id);
}

/**
 * A press that never became a drag. Below this a marquee is a tap on empty
 * layout, which clears the selection as it always has; above it the rectangle
 * is the selection. In fractions of the canvas, so it is the same gesture on a
 * phone and a monitor — about a quarter of a per cent, well under a finger.
 */
export const MARQUEE_MIN = 0.0025;
