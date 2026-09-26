import { describe, expect, it } from 'vitest';

import { calendarsOf, countBySource, keepCalendars } from '../src/calendar-filter.js';

/*
 * The month's "Which calendars" (plan item P5.4, part 5): one reading, applied
 * by the wall's month and — transcribed — by a panel following it. The parity
 * of the two files is `calendar-filter-parity.test.ts`; this is the reading.
 */

const events = [
  { id: 'a', sourceId: 'family' },
  { id: 'b', sourceId: 'work' },
  { id: 'c', sourceId: 'school' },
  { id: 'd', sourceId: 'work' },
];

function cell(list = events, total = list.length) {
  return { date: '2026-09-26', eventCount: total, sourceCounts: countBySource(list), events: list };
}

describe('which calendars a calendar widget draws', () => {
  it('reads a selection of source ids, and anything else as every calendar', () => {
    expect(calendarsOf({ calendars: ['family', 'school'] })).toEqual(['family', 'school']);
    expect(calendarsOf({})).toEqual([]);
    expect(calendarsOf(undefined)).toEqual([]);
    expect(calendarsOf({ calendars: 'family' })).toEqual([]);
    expect(calendarsOf({ calendars: ['family', 7] })).toEqual(['family']);
  });

  it('hands back the very cell when nothing is picked, so an unfiltered month cannot move', () => {
    const original = cell();
    expect(keepCalendars(original, [])).toBe(original);
  });

  it('keeps only the chosen calendars, and counts only theirs', () => {
    const kept = keepCalendars(cell(), ['work']);
    expect(kept.events.map((event) => event.id)).toEqual(['b', 'd']);
    expect(kept.eventCount).toBe(2);
    expect(kept.date).toBe('2026-09-26');
  });

  it('counts from the per-calendar totals, not from a capped list', () => {
    // Twenty events on the work calendar and a list the model cut at two: a
    // "+N" must still be able to say eighteen.
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `w${index}`, sourceId: 'work' }));
    const capped = { ...cell(many), events: many.slice(0, 2) };
    expect(keepCalendars(capped, ['work']).eventCount).toBe(20);
    expect(keepCalendars(capped, ['family']).eventCount).toBe(0);
  });

  it('counts a calendar named twice once', () => {
    expect(keepCalendars(cell(), ['work', 'work']).eventCount).toBe(2);
  });
});
