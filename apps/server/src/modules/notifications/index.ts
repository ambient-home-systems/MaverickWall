import { createHash } from 'node:crypto';

import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import { NOTIFICATIONS_BLOCK, type HaNotification, type NotificationsPanel } from '../../api/notifications.js';
import { readStoredNotifications } from '../homeassistant/notifications.js';

/**
 * The Notifications widget's module (plan item M6.11).
 *
 * It holds Home Assistant's persistent notifications, read by the Home
 * Assistant job and cached in `ha_notifications`. The alert rules a household
 * set to say what they found as a tile are the other half, and they join this
 * slice in the manifest builder, from the same evaluation that draws the
 * banners — so the tiles are not this module's to read, and `ready` here is
 * Home Assistant's half alone; the builder adds the rest.
 *
 * Left out with nothing to say, like Timers: the widget is for the moments
 * there is something, and its `whenEmpty` is what the box shows the rest of the
 * time.
 */

/** A notification's handle: stable for the notification, naming nothing in the house. */
export function haNotificationHandle(notificationId: string): string {
  return `han:${createHash('sha256').update(`han:${notificationId}`).digest('hex').slice(0, 24)}`;
}

export const notificationsModule: PanelModule = {
  key: NOTIFICATIONS_BLOCK,
  label: 'Notifications',

  ready(db: SqliteDatabase): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM ha_notifications').get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  },

  contribute(context: ModuleContext): NotificationsPanel | null {
    const ha: HaNotification[] = readStoredNotifications(context.db).map((one) => ({
      key: haNotificationHandle(one.notificationId),
      ...(one.title === null ? {} : { title: one.title }),
      message: one.message,
      ...(one.createdAt === null ? {} : { createdAt: one.createdAt }),
    }));
    return ha.length === 0 ? null : { ha };
  },
};
