import { randomBytes } from 'node:crypto';

import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * Messages (plan items M2.2 and M5.2): short notes from a phone or an
 * automation — "Back at 6", "Bins tonight" — each gone on its own once it
 * expires, drawn by a Messages widget on every wall that has one.
 *
 * The expiry travels in the manifest and the wall hides an expired message
 * itself, so a wall that lost the server does not go on saying "Back at 6"
 * at nine. The text is the household's own and is never logged; it is refused
 * with control characters at the boundary and drawn with `textContent`.
 */

export const MESSAGES_BLOCK = 'messages';

/** More than this is a noticeboard, not a glance — and a stuck automation is cheaper to stop. */
export const MAX_MESSAGES = 8;
/** A message is a sentence: about a phone screen's worth. */
export const MAX_MESSAGE_TEXT = 200;
/** How long a message stays when nobody says, and the longest it may. */
export const DEFAULT_MESSAGE_MINUTES = 60;
export const MAX_MESSAGE_MINUTES = 24 * 60;

export interface MessageRow {
  readonly id: string;
  readonly body: string;
  readonly postedAt: number;
  readonly expiresAt: number;
}

/** The shape of a message's id, minted here and nowhere else. */
export const MESSAGE_ID = /^ms-[0-9a-f]{12}$/;

/** Every message still showing at `now`, newest first. */
export function readLiveMessages(db: SqliteDatabase, now: number): MessageRow[] {
  return db
    .prepare(
      `SELECT id, body, posted_at AS postedAt, expires_at AS expiresAt
         FROM messages WHERE expires_at > ? ORDER BY posted_at DESC, id`,
    )
    .all(now) as MessageRow[];
}

export function pruneMessages(db: SqliteDatabase, now: number): void {
  db.prepare('DELETE FROM messages WHERE expires_at <= ?').run(now);
}

export type PostResult =
  | { readonly ok: true; readonly message: MessageRow }
  | { readonly ok: false; readonly reason: string };

export function postMessage(
  db: SqliteDatabase,
  input: { readonly body: string; readonly minutes: number },
  now: number,
): PostResult {
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_MESSAGE_MINUTES) {
    return { ok: false, reason: 'A message shows for between a minute and a day.' };
  }
  pruneMessages(db, now);
  if (readLiveMessages(db, now).length >= MAX_MESSAGES) {
    return {
      ok: false,
      reason: `There are already ${MAX_MESSAGES} messages on the walls. Clear one first.`,
    };
  }
  const message: MessageRow = {
    id: `ms-${randomBytes(6).toString('hex')}`,
    body: input.body,
    postedAt: now,
    expiresAt: now + input.minutes * 60_000,
  };
  db.prepare('INSERT INTO messages (id, body, posted_at, expires_at) VALUES (?, ?, ?, ?)').run(
    message.id,
    message.body,
    message.postedAt,
    message.expiresAt,
  );
  return { ok: true, message };
}

/**
 * Clear one message, or all of them — from a phone, the admin, or a wall
 * allowed to (MD7). Answers how many went, so a caller that cleared nothing can
 * say so; a wall clearing one already gone is not an error.
 */
export function clearMessages(db: SqliteDatabase, selection: { readonly id: string } | { readonly all: true }): number {
  if ('all' in selection) return db.prepare('DELETE FROM messages').run().changes;
  return db.prepare('DELETE FROM messages WHERE id = ?').run(selection.id).changes;
}

export interface MessagesPanel {
  readonly messages: readonly {
    readonly key: string;
    readonly text: string;
    readonly postedAt: number;
    readonly expiresAt: number;
  }[];
}

export const messagesModule: PanelModule = {
  key: MESSAGES_BLOCK,
  label: 'Messages',

  /** Any row at all, for the reason `timersModule.ready` gives: it is asked without a clock. */
  ready(db: SqliteDatabase): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  },

  contribute(context: ModuleContext): MessagesPanel {
    return {
      messages: readLiveMessages(context.db, context.now).map((message) => ({
        key: message.id,
        text: message.body,
        postedAt: message.postedAt,
        expiresAt: message.expiresAt,
      })),
    };
  },

  job: {
    kind: 'messages-tidy',
    intervalMs: 60_000,
    async run(context: ModuleContext): Promise<void> {
      pruneMessages(context.db, context.now);
    },
  },
};
