import type { Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { listProjects, type TodoistEndpoint, type TodoistProject } from './client.js';

/**
 * The Todoist connection, as this application keeps it (plan item M5.7).
 *
 * One sealed token. It is stored only after it has been used — the projects
 * read with it — so "Connected" is never said of a token Todoist refused, and
 * it is opened only for the length of one request. Disconnecting forgets it
 * and every Todoist list with it, for the reason disconnecting Home Assistant
 * forgets its lists: a cache of somebody's shopping is a record of their home,
 * and a list left behind would keep a widget drawing a list that never
 * refreshes.
 */

/** The prefix a Todoist project's list carries in the to-do store, beside Home Assistant's `todo.`. */
export const TODOIST_LIST_PREFIX = 'todoist:';

export function isTodoistList(listId: string): boolean {
  return listId.startsWith(TODOIST_LIST_PREFIX);
}

/** A project's list id in the to-do store. */
export function todoistListId(projectId: string): string {
  return `${TODOIST_LIST_PREFIX}${projectId}`;
}

/** The project a Todoist list id names. */
export function todoistProjectOf(listId: string): string {
  return listId.slice(TODOIST_LIST_PREFIX.length);
}

export function todoistConnected(db: SqliteDatabase): boolean {
  const row = db.prepare(`SELECT count(*) AS n FROM todoist_connection WHERE id = 'singleton'`).get() as { n: number };
  return row.n > 0;
}

export type TokenResult = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly message: string };

/** The sealed token, opened for one request — or why there is none. */
export function todoistToken(db: SqliteDatabase, keyring: Keyring): TokenResult {
  const row = db.prepare(`SELECT token_encrypted AS token FROM todoist_connection WHERE id = 'singleton'`).get() as
    | { token: string }
    | undefined;
  if (row === undefined) {
    return { ok: false, message: 'Todoist is not connected. Connect it on the Todoist screen.' };
  }
  const opened = keyring.decrypt(row.token, 'todoist-token');
  if (!opened.ok) {
    return { ok: false, message: 'The Todoist token could not be opened. Connect Todoist again on the Todoist screen.' };
  }
  return { ok: true, token: opened.value };
}

export type ConnectResult =
  | { readonly ok: true; readonly projects: readonly TodoistProject[] }
  | { readonly ok: false; readonly message: string };

/**
 * Connect with a token, after reading the projects with it. Nothing is stored
 * for a token Todoist refused, and the household's sentence says so.
 */
export async function connectTodoist(
  context: { readonly db: SqliteDatabase; readonly keyring: Keyring; readonly fetcher: Fetcher; readonly now: number },
  endpoint: TodoistEndpoint,
  token: string,
): Promise<ConnectResult> {
  const projects = await listProjects(context.fetcher, endpoint, token);
  if (!projects.ok) return projects;
  context.db
    .prepare(
      `INSERT INTO todoist_connection (id, token_encrypted, connected_at, last_error, updated_at)
       VALUES ('singleton', ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET token_encrypted = excluded.token_encrypted, last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(context.keyring.encrypt(token, 'todoist-token'), context.now, context.now);
  return { ok: true, projects: projects.value };
}

/** Forget the token and every Todoist list, items and all. */
export function disconnectTodoist(db: SqliteDatabase): void {
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM ha_todo_items WHERE entity_id LIKE 'todoist:%'`).run();
    db.prepare(`DELETE FROM ha_todo_lists WHERE entity_id LIKE 'todoist:%'`).run();
    db.prepare(`DELETE FROM todoist_connection`).run();
  });
  write();
}
