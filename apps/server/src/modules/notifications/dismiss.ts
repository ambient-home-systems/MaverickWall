import type { Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { effectiveDisplay, readHousehold, readLayoutSlots, readLayoutWidgets } from '../../api/queries.js';
import { readLayoutOverride } from '../../api/wall-commands.js';
import { buildCall, callService, resolveConnection } from '../homeassistant/client.js';
import { releasePress, takePress } from '../homeassistant/control.js';
import { readStoredNotifications } from '../homeassistant/notifications.js';
import { haNotificationHandle } from './index.js';

/**
 * Dismissing one of Home Assistant's persistent notifications from a wall
 * (hard rule 12, amended 2026-10-14).
 *
 * **The wall names a handle and nothing else.** `han:` and 24 hex characters,
 * minted by `haNotificationHandle` from Home Assistant's own notification id,
 * which the wall is never given. The handle is matched against what this
 * server last read from Home Assistant, so a wall can dismiss only a
 * notification it could have been shown, and one at a time.
 *
 * **Shown means placed.** The notification must be on a Notifications widget
 * that shows Home Assistant's notifications, on a canvas this wall can draw —
 * both orientations, every named layout, and the layout another wall is
 * lending — the way a camera's picture is gated (`cameraPlacedOn`). A wall
 * with no such widget is told the notification does not exist.
 *
 * **Behind the wall's alert switch** (`allow_dismiss`, "Allow clearing
 * alerts"), which the route checks before it reads the body. The press is
 * counted against the same budget every other press is (`takePress`), so a
 * wall cannot spend twenty presses on lights and twenty more here.
 *
 * On success the row is deleted at once, so the next poll — which the wall
 * asks for straight away — draws the list without it, rather than waiting for
 * the next read of Home Assistant to say the same.
 */

export const HA_NOTIFICATION_HANDLE = /^han:[0-9a-f]{24}$/;

export type DismissResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 404 | 429 | 502; readonly error: string; readonly message: string };

const GONE = 'That notification is not there any more.';

/** Whether a Notifications widget showing Home Assistant's is on a canvas this wall can draw. */
export function haNotificationsShownOn(
  db: SqliteDatabase,
  screen: Parameters<typeof effectiveDisplay>[1] & { readonly id: string; readonly kind?: string },
  now: number,
): boolean {
  // A panel has nothing to press.
  if (screen.kind === 'epaper') return false;
  const owners = new Set<string | null>([effectiveDisplay(readHousehold(db), screen).layoutOwner]);
  const loan = readLayoutOverride(db, now);
  if (loan !== undefined) owners.add(loan.screenId);
  for (const owner of owners) {
    for (const slot of [null, ...readLayoutSlots(db, owner)]) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        for (const widget of readLayoutWidgets(db, owner, orientation, slot)) {
          if (widget.type !== 'notifications') continue;
          const config = widget.config;
          const off = typeof config === 'object' && config !== null && (config as Record<string, unknown>)['haNotifications'] === false;
          if (!off) return true;
        }
      }
    }
  }
  return false;
}

export interface DismissContext {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  readonly now: number;
}

export async function dismissHaNotification(
  context: DismissContext,
  screen: Parameters<typeof haNotificationsShownOn>[1],
  handle: string,
): Promise<DismissResult> {
  if (!HA_NOTIFICATION_HANDLE.test(handle)) return { ok: false, status: 400, error: 'bad-key', message: GONE };
  if (!haNotificationsShownOn(context.db, screen, context.now)) {
    return { ok: false, status: 404, error: 'not-found', message: GONE };
  }
  const found = readStoredNotifications(context.db).find((one) => haNotificationHandle(one.notificationId) === handle);
  if (found === undefined) return { ok: false, status: 404, error: 'not-found', message: GONE };

  if (!takePress(screen.id, handle, context.now)) {
    return { ok: false, status: 429, error: 'too-many', message: 'That was a lot of presses. Try again in a moment.' };
  }
  try {
    const resolved = resolveConnection(context.db, context.keyring);
    if (!resolved.ok) return { ok: false, status: 502, error: 'upstream', message: resolved.message };
    const built = buildCall({ key: 'notification.dismiss', notificationId: found.notificationId });
    if (!built.ok) return { ok: false, status: 404, error: 'not-found', message: GONE };
    const answer = await callService(context.fetcher, resolved.connection, built.call);
    if (!answer.ok) return { ok: false, status: 502, error: 'upstream', message: answer.message };
    context.db.prepare('DELETE FROM ha_notifications WHERE notification_id = ?').run(found.notificationId);
    return { ok: true };
  } finally {
    releasePress(handle);
  }
}
