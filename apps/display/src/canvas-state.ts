/**
 * What a canvas *is*, as one comparable string — and therefore whether it is
 * unsaved.
 *
 * Extracted from `layout-editor.ts` the way `placement.ts`, `history.ts` and
 * `ink.ts` were, and for the same reason: `boot()` holds every editor variable
 * in one closure, so a rule that lives inside it is a rule no test can reach.
 * There is no DOM in this package's test suite.
 *
 * The decision here is the save bar's. `widgetsForSave` is what the server is
 * posted, so the string built from it is the canonical form of "what this
 * canvas is" — which makes two questions the same comparison. **Is anything
 * unsaved?** is this against what was last saved. **Did that drag change
 * anything?** is this against what was remembered before it. A flag set by hand
 * would answer both approximately, and this project has already had one that
 * answered "saved" for a save that failed.
 *
 * The trap the extraction is for is the other direction: a canvas byte-identical
 * to the one the server holds that reports unsaved changes anyway, because the
 * snapshot and the request body disagree about some field. Both are built from
 * the functions below and from nothing else, so they cannot.
 */

import { MIN_SIZE } from './placement.js';

export type CanvasBackground =
  | { type: 'solid'; color: string }
  | { type: 'gradient'; from: string; to: string; angle: number }
  | { type: 'image'; image: string };

export interface EditorWidget {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** The widget's own options. Shape validated server-side (widgetConfigBody). */
  config?: Record<string, unknown>;
}

export interface CanvasShape {
  readonly aspect: number;
  readonly widgets: readonly EditorWidget[];
  readonly background?: CanvasBackground | undefined;
}

/** One widget as the server's `layoutBody` wants it. */
export interface SavedWidget {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config?: Record<string, unknown>;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The background as it is *posted*, which is not quite the background as it is
 * held: an image type with no picture chosen yet is "no background".
 *
 * One rule, read by the request body and by the snapshot dirtiness is measured
 * with. Two readings of one value is how a canvas identical to the one the
 * server holds comes to report unsaved changes — and it is the shape of half
 * the faults in this project's own list.
 */
export function postedBackground(
  background: CanvasBackground | undefined,
): CanvasBackground | null {
  return background !== undefined && !(background.type === 'image' && background.image === '')
    ? background
    : null;
}

/**
 * The widgets, sorted back-to-front and clamped, as the server wants them.
 *
 * `z` is rewritten as the index, so the numbers a canvas happens to be carrying
 * (0, 1, 2, 3, 5 after a drag raised one box) never reach the server and never
 * reach the snapshot either — what means anything is the order.
 */
export function widgetsForSave(widgets: readonly EditorWidget[]): SavedWidget[] {
  return [...widgets]
    .sort((a, b) => a.z - b.z)
    .map((w, index) => ({
      id: w.id,
      type: w.type,
      x: round3(clamp01(w.x)),
      y: round3(clamp01(w.y)),
      w: round3(Math.max(MIN_SIZE, Math.min(1, w.w))),
      h: round3(Math.max(MIN_SIZE, Math.min(1, w.h))),
      z: index,
      // Only when it holds something, so an untouched widget stores no config
      // row and the server sees a clean absence rather than `{}`.
      ...(w.config !== undefined && Object.keys(w.config).length > 0 ? { config: w.config } : {}),
    }));
}

/** The canvas as it would be saved, as one string. */
export function canvasSnapshot(canvas: CanvasShape): string {
  return JSON.stringify({
    aspect: round3(canvas.aspect),
    background: postedBackground(canvas.background),
    widgets: widgetsForSave(canvas.widgets),
  });
}

/**
 * Whether the save bar has anything to write.
 *
 * Recomputed rather than asserted, and it answers for *both* canvases:
 * dirtiness is per canvas (RFC 009 Phase 5), so the one waiting in the stash
 * keeps the bar live while the household is looking at the other one. Undoing
 * back to where you started clears it honestly, because it is a comparison
 * rather than a flag somebody remembered to reset.
 */
export function isCanvasDirty(
  active: CanvasShape,
  savedSnapshot: string,
  stashDirty: boolean,
): boolean {
  return stashDirty || canvasSnapshot(active) !== savedSnapshot;
}
