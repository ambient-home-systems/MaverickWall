import type { SqliteDatabase } from '../db/open.js';
import { parseBackground } from './manifest.js';
import { readHousehold } from './queries.js';
import { rotationSteps } from './picture-rotation.js';

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

/**
 * The browser walls whose background rotates (plan item M4.10), and how often,
 * as the wall would resolve them: the portrait canvas's background first, then
 * the landscape one's, each falling back to the household's as `effectiveDisplay`
 * does. A wall with neither rotating has no next picture.
 */
function rotatingWalls(db: SqliteDatabase): {
  readonly id: string;
  readonly name: string;
  readonly every: number;
  readonly timezone: string;
  readonly pressedAt: number | null;
  readonly step: number | null;
}[] {
  const household = readHousehold(db);
  const rows = db
    .prepare(
      `SELECT id, name, timezone, layout_background AS portrait, layout_landscape_background AS landscape,
              picture_pressed_at AS pressedAt, picture_step AS step
         FROM screens WHERE revoked_at IS NULL AND kind <> 'epaper' ORDER BY name COLLATE NOCASE, id`,
    )
    .all() as {
    id: string;
    name: string;
    timezone: string | null;
    portrait: string | null;
    landscape: string | null;
    pressedAt: number | null;
    step: number | null;
  }[];
  const walls = [];
  for (const row of rows) {
    const backgrounds = [
      parseBackground(row.portrait ?? household.layoutBackground),
      parseBackground(row.landscape ?? household.layoutLandscapeBackground),
    ];
    const rotation = backgrounds.find((bg) => bg?.type === 'rotation');
    if (rotation?.type !== 'rotation') continue;
    walls.push({
      id: row.id,
      name: row.name,
      every: rotation.every,
      timezone: row.timezone !== null && row.timezone !== '' ? row.timezone : household.timezone,
      pressedAt: row.pressedAt,
      step: row.step,
    });
  }
  return walls;
}

/**
 * Move a wall's rotating background on to its next picture now, and restart
 * that picture's time (plan items M1.4, M2.3) — one wall, or every wall whose
 * background rotates. Answers which walls moved, so a caller can say "that
 * wall's background does not rotate" rather than claim a change nothing made.
 *
 * Counted in steps, with the wall's own arithmetic (`picture-rotation.ts`):
 * the step it is on now, plus one, from this moment. It needs nothing about
 * the pictures, so a portrait and a landscape canvas rotating through
 * different collections both move on.
 */
export function nextPicture(db: SqliteDatabase, which: { readonly id: string } | 'all', now: number): WallRef[] {
  const moved: WallRef[] = [];
  for (const wall of rotatingWalls(db)) {
    if (which !== 'all' && wall.id !== which.id) continue;
    const steps = rotationSteps(
      wall.every,
      now,
      wall.timezone,
      wall.pressedAt === null ? undefined : wall.pressedAt,
      wall.step ?? 0,
    );
    db.prepare('UPDATE screens SET picture_pressed_at = ?, picture_step = ? WHERE id = ?').run(now, steps + 1, wall.id);
    moved.push({ id: wall.id, name: wall.name });
  }
  return moved;
}

/** Whether this wall's background rotates, so its menu offers Next picture. */
export function wallRotates(db: SqliteDatabase, id: string): boolean {
  return rotatingWalls(db).some((wall) => wall.id === id);
}
