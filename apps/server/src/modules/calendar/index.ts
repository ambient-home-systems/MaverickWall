import type { Signal } from '@maverick-wall/core';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * The calendar, as a source of interrupts.
 *
 * This module exists to prove the abstraction rather than to add a feature,
 * and it earns its place by being *awkward* for the model: a calendar event has
 * no severity, no urgency, no state, no entity id and no dwell. It matches on
 * one thing nothing else uses — how long until it starts — and if the model had
 * been quietly shaped around weather alerts and door sensors, adding it would
 * have meant a third code path.
 *
 * It did not. `startsWithinSec` is one clause in `RuleMatch` and one branch in
 * `matches`, and everything after that — ordering, dismissal, re-assertion,
 * night mode, the renderer — is the same code the other two sources use. That
 * is the whole claim being tested, and it is why this is here rather than on a
 * list of things to build later.
 *
 * **No panel.** It contributes signals and nothing else, which is the case the
 * registry's optional `contribute` exists for: not everything that can
 * interrupt a wall wants a strip on it.
 */

export const CALENDAR_INTERRUPT_SOURCE = 'calendar';

/**
 * How far ahead to look.
 *
 * The rules decide how soon is soon — `startsWithinSec` is theirs to set — so
 * this only has to be wider than any rule anybody would write. Two hours is
 * generous and keeps the query to a handful of rows.
 */
const LOOKAHEAD_MS = 2 * 60 * 60_000;

interface UpcomingRow {
  readonly id: string;
  readonly title: string;
  readonly startsAt: number;
  readonly allDay: number;
  readonly sourceName: string;
}

export const calendarModule: PanelModule = {
  key: CALENDAR_INTERRUPT_SOURCE,
  label: 'Calendar reminders',

  // Never a block. The calendar is already the wall.
  ready(): boolean {
    return false;
  },

  contribute(): null {
    return null;
  },

  signals(context: ModuleContext): readonly Signal[] {
    const rows = context.db
      .prepare(
        `SELECT e.id, e.title, e.starts_at AS startsAt, e.all_day AS allDay,
                s.name AS sourceName
           FROM calendar_events_cache e
           JOIN calendar_sources s ON s.id = e.source_id
          WHERE s.visible = 1 AND s.enabled = 1
            AND e.all_day = 0
            AND e.starts_at > ? AND e.starts_at <= ?
          ORDER BY e.starts_at
          LIMIT 20`,
      )
      .all(context.now, context.now + LOOKAHEAD_MS) as UpcomingRow[];

    return rows.map((row) => ({
      source: 'calendar' as const,
      key: row.id,
      title: row.title,
      headline: `Starts soon · ${row.sourceName}`,
      startsAt: row.startsAt,
      /*
       * `since` is when the event entered the window rather than when it was
       * created, so a dwell on a calendar rule would mean "has been imminent
       * for this long" — which is the only reading that makes sense. Nothing
       * ships a calendar rule with a dwell, but leaving it undefined would
       * silently make any such rule never fire.
       */
      since: row.startsAt - LOOKAHEAD_MS,
      // An event that has started is no longer starting soon, and the rule's
      // own `startsWithinSec` already refuses it — this makes it true of the
      // signal as well, so a stale one cannot linger.
      expiresAt: row.startsAt,
    }));
  },
};

/**
 * The rule shipped for this source, off by default.
 *
 * Off because a household did not ask for it, and a calendar that starts
 * interrupting itself the moment somebody upgrades is a surprise rather than a
 * feature. It exists so that turning it on is one switch rather than a form.
 */
export const CALENDAR_REMINDER_RULE = {
  id: 'calendar-default-starting-soon',
  source: 'calendar' as const,
  name: 'Starting in ten minutes',
  enabled: false,
  match: { startsWithinSec: 600 },
  action: 'banner' as const,
  piercesNightMode: false,
  minDwellSec: 0,
  dismissible: true,
  priority: 30,
};
