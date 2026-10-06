import { randomBytes } from 'node:crypto';

import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * Timers (plan items M2.2 and M5.1): started from a phone, an automation or the
 * admin, drawn by a Timers widget on every wall that has one.
 *
 * **A timer is an end instant.** The manifest carries when it started and when
 * it ends, and the wall computes everything else from its corrected clock —
 * "4 min left", the last minute's seconds, "Done" — so a wall that loses the
 * server mid-countdown still finishes the countdown. That is also why nothing
 * here runs at the moment a timer ends: there is no job that fires, no push and
 * nothing to miss. The job below only tidies away timers that have been done
 * for long enough, and the manifest stops carrying them at the same moment by
 * the same arithmetic.
 */

export const TIMERS_BLOCK = 'timers';

/** Magic Frame shows at most four, and so do we: a fifth is a list, not a glance. */
export const MAX_TIMERS = 4;
/** Shortest and longest a timer may run. Ten seconds is a test; a day is the most anybody times. */
export const MIN_TIMER_MS = 10_000;
export const MAX_TIMER_MS = 24 * 60 * 60_000;
/**
 * How long a finished timer stays on the walls as "Done" unless somebody clears
 * it. Long enough to be seen by whoever walks in next; short enough that the
 * wall is not still saying it at teatime.
 */
export const DONE_SHOWN_MS = 30 * 60_000;
/** A label is a word or two: "Pasta", "Car park". */
export const MAX_LABEL = 40;

export interface TimerRow {
  readonly id: string;
  readonly label: string | null;
  readonly startedAt: number;
  readonly endsAt: number;
}

/** The shape of a timer's id, minted here and nowhere else. */
export const TIMER_ID = /^tm-[0-9a-f]{12}$/;

/** Every timer still on the walls at `now`, soonest to end first. */
export function readLiveTimers(db: SqliteDatabase, now: number): TimerRow[] {
  return db
    .prepare(
      `SELECT id, label, started_at AS startedAt, ends_at AS endsAt
         FROM timers WHERE ends_at + ? > ? ORDER BY ends_at, id`,
    )
    .all(DONE_SHOWN_MS, now) as TimerRow[];
}

/** Delete every timer that has been done for longer than `DONE_SHOWN_MS`. */
export function pruneTimers(db: SqliteDatabase, now: number): void {
  db.prepare('DELETE FROM timers WHERE ends_at + ? <= ?').run(DONE_SHOWN_MS, now);
}

export type StartResult =
  | { readonly ok: true; readonly timer: TimerRow }
  | { readonly ok: false; readonly message: string };

/**
 * Start a timer. The duration is checked here as well as at the boundary, since
 * the admin and the companion API both call this and a third caller later
 * should not have to remember the bounds.
 */
export function startTimer(
  db: SqliteDatabase,
  input: { readonly durationMs: number; readonly label: string | null },
  now: number,
): StartResult {
  if (!Number.isInteger(input.durationMs) || input.durationMs < MIN_TIMER_MS || input.durationMs > MAX_TIMER_MS) {
    return { ok: false, message: 'A timer runs for between ten seconds and a day.' };
  }
  pruneTimers(db, now);
  if (readLiveTimers(db, now).length >= MAX_TIMERS) {
    return {
      ok: false,
      message: `There are already ${MAX_TIMERS} timers on the walls. End or clear one first.`,
    };
  }
  const timer: TimerRow = {
    id: `tm-${randomBytes(6).toString('hex')}`,
    label: input.label,
    startedAt: now,
    endsAt: now + input.durationMs,
  };
  db.prepare('INSERT INTO timers (id, label, started_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
    timer.id,
    timer.label,
    timer.startedAt,
    timer.endsAt,
    now,
  );
  return { ok: true, timer };
}

/** Which timers an end or a clear means. */
export type TimerSelection =
  | { readonly id: string }
  | { readonly label: string }
  | { readonly all: true };

/**
 * End timers — from a phone or the admin, running or done. The label is matched
 * without case, because it is what a person says out loud; every timer with
 * that label ends, since two "Pasta" timers are one request to stop the pasta.
 * Answers how many it ended, so a caller that ended nothing can say so.
 */
export function endTimers(db: SqliteDatabase, selection: TimerSelection, now: number): number {
  pruneTimers(db, now);
  if ('all' in selection) return db.prepare('DELETE FROM timers').run().changes;
  if ('id' in selection) return db.prepare('DELETE FROM timers WHERE id = ?').run(selection.id).changes;
  const wanted = selection.label.trim().toLocaleLowerCase('en');
  const matching = readLiveTimers(db, now).filter(
    (timer) => (timer.label ?? '').trim().toLocaleLowerCase('en') === wanted,
  );
  for (const timer of matching) db.prepare('DELETE FROM timers WHERE id = ?').run(timer.id);
  return matching.length;
}

/**
 * Clear one timer from a wall (MD7). **Only a finished one**: a wall is
 * somewhere a sleeve brushes past, and a running timer cancelled by accident is
 * a burnt dinner nobody was warned about. Ending a running timer is the phone's
 * or the admin's to do. Clearing one already gone is not an error — two walls
 * pressed at once both mean the same thing.
 */
export function clearDoneTimer(
  db: SqliteDatabase,
  id: string,
  now: number,
): 'cleared' | 'gone' | 'running' {
  const row = db.prepare('SELECT ends_at AS endsAt FROM timers WHERE id = ?').get(id) as
    | { endsAt: number }
    | undefined;
  if (row === undefined || row.endsAt + DONE_SHOWN_MS <= now) return 'gone';
  if (row.endsAt > now) return 'running';
  db.prepare('DELETE FROM timers WHERE id = ?').run(id);
  return 'cleared';
}

export interface TimersPanel {
  readonly timers: readonly {
    readonly key: string;
    readonly label?: string;
    readonly startedAt: number;
    readonly endsAt: number;
  }[];
}

export const timersModule: PanelModule = {
  key: TIMERS_BLOCK,
  label: 'Timers',

  /**
   * Any row at all. `ready` is asked without a clock, so a timer done long ago
   * still counts until the job below deletes it — at most a minute — and the
   * panel it contributes in that minute is simply empty.
   */
  ready(db: SqliteDatabase): boolean {
    const row = db.prepare('SELECT count(*) AS n FROM timers').get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  },

  contribute(context: ModuleContext): TimersPanel {
    return {
      timers: readLiveTimers(context.db, context.now).map((timer) => ({
        key: timer.id,
        ...(timer.label === null ? {} : { label: timer.label }),
        startedAt: timer.startedAt,
        endsAt: timer.endsAt,
      })),
    };
  },

  job: {
    kind: 'timers-tidy',
    intervalMs: 60_000,
    async run(context: ModuleContext): Promise<void> {
      pruneTimers(context.db, context.now);
    },
  },
};
