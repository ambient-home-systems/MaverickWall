import type { ManifestWidget } from './manifest.js';

/**
 * The boxes on the glass at `now`, for a canvas whose boxes may be shown only
 * for a while (plan item M6.5).
 *
 * The server decides whether a box is shown and, for a pulse — the doorbell's
 * camera for a minute after somebody presses it — until when; this makes the
 * swap at that instant by the wall's own corrected clock, so the camera leaves
 * on time with the server busy or gone, and two walls agree because the
 * instant is Home Assistant's rather than either wall's. A box whose time is
 * up draws its `then` — its fallback, in the same rectangle — or nothing; a
 * group whose time is up goes with every box inside it. Nothing moves: a
 * rectangle is never given to a neighbour.
 *
 * Read defensively: a stored copy written by another bundle may carry
 * anything, and anything that is not a finite instant is no pulse.
 */
export function shownAt(widgets: readonly ManifestWidget[], now: number): readonly ManifestWidget[] {
  if (!widgets.some((widget) => widget.showUntil !== undefined)) return widgets;
  const gone = new Set<string>();
  const out: ManifestWidget[] = [];
  for (const widget of widgets) {
    if (typeof widget.parentId === 'string' && gone.has(widget.parentId)) continue;
    const until = widget.showUntil;
    if (typeof until !== 'number' || !Number.isFinite(until) || now < until) {
      out.push(widget);
      continue;
    }
    if (widget.type === 'group') {
      gone.add(widget.id);
      continue;
    }
    const then = widget.then;
    if (typeof then === 'object' && then !== null && typeof (then as ManifestWidget).type === 'string') {
      out.push({ ...(then as ManifestWidget), id: widget.id });
    }
  }
  return out;
}
