import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { calendarsOf, countBySource, keepCalendars } from '../src/epaper/calendar-filter.js';

/**
 * The wall and the panel read a calendar widget's "Which calendars" one way,
 * and this proves it by reading both files (plan item P5.4, part 5).
 *
 * The month grid ignored the selection on both renderers while the compact
 * month on the wall read it — one stored value, two months. The cure this
 * project always takes is one reading, written twice because the display
 * bundle cannot be imported here, and held character-identical from the first
 * declaration on, the way `shift-style-parity.test.ts` holds the rota's.
 * **The wall is the spec.**
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_PATH = join(HERE, '..', '..', 'display', 'src', 'calendar-filter.ts');
const PANEL_PATH = join(HERE, '..', 'src', 'epaper', 'calendar-filter.ts');
const wall = readFileSync(WALL_PATH, 'utf8');
const panel = readFileSync(PANEL_PATH, 'utf8');

function transcribed(source: string, where: string): string {
  const marker = "/**\n * The calendars a widget's config names";
  const from = source.indexOf(marker);
  if (from < 0) throw new Error(`no transcription marker in ${where}`);
  return source.slice(from);
}

describe('the two copies of the calendar filter', () => {
  it('read a display file that says something, so a rename fails loudly', () => {
    expect(wall).toContain('export function keepCalendars');
    expect(wall).toContain('export function calendarsOf');
    expect(transcribed(wall, WALL_PATH).length).toBeGreaterThan(500);
  });

  it('are character-identical from the first declaration on', () => {
    expect(
      transcribed(panel, PANEL_PATH),
      "the panel's calendar-filter.ts has drifted from the wall's in apps/display/src/calendar-filter.ts — " +
        'the wall is the spec, so copy it back',
    ).toBe(transcribed(wall, WALL_PATH));
  });

  it('keeps the chosen calendars and counts them from the per-calendar totals', () => {
    const events = [
      { id: 'a', sourceId: 's1' },
      { id: 'b', sourceId: 's2' },
    ];
    const cell = { eventCount: 2, sourceCounts: countBySource(events), events };
    expect(keepCalendars(cell, [])).toBe(cell);
    expect(keepCalendars(cell, ['s2'])).toMatchObject({ eventCount: 1, events: [{ id: 'b' }] });
    expect(calendarsOf({ calendars: ['s1'] })).toEqual(['s1']);
  });
});
