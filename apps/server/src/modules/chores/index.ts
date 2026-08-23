import { addDays, type CivilDate } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import { activeOn, completionsBetween, localToday, readChores } from '../../api/chores.js';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * Chores on the wall (RFC 008 phase 2).
 *
 * A module rather than a wired-in feature like shifts, because this is exactly
 * the shape the registry describes: one block key, one slice of the manifest,
 * and a corner of the settings. Being a module buys three things for nothing —
 * `ready`, so a household with no chores never has an empty block; the per-
 * module `try/catch` in `collectPanels`, so a chore bug costs the chore panel
 * and never the calendar; and the sidebar entry it already has.
 *
 * **No job.** There is nothing to keep fresh: a chore is due on a day or it is
 * not, computed from a schedule and a civil date, and "done" is a row keyed on
 * that date. The obvious-looking midnight sweeper that clears yesterday's ticks
 * would be a job that destroys history, and it would misfire in the one hour a
 * year the clocks go back.
 *
 * **No `signals`, deliberately.** A chore that raises an interrupt is a wall
 * that nags — "the bins were not put out", over the whole screen — and
 * interrupts are reserved for a tornado warning and a garage door left open at
 * midnight. A wall that nags is a wall a household turns off. Easy to add
 * later; very hard to take back.
 *
 * **Read-only, in this phase.** The panel says what is due and what is done;
 * nothing here or on the wall records a completion. That is phase 3, and it
 * belongs behind the display token on the same path `/d/interrupts/dismiss`
 * already proved.
 */

export const CHORES_BLOCK = 'chores';

/**
 * How many days the panel carries: today and the six after it.
 *
 * A week, because the widest view is "this week" and a household's chore board
 * on a fridge is a week. Fixed rather than a setting — the *widget* decides how
 * much of it to draw, and a number in two places is a number that disagrees
 * with itself.
 */
const HORIZON_DAYS = 7;

export interface ChorePanelItem {
  readonly id: string;
  readonly name: string;
  /**
   * Whose chore it is, for the widget's "whose chores" filter.
   *
   * An id rather than the name it draws, because that is the key the Shift
   * widget's identical picker already uses and one meaning per config key is
   * the rule. It also survives a rename, which filtering by name does not.
   */
  readonly personId: string | null;
  /** Null when the chore belongs to the household rather than one person. */
  readonly person: string | null;
  /** That person's own colour — the one the wall already draws them in. */
  readonly color: string | null;
  readonly dueTime: string | null;
  readonly done: boolean;
}

export interface ChorePanelDay {
  readonly date: CivilDate;
  readonly items: readonly ChorePanelItem[];
}

export interface ChorePanel {
  /** The household's civil date this was built for. */
  readonly today: CivilDate;
  /** Today first, then the six days after it. Days with nothing due are kept. */
  readonly days: readonly ChorePanelDay[];
}

/**
 * The board: what is due on each of the next seven days, and what is done.
 *
 * Exported so the e-paper renderer and the tests can build the same thing the
 * manifest carries without going through the module registry.
 *
 * Days with nothing due are **kept**, not dropped. A caller that wants to skip
 * them can; a caller drawing a week grid needs the empty columns to line the
 * days up, and inventing them back from a sparse list is how two renderers
 * start disagreeing about which day is which.
 */
export function buildChoreBoard(db: SqliteDatabase, today: CivilDate): ChorePanel {
  const chores = readChores(db);
  const last = addDays(today, HORIZON_DAYS - 1);
  const done = completionsBetween(db, today, last);

  const days: ChorePanelDay[] = [];
  for (let offset = 0; offset < HORIZON_DAYS; offset++) {
    const date = addDays(today, offset);
    const items: ChorePanelItem[] = [];
    for (const chore of chores) {
      if (!activeOn(chore, date)) continue;
      items.push({
        id: chore.id,
        name: chore.name,
        personId: chore.personId,
        person: chore.personName,
        color: chore.personColor,
        dueTime: chore.dueTime,
        done: done.has(`${chore.id}|${date}`),
      });
    }
    days.push({ date, items });
  }
  return { today, days };
}

export const choresModule: PanelModule = {
  key: CHORES_BLOCK,
  label: 'Chores',

  /**
   * Nothing to say until there is a chore.
   *
   * The same argument as a weather panel with no location: an empty chore
   * board is a hole in the wall rather than a feature, and a household that has
   * not set any up should not have to remove a widget to stop seeing one.
   */
  ready(db: SqliteDatabase): boolean {
    // Active chores, not merely rows. A household who paused all of theirs over
    // the holidays asked for no chore board, and a block drawing "nothing due"
    // for a fortnight is the hole in the wall this gate exists to prevent.
    return readChores(db).some((chore) => !chore.paused);
  },

  contribute(context: ModuleContext): ChorePanel | null {
    /*
     * The day is resolved in the household's zone, here, once.
     *
     * A chore's day is a civil date — what the kitchen calendar says — so the
     * whole panel hangs off this one conversion and nothing downstream ever
     * sees an instant. Doing it per widget, or on the display, is how a wall in
     * one zone and a panel in another end up disagreeing about what Tuesday is.
     */
    const today = localToday(context.timezone, context.now);
    const board = buildChoreBoard(context.db, today);
    // Every day empty means a household whose chores all fall outside the week.
    // Nothing to draw is better said by drawing nothing than by an empty box.
    return board.days.some((day) => day.items.length > 0) ? board : null;
  },
};
