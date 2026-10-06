import type { SqliteDatabase } from '../db/open.js';

/**
 * Telling walls what to do from elsewhere (plan items M1.2, M1.3 and M2.3):
 * reload, and show one wall's layout on every wall for a while. The admin and
 * the companion API both call these, so the two cannot disagree about which
 * walls a command reaches or how long a borrowed layout lasts.
 *
 * Neither command pushes anything. A wall learns of both on its next poll —
 * up to a minute, until the push channel reaches the browser wall (M1.1) — and
 * that is why each is a fact the manifest carries rather than a message that
 * could be missed: a wall that was off when the command was given still acts
 * on it when it comes back, and one started after it has nothing to act on.
 */

/** How long a borrowed layout lasts unless somebody says, and the longest it may. */
export const DEFAULT_SHOW_MINUTES = 10;
export const MAX_SHOW_MINUTES = 120;

export interface WallRef {
  readonly id: string;
  readonly name: string;
}

/** The browser walls a command can reach: paired, not revoked, not a panel. */
export function browserWalls(db: SqliteDatabase): WallRef[] {
  return db
    .prepare(
      `SELECT id, name FROM screens
        WHERE revoked_at IS NULL AND kind <> 'epaper'
        ORDER BY name COLLATE NOCASE, id`,
    )
    .all() as WallRef[];
}

export type WallMatch =
  | { readonly ok: true; readonly wall: WallRef }
  | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous'; readonly message: string };

/**
 * Which browser wall a caller means, by its id or, without case, by its name.
 * An e-paper panel is never a match: it has no layout to lend and no page to
 * reload, so naming one is answered as a wall that is not there.
 */
export function findBrowserWall(db: SqliteDatabase, wanted: string): WallMatch {
  const walls = browserWalls(db);
  const byId = walls.find((wall) => wall.id === wanted);
  if (byId !== undefined) return { ok: true, wall: byId };
  const folded = wanted.trim().toLocaleLowerCase('en');
  const byName = walls.filter((wall) => wall.name.trim().toLocaleLowerCase('en') === folded);
  if (byName.length === 1) return { ok: true, wall: byName[0]! };
  if (byName.length > 1) {
    return { ok: false, reason: 'ambiguous', message: 'More than one wall has that name. Rename one under Walls.' };
  }
  const names = walls.map((wall) => `“${wall.name}”`).join(', ');
  return {
    ok: false,
    reason: 'not-found',
    message: walls.length === 0 ? 'There are no browser walls yet.' : `No wall is called that. The walls are ${names}.`,
  };
}

/**
 * Ask walls to reload — one, or every browser wall. Answers how many it asked,
 * so a caller that reached none can say so. A reload is safe: the wall draws
 * its stored copy first, then fetches everything again.
 */
export function requestRefresh(db: SqliteDatabase, which: { readonly id: string } | 'all', now: number): number {
  if (which === 'all') {
    return db
      .prepare(
        `UPDATE screens SET refresh_requested_at = ?
          WHERE revoked_at IS NULL AND kind <> 'epaper'`,
      )
      .run(now).changes;
  }
  return db
    .prepare(
      `UPDATE screens SET refresh_requested_at = ?
        WHERE id = ? AND revoked_at IS NULL AND kind <> 'epaper'`,
    )
    .run(now, which.id).changes;
}

export interface ActiveOverride {
  readonly screenId: string;
  readonly name: string;
  readonly until: number;
}

/**
 * The borrowed layout in force at `now`, or nothing. One that has run out, or
 * whose wall has since been revoked or turned into something else, is not in
 * force — and the expired row is left for the next start to replace, since an
 * expired row and no row mean the same thing to every reader.
 */
export function readLayoutOverride(db: SqliteDatabase, now: number): ActiveOverride | undefined {
  const row = db
    .prepare(
      `SELECT o.screen_id AS screenId, s.name AS name, o.until AS until
         FROM layout_override o JOIN screens s ON s.id = o.screen_id
        WHERE o.id = 'singleton' AND o.until > ?
          AND s.revoked_at IS NULL AND s.kind <> 'epaper'`,
    )
    .get(now) as ActiveOverride | undefined;
  return row;
}

/** Show this wall's layout on every other browser wall until `minutes` from now, replacing any already showing. */
export function startLayoutOverride(
  db: SqliteDatabase,
  screenId: string,
  minutes: number,
  now: number,
): { readonly ok: true; readonly until: number } | { readonly ok: false; readonly message: string } {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SHOW_MINUTES) {
    return { ok: false, message: `A layout can be shown for between 1 and ${MAX_SHOW_MINUTES} minutes.` };
  }
  if (!browserWalls(db).some((wall) => wall.id === screenId)) {
    return { ok: false, message: 'Only a browser wall’s layout can be shown on every wall.' };
  }
  const until = now + minutes * 60_000;
  db.prepare(
    `INSERT INTO layout_override (id, screen_id, until, created_at) VALUES ('singleton', ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET screen_id = excluded.screen_id, until = excluded.until,
       created_at = excluded.created_at`,
  ).run(screenId, until, now);
  return { ok: true, until };
}

/** Put every wall back on its own layout now. False when nothing was showing, so a caller claims nothing it did not do. */
export function endLayoutOverride(db: SqliteDatabase, now: number): boolean {
  const active = readLayoutOverride(db, now) !== undefined;
  db.prepare(`DELETE FROM layout_override WHERE id = 'singleton'`).run();
  return active;
}
