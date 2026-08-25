import type { SqliteDatabase } from '../db/open.js';
import type { HouseholdSetUp } from '../api/manifest.js';
import { readyModuleKeys, type PanelModule } from './registry.js';
import { choresModule } from './chores/index.js';
import { weatherModule } from './weather/index.js';
import { haModule } from './homeassistant/index.js';
import { calendarModule } from './calendar/index.js';
import { externalPanelModules } from './external/index.js';

/**
 * Every first-party panel module, in one list.
 *
 * The manifest asks each for its slice, boot registers their jobs from the
 * same list, and the Display screen offers their blocks from it too — so
 * adding a module is one entry rather than three edits in three files.
 */
export const MODULES: readonly PanelModule[] = [
  weatherModule,
  haModule,
  calendarModule,
  choresModule,
];

/** First-party plus whatever the household has registered. */
export function allModules(db: SqliteDatabase): PanelModule[] {
  return [...MODULES, ...externalPanelModules(db)];
}

/**
 * What the household has actually set up, for deciding which widgets have
 * anything to say (RFC 009 Phase 2).
 *
 * One reader, because four surfaces answer this question — the manifest a wall
 * polls, the frame a panel puts on glass, the panel page's "what the panel
 * actually draws" preview, and the editor's "not on the wall" flag — and two of
 * them disagreeing is exactly the fault the omission exists to remove.
 *
 * `modules` is a parameter so a caller that already has the list can hand it
 * over rather than have `external_modules` re-read underneath it: the manifest
 * builder asks the *same* list what it has to say and what it is set up for,
 * and a second list built a microsecond later is a second answer waiting to
 * happen.
 */
export function householdSetUp(db: SqliteDatabase, modules = allModules(db)): HouseholdSetUp {
  const row = db
    .prepare(`SELECT shift_enabled AS shiftEnabled FROM household_settings WHERE id = 'singleton'`)
    .get() as { shiftEnabled: number } | undefined;
  return { modules: readyModuleKeys(modules, db), shift: row?.shiftEnabled === 1 };
}
