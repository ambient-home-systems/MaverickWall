import type { SqliteDatabase } from '../../db/open.js';
import { cameraOf } from '../../api/manifest.js';
import { effectiveDisplay, readHousehold, readLayoutSlots, readLayoutWidgets } from '../../api/queries.js';
import { readLayoutOverride } from '../../api/wall-commands.js';

/**
 * Whether a wall may ask for a camera's picture: only when a camera widget
 * naming that handle is on a canvas the wall can draw (RFC 007 §6.4 step 2).
 *
 * **Placement is the canvas**, and nothing else answers it — no per-screen
 * switch and no placement column, which would be a second copy of where the
 * household dragged the widget (RFC 007 §6.3). Every canvas the wall can draw
 * counts, because the gate cannot know which one is on its glass this minute:
 * both orientations, every named layout its schedule swaps in, and the layout
 * another wall is lending every wall while that loan runs (M1.3). A camera
 * inside a group is a row like any other.
 *
 * A wall that may not have it is told the camera does not exist (`404`, never
 * `403`): nothing tells a screen that a handle it was not given is real.
 */
export function cameraPlacedOn(
  db: SqliteDatabase,
  screen: Parameters<typeof effectiveDisplay>[1] & { readonly id: string; readonly kind?: string },
  handle: string,
  now: number,
): boolean {
  // A panel draws no picture (RFC 007 §7.4), so it never needs one.
  if (screen.kind === 'epaper') return false;
  const owners = new Set<string | null>([effectiveDisplay(readHousehold(db), screen).layoutOwner]);
  const loan = readLayoutOverride(db, now);
  if (loan !== undefined) owners.add(loan.screenId);
  for (const owner of owners) {
    for (const slot of [null, ...readLayoutSlots(db, owner)]) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        for (const widget of readLayoutWidgets(db, owner, orientation, slot)) {
          if (widget.type === 'camera' && cameraOf(widget.config) === handle) return true;
        }
      }
    }
  }
  return false;
}
