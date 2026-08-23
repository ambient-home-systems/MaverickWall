import { randomBytes } from 'node:crypto';

import { addDays, dueDatesBetween, dueOn, type ChoreSchedule, type CivilDate } from '@maverick-wall/core';

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
  /** Suspended, keeping its history. Never on a wall; still on this screen. */
  readonly paused: boolean;
  /** When it was created. A record must not count days before a chore existed. */
  readonly createdAt: number;
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
              c.due_time AS dueTime, c.paused, c.created_at AS createdAt,
              c.sort_order AS sortOrder,
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
        paused: record['paused'] === 1,
        createdAt: Number(record['createdAt'] ?? 0),
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

/**
 * Suspend a chore, or bring it back.
 *
 * Its own function and its own column rather than a field on `ChoreInput`,
 * because pausing is not editing: it is a button on the card, one POST, and it
 * must not require the household to open the editor and re-save a form whose
 * other fields they did not mean to touch.
 */
export function setChorePaused(db: SqliteDatabase, id: string, paused: boolean): void {
  db.prepare('UPDATE chores SET paused = ?, updated_at = ? WHERE id = ?').run(
    paused ? 1 : 0,
    Date.now(),
    id,
  );
}

/**
 * Whether this chore belongs on a wall on this day.
 *
 * One rule in one place, because three callers need it and they must agree: the
 * board the wall draws, the panel's frame, and the endpoint that records a tick.
 * A paused chore is not on any wall, so a tick for one could only have come from
 * something holding the display token rather than from a finger — and the
 * endpoint refuses it for the same reason it refuses a chore that is not due.
 */
export function activeOn(chore: ChoreRow, date: CivilDate): boolean {
  return !chore.paused && dueOn(chore.schedule, date);
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

/**
 * How far back a record looks for occurrences. A monthly chore needs months.
 */
const RECORD_LOOKBACK_DAYS = 400;
/** How many past occurrences a record is drawn from. */
const RECORD_OCCURRENCES = 7;

export interface ChoreRecord {
  /** Occurrences counted — never more than `RECORD_OCCURRENCES`. */
  readonly of: number;
  readonly done: number;
  /**
   * The weekday all of them fell on, when the schedule has exactly one.
   *
   * Present only so the sentence can say "the last 7 Tuesdays", which is how a
   * household says it; every other schedule gets "times", because "the last 7
   * Mondays and Thursdays" is not a thing anybody says.
   */
  readonly weekday: string | undefined;
}

const WEEKDAY_NAMES = [
  'Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays',
];

/**
 * How a chore has been going: done, out of the last few times it fell due.
 *
 * The question a household actually asks, and the reason completions are stored
 * per civil date rather than as a boolean that resets at midnight.
 *
 * Counted over **occurrences, not days**. "Done 6 of the last 7 Tuesdays" is
 * the sentence; "done 6 of 8 in the last four weeks" is a different and worse
 * one, because a weekly chore's denominator should be weeks and a monthly
 * chore's should be months. `dueDatesBetween` supplies the occurrences and this
 * takes the last few.
 *
 * **Today is excluded, deliberately.** The day is not over. Counting it would
 * mean every chore read one worse than it is from midnight until somebody got
 * to it, and a screen that tells a household they are behind at nine in the
 * morning is a screen they will stop believing.
 *
 * Written in phase 1, removed before it shipped because nothing could record a
 * completion then and the line would have structurally read zero — and restored
 * here, where it is finally true.
 */
export function recentRecord(
  db: SqliteDatabase,
  chore: ChoreRow,
  today: CivilDate,
  timezone: string,
): ChoreRecord | undefined {
  const yesterday = addDays(today, -1);
  /*
   * Never count a day before the chore existed.
   *
   * Without this, a chore created a minute ago reports "Done 0 of the last 7
   * times" — seven failures a household could not possibly have committed, on
   * the screen they just used to set it up. It reads as an accusation and it is
   * the first thing they would see. Found by writing the test that asserted the
   * zero, then reading the sentence out loud.
   */
  const born = localToday(timezone, chore.createdAt);
  const from = born > addDays(today, -RECORD_LOOKBACK_DAYS)
    ? born
    : addDays(today, -RECORD_LOOKBACK_DAYS);
  if (from > yesterday) return undefined;

  const past = dueDatesBetween(chore.schedule, from, yesterday);
  if (past.length === 0) return undefined;

  const window = past.slice(-RECORD_OCCURRENCES);
  const first = window[0] as CivilDate;
  const last = window[window.length - 1] as CivilDate;
  const completed = completionDates(db, chore.id, first, last);

  const weekday =
    chore.schedule.kind === 'weekdays' && chore.schedule.days.length === 1
      ? WEEKDAY_NAMES[chore.schedule.days[0] as number]
      : undefined;

  return {
    of: window.length,
    done: window.filter((date) => completed.has(date)).length,
    weekday,
  };
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
