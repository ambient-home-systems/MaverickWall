import { randomBytes } from 'node:crypto';

import type { ChoreSchedule, CivilDate } from '@maverick-wall/core';

import type { SqliteDatabase } from '../db/open.js';
import { parseOr, z } from '../validation.js';

/**
 * Chores at the storage layer (RFC 008 phase 1).
 *
 * Separate from `queries.ts`, which is already 1400 lines, and separate from
 * the admin page for the reason `api/rules.ts` is: a chore is read by the
 * manifest in phase 2 and written by the wall in phase 3, and neither of those
 * should have to import a page.
 *
 * Nothing here has a clock in it. Every function that needs to know what day it
 * is takes the civil date, because the household's zone is a fact this layer
 * has no business resolving twice.
 */

// ---------------------------------------------------------------------------
// The stored schedule, on the way back out
// ---------------------------------------------------------------------------

/**
 * The `ChoreSchedule` shape, as Zod.
 *
 * This process wrote the column, having validated the form that produced it —
 * so by the letter of the open question in `CLAUDE.md` it is an internal read.
 * It is validated anyway, and cheaply, because the row outlives the build that
 * wrote it: a schedule written by a newer image and read by a rolled-back one
 * is a genuine boundary, and the alternative is `dueOn` being handed a shape
 * its types swore was impossible.
 *
 * `weekdays` requires at least one day. An empty list is a chore that is never
 * due, which is a thing somebody can save by accident and can never see the
 * effect of — so the form refuses it here rather than storing a chore that
 * silently does nothing.
 */
export const choreScheduleSchema: z.ZodType<ChoreSchedule> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily') }).strict(),
  z
    .object({
      kind: z.literal('weekdays'),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      kind: z.literal('everyNDays'),
      n: z.number().int().min(1).max(365),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict(),
  // 28 and no higher, deliberately — see the type in core for why clamping 31
  // to "the last day" is a refusal rather than a missing feature.
  z.object({ kind: z.literal('monthlyDate'), day: z.number().int().min(1).max(28) }).strict(),
  z
    .object({ kind: z.literal('once'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .strict(),
]) as z.ZodType<ChoreSchedule>;

/**
 * A schedule that is never due, for a row that will not parse.
 *
 * Not `daily`: a chore whose schedule cannot be read must not start appearing
 * every day on somebody's wall. Never-due is the quiet failure, and the admin
 * draws it as "No schedule" so it is visible where somebody can fix it.
 */
const UNREADABLE: ChoreSchedule = { kind: 'weekdays', days: [] };

function readSchedule(raw: unknown): ChoreSchedule {
  if (typeof raw === 'string') {
    try {
      return parseOr(choreScheduleSchema, JSON.parse(raw), UNREADABLE);
    } catch {
      return UNREADABLE;
    }
  }
  return parseOr(choreScheduleSchema, raw, UNREADABLE);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface ChoreRow {
  readonly id: string;
  readonly name: string;
  /** Null when the chore belongs to the household rather than to one person. */
  readonly personId: string | null;
  readonly personName: string | null;
  /** The person's own colour, which is what the wall already draws them in. */
  readonly personColor: string | null;
  readonly schedule: ChoreSchedule;
  readonly dueTime: string | null;
  readonly sortOrder: number;
}

export interface ChoreInput {
  readonly name: string;
  readonly personId: string | null;
  readonly schedule: ChoreSchedule;
  readonly dueTime: string | null;
}

/**
 * Every chore, in the household's chosen order.
 *
 * The person is joined rather than looked up per row: a chore board is drawn
 * with its people every time, and three chores meaning three more queries on a
 * Raspberry Pi is the kind of thing that is invisible until it is not.
 */
export function readChores(db: SqliteDatabase): ChoreRow[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.person_id AS personId, c.schedule,
              c.due_time AS dueTime, c.sort_order AS sortOrder,
              p.name AS personName, p.color AS personColor
         FROM chores c
         LEFT JOIN people p ON p.id = c.person_id
        ORDER BY c.sort_order, c.name`,
    )
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      const str = (value: unknown): string | null =>
        typeof value === 'string' && value !== '' ? value : null;
      return {
        id: String(record['id']),
        name: String(record['name']),
        personId: str(record['personId']),
        personName: str(record['personName']),
        personColor: str(record['personColor']),
        schedule: readSchedule(record['schedule']),
        dueTime: str(record['dueTime']),
        sortOrder: Number(record['sortOrder'] ?? 0),
      };
    });
}

export function createChore(db: SqliteDatabase, input: ChoreInput): string {
  const at = Date.now();
  const id = randomBytes(8).toString('hex');
  const next =
    (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM chores').get() as { n: number }).n +
    1;
  db.prepare(
    `INSERT INTO chores (id, name, person_id, schedule, due_time, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.personId, JSON.stringify(input.schedule), input.dueTime, next, at, at);
  return id;
}

export function updateChore(db: SqliteDatabase, id: string, input: ChoreInput): void {
  db.prepare(
    `UPDATE chores SET name = ?, person_id = ?, schedule = ?, due_time = ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.name, input.personId, JSON.stringify(input.schedule), input.dueTime, Date.now(), id);
}

/**
 * Remove a chore, and with it every record of it having been done.
 *
 * The cascade is deliberate and worth stating: there is no archive. A household
 * removing "Bins" is saying the chore is over, and keeping an orphaned history
 * nothing can show is a table that only ever grows. Pausing a chore without
 * losing its history is a separate control, and it should arrive with the
 * screen that would make it visible rather than as a switch that does nothing.
 */
export function deleteChore(db: SqliteDatabase, id: string): void {
  db.prepare('DELETE FROM chore_completions WHERE chore_id = ?').run(id);
  db.prepare('DELETE FROM chores WHERE id = ?').run(id);
}

/** Swap one chore with its neighbour, the way the People and Shift Types lists do. */
export function moveChore(db: SqliteDatabase, id: string, direction: 'up' | 'down'): void {
  const rows = db
    .prepare('SELECT id, sort_order AS sortOrder FROM chores ORDER BY sort_order, name')
    .all() as { id: string; sortOrder: number }[];
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) return;
  const other = direction === 'up' ? index - 1 : index + 1;
  if (other < 0 || other >= rows.length) return;

  const a = rows[index] as { id: string; sortOrder: number };
  const b = rows[other] as { id: string; sortOrder: number };
  const at = Date.now();
  /*
   * The stored orders may be equal — rows created before this list had one, or
   * ordered by name inside a tie. Swapping equal values is a no-op that reads
   * as "the button does nothing", so a tie is broken by the positions instead.
   */
  const [first, second] = a.sortOrder === b.sortOrder ? [index, other] : [a.sortOrder, b.sortOrder];
  const update = db.prepare('UPDATE chores SET sort_order = ?, updated_at = ? WHERE id = ?');
  update.run(second, at, a.id);
  update.run(first, at, b.id);
}

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

/**
 * Which of the given dates this chore was done on.
 *
 * A set rather than a list because every caller asks "was it done on this day"
 * — the admin's recent history, and in phase 2 the wall drawing today's board.
 */
export function completionDates(
  db: SqliteDatabase,
  choreId: string,
  from: CivilDate,
  to: CivilDate,
): Set<CivilDate> {
  const rows = db
    .prepare('SELECT date FROM chore_completions WHERE chore_id = ? AND date >= ? AND date <= ?')
    .all(choreId, from, to) as { date: string }[];
  return new Set(rows.map((row) => row.date));
}

/**
 * Every completion in a date range, as `choreId|date` keys.
 *
 * One query for the whole board rather than one per chore: a household with a
 * dozen chores and a seven-day panel is otherwise eighty-four round trips on
 * every display poll, on a Raspberry Pi. The compound key is what the caller
 * asks with, so nothing has to build a map of maps.
 */
export function completionsBetween(
  db: SqliteDatabase,
  from: CivilDate,
  to: CivilDate,
): Set<string> {
  const rows = db
    .prepare('SELECT chore_id AS choreId, date FROM chore_completions WHERE date >= ? AND date <= ?')
    .all(from, to) as { choreId: string; date: string }[];
  return new Set(rows.map((row) => `${row.choreId}|${row.date}`));
}

/** Whether this household has any chores at all — what gates the wall's block. */
export function anyChores(db: SqliteDatabase): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM chores').get() as { n: number };
  return row.n > 0;
}

/**
 * Record a chore as done on a civil date, or clear it.
 *
 * **Idempotent by the unique index**, which is what lets the caller be careless:
 * a wall that presses twice on a flaky network, or two screens pressed at once,
 * record one completion between them. That property is the reason RFC 008 phase
 * 3 needs no client-side reconciliation and no queue.
 *
 * The date is the day the tick *counts for*; `completed_at` is when somebody
 * pressed it. They differ whenever the two matter — a chore ticked at 23:50
 * belongs to that day, not to the one starting in ten minutes.
 */
export function setChoreDone(
  db: SqliteDatabase,
  choreId: string,
  date: CivilDate,
  done: boolean,
  at: number = Date.now(),
): void {
  if (!done) {
    db.prepare('DELETE FROM chore_completions WHERE chore_id = ? AND date = ?').run(choreId, date);
    return;
  }
  db.prepare(
    `INSERT INTO chore_completions (id, chore_id, date, completed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (chore_id, date) DO NOTHING`,
  ).run(randomBytes(8).toString('hex'), choreId, date, at);
}

/**
 * Today, as a civil date in the household's zone.
 *
 * `en-CA` yields `YYYY-MM-DD`, which is the same trick the weather module and
 * the e-paper viewmodel use. The `try` is not defensive padding: `timezone` is
 * a column somebody typed into the wizard, and `Intl` throws on a zone it does
 * not know — which would take out the page rather than the setting.
 */
export function localToday(timezone: string, now: number = Date.now()): CivilDate {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(now);
  }
}
