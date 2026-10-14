import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import { parseJsonOr, z } from '../../validation.js';
import { clean } from '../weather/alerts.js';
import { SUPERVISOR_BASE, type Connection } from './client.js';

/**
 * Home Assistant's persistent notifications (plan item M6.11), for the
 * Notifications widget.
 *
 * **Read over the WebSocket API, because that is the only place Home
 * Assistant keeps them.** Since 2023.6 they are no longer entities, so the
 * `/api/states` poll everything else here rides on cannot see them, and there
 * is no REST read. So this is one short conversation — authenticate, ask once,
 * read the answer, hang up — through the fetcher's guarded `socket`, which
 * resolves and pins the address exactly as every other request is pinned
 * (rule 4). It is not a subscription — the one subscription (`live.ts`) only
 * says when to read again — and a failed read here costs only the
 * notifications, which keep their last good copy.
 *
 * **Two messages are ever sent**: the token, as the handshake asks, and
 * `persistent_notification/get`, which is a read. Nothing here can dismiss or
 * create one — dismissing from a wall is no verb in RFC 018's table, and
 * `ha-write-boundary.test.ts` holds this file to those two.
 *
 * **Only while a Notifications widget asks**, so a house without one is never
 * asked anything new.
 */

/** The one command this file sends after the handshake. */
export const HA_NOTIFICATIONS_COMMAND = 'persistent_notification/get';

/** The most a wall is handed, newest first. A wall is not an inbox. */
export const MAX_HA_NOTIFICATIONS = 20;

/** Where the WebSocket API lives for a connection: the supervisor proxies it at its own fixed path. */
export function websocketUrl(connection: Connection): string {
  if (connection.mode === 'supervisor' || connection.baseUrl === SUPERVISOR_BASE) {
    return 'http://supervisor/core/websocket';
  }
  return `${connection.baseUrl}/websocket`;
}

const frame = z.looseObject({
  type: z.string(),
  id: z.number().optional(),
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

const notification = z.looseObject({
  notification_id: z.string().min(1).max(255),
  title: z.string().max(2000).nullable().optional(),
  message: z.string().max(20_000),
  created_at: z.string().max(64).optional(),
});

export interface StoredNotification {
  readonly notificationId: string;
  readonly title: string | null;
  readonly message: string;
  readonly createdAt: number | null;
}

/**
 * A notification's words, as plain text. Home Assistant writes them in
 * Markdown, and a wall draws text with `textContent`: a link keeps its words
 * and loses its address (nothing on a wall is a link), emphasis loses its
 * marks, and a heading its hashes. Then the sanitiser every stranger's string
 * goes through.
 */
export function plainText(markdown: string, limit: number): string | null {
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '');
  const cleaned = clean(plain, limit);
  return cleaned === null || cleaned === '' ? null : cleaned;
}

/** The notifications in an answer, newest first, each one that will not parse skipped. */
export function parseNotifications(result: unknown): StoredNotification[] {
  const list = Array.isArray(result) ? result : [];
  const out: StoredNotification[] = [];
  for (const entry of list) {
    const shaped = notification.safeParse(entry);
    if (!shaped.success) continue;
    const message = plainText(shaped.data.message, 400);
    if (message === null) continue;
    const title = shaped.data.title === null || shaped.data.title === undefined ? null : plainText(shaped.data.title, 120);
    const created = shaped.data.created_at === undefined ? NaN : Date.parse(shaped.data.created_at);
    out.push({
      notificationId: shaped.data.notification_id,
      title,
      message,
      createdAt: Number.isFinite(created) ? created : null,
    });
  }
  return out
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.notificationId.localeCompare(b.notificationId))
    .slice(0, MAX_HA_NOTIFICATIONS);
}

export type NotificationsRead =
  | { readonly ok: true; readonly notifications: readonly StoredNotification[] }
  | { readonly ok: false; readonly message: string };

/** One conversation: the handshake, the one question, the answer. */
export async function readHaNotifications(fetcher: Fetcher, connection: Connection): Promise<NotificationsRead> {
  if (fetcher.socket === undefined) return { ok: false, message: 'This build cannot read notifications.' };
  const outcome = await fetcher.socket({
    url: websocketUrl(connection),
    policy: connection.policy,
    maxBytes: FETCH_LIMITS.json,
    timeoutMs: 10_000,
    converse: (text) => {
      const shaped = frame.safeParse(parseJsonOr(z.unknown(), text, undefined));
      if (!shaped.success) return { fail: 'Home Assistant answered with something unreadable.' };
      const message = shaped.data;
      if (message.type === 'auth_required') {
        return { send: [JSON.stringify({ type: 'auth', access_token: connection.token })] };
      }
      if (message.type === 'auth_ok') {
        return { send: [JSON.stringify({ id: 1, type: HA_NOTIFICATIONS_COMMAND })] };
      }
      if (message.type === 'auth_invalid') return { fail: 'Home Assistant did not accept the token.' };
      if (message.type === 'result' && message.id === 1) {
        if (message.success !== true) {
          return { fail: message.error?.message === undefined ? 'Home Assistant refused to list its notifications.' : clean(message.error.message, 200) ?? 'Home Assistant refused.' };
        }
        return { done: JSON.stringify(message.result ?? []) };
      }
      // Anything else — an event nobody subscribed to — is not an answer.
      return { send: [] };
    },
  });
  if (outcome.status !== 'ok') return { ok: false, message: outcome.message };
  return { ok: true, notifications: parseNotifications(parseJsonOr(z.unknown(), outcome.body, [])) };
}

/**
 * Whether any Notifications widget, on any wall, canvas or layout, shows Home
 * Assistant's notifications — its `haNotifications` absent or on.
 */
export function wantsHaNotifications(db: SqliteDatabase): boolean {
  const rows = db
    .prepare(`SELECT config FROM layout_widgets WHERE type = 'notifications'`)
    .all() as { config: string | null }[];
  return rows.some((row) => {
    const config = parseJsonOr(z.record(z.string(), z.unknown()), row.config ?? '{}', {});
    return config['haNotifications'] !== false;
  });
}

/** Replace the stored notifications whole: one dismissed in Home Assistant leaves every wall. */
export function writeHaNotifications(db: SqliteDatabase, notifications: readonly StoredNotification[], at: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM ha_notifications').run();
    const insert = db.prepare(
      `INSERT INTO ha_notifications (notification_id, title, message, created_at, read_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const one of notifications) insert.run(one.notificationId, one.title, one.message, one.createdAt, at);
  })();
}

export function readStoredNotifications(db: SqliteDatabase): StoredNotification[] {
  return db
    .prepare(
      `SELECT notification_id AS notificationId, title, message, created_at AS createdAt
         FROM ha_notifications ORDER BY created_at DESC, notification_id`,
    )
    .all() as StoredNotification[];
}

/**
 * The read the Home Assistant job makes after its states (M6.11): asked only
 * while a widget wants it, and forgetting what it had once none does, so a
 * household that takes the widget away keeps nothing of Home Assistant's
 * words. A failed read keeps the last good copy.
 */
export async function refreshHaNotifications(
  db: SqliteDatabase,
  fetcher: Fetcher,
  connection: Connection,
  now: number,
): Promise<void> {
  if (!wantsHaNotifications(db)) {
    db.prepare('DELETE FROM ha_notifications').run();
    return;
  }
  const read = await readHaNotifications(fetcher, connection);
  if (read.ok) writeHaNotifications(db, read.notifications, now);
}
