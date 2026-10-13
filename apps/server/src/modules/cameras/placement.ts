import type { SqliteDatabase } from '../../db/open.js';
import type { Interrupt } from '@maverick-wall/core';
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

const isTakeover = (interrupt: Interrupt): boolean =>
  interrupt.action === 'takeover' || interrupt.action === 'takeover_and_wake';

/**
 * The camera the wall-covering interrupt is showing, if it shows one (plan
 * item M6.3). `resolveConflicts` lets one takeover through at a time, so this
 * is at most one camera — the one a doorbell rule named, while it holds.
 */
export function takeoverCamera(active: readonly Interrupt[]): string | undefined {
  return active.find(isTakeover)?.camera;
}

/**
 * The interrupts as a wall is sent them: a camera only on a takeover, and only
 * one this house still has. A camera removed since its rule was written is no
 * camera, and the takeover still says what happened — rule nine: the bell
 * rang whether or not there is a picture of it.
 */
export function withTakeoverCameras(interrupts: readonly Interrupt[], known: ReadonlySet<string>): Interrupt[] {
  return interrupts.map((interrupt) => {
    if (interrupt.camera === undefined || (isTakeover(interrupt) && known.has(interrupt.camera))) return interrupt;
    const { camera: _dropped, ...rest } = interrupt;
    return rest;
  });
}
