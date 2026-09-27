import { describe, expect, it } from 'vitest';

import { scheduledSlot } from '../src/canvas-schedule.js';
import {
  firstOverlap,
  hoursOf,
  isBlankRule,
  scheduleForSave,
  scheduleProblem,
  scheduleSnapshot,
  whenLine,
} from '../src/layout-hours.js';

/**
 * The hours the editor's Layouts menu edits (RFC 014 §5.2), asked without a
 * browser. `browser-editor-slots.test.ts` drives the menu on a real wall;
 * this asks what it decides — what counts as unsaved, what each layout's line
 * says, what the save refuses and where two windows fight — at the edges a
 * click cannot reach cheaply.
 */

describe('what counts as unsaved', () => {
  it('ignores a row with no times, which is only somewhere to type them', () => {
    const saved = [{ slot: 'morning', from: '06:30', to: '08:30' }];
    const edited = [...saved, { slot: 'evening', from: '', to: '' }];
    expect(isBlankRule(edited[1] as never)).toBe(true);
    expect(scheduleSnapshot(edited)).toBe(scheduleSnapshot(saved));
  });

  it('counts one time typed as unsaved work, so the save bar lights and the save can say why', () => {
    const saved = [{ slot: 'morning', from: '06:30', to: '08:30' }];
    expect(scheduleSnapshot([...saved, { slot: 'evening', from: '18:00', to: '' }])).not.toBe(scheduleSnapshot(saved));
  });

  it('counts a change of order, because where two windows overlap the first one wins', () => {
    const a = { slot: 'morning', from: '06:30', to: '08:30' };
    const b = { slot: 'school', from: '07:00', to: '09:00' };
    expect(scheduleSnapshot([a, b])).not.toBe(scheduleSnapshot([b, a]));
  });

  it('posts the windows and nothing half-typed', () => {
    expect(
      scheduleForSave([
        { slot: 'morning', from: '06:30', to: '08:30' },
        { slot: 'evening', from: '', to: '' },
      ]),
    ).toEqual([{ slot: 'morning', from: '06:30', to: '08:30' }]);
  });
});

describe('the line under each layout', () => {
  it('says the everyday layout is shown all day until a timed one has hours', () => {
    expect(whenLine([], null)).toBe('Shown all day');
    expect(whenLine([{ slot: 'morning', from: '', to: '' }], null)).toBe('Shown all day');
    expect(whenLine([{ slot: 'morning', from: '06:30', to: '08:30' }], null)).toBe('Shown the rest of the time');
  });

  it('says a timed layout with no window is never shown', () => {
    expect(whenLine([], 'morning')).toBe('No hours yet, so never shown');
    expect(whenLine([{ slot: 'morning', from: '06:30', to: '' }], 'morning')).toBe('No hours yet, so never shown');
  });

  it('lists every window a layout has, and no other layout’s', () => {
    const rules = [
      { slot: 'school', from: '06:30', to: '08:30' },
      { slot: 'evening', from: '18:00', to: '21:00' },
      { slot: 'school', from: '15:00', to: '16:30' },
    ];
    expect(hoursOf(rules, 'school')).toEqual(['06:30–08:30', '15:00–16:30']);
    expect(whenLine(rules, 'school')).toBe('Shown 06:30–08:30 and 15:00–16:30');
  });
});

describe('what the save refuses before it posts', () => {
  it('passes rows that are windows or blank', () => {
    expect(
      scheduleProblem([
        { slot: 'morning', from: '06:30', to: '08:30' },
        { slot: 'evening', from: '', to: '' },
      ]),
    ).toBeUndefined();
  });

  it('names the layout with one time and not the other', () => {
    expect(scheduleProblem([{ slot: 'evening', from: '', to: '21:00' }])).toEqual({
      slot: 'evening',
      message: 'Give evening both times, or clear them. From 06:30 until 08:30 shows it every morning.',
    });
  });

  it('refuses a window of no length, which would never show', () => {
    expect(scheduleProblem([{ slot: 'evening', from: '18:00', to: '18:00' }])?.message).toBe(
      'evening starts and ends at 18:00, so it would never show. Make the two times different.',
    );
  });

  it('refuses something that is not a time', () => {
    expect(scheduleProblem([{ slot: 'evening', from: '6pm', to: '21:00' }])?.slot).toBe('evening');
  });

  it('lets a window run past midnight', () => {
    expect(scheduleProblem([{ slot: 'night', from: '22:00', to: '06:00' }])).toBeUndefined();
  });
});

describe('where two layouts fight over the same minutes', () => {
  it('finds none when the windows only touch', () => {
    expect(
      firstOverlap([
        { slot: 'morning', from: '06:30', to: '08:30' },
        { slot: 'school', from: '08:30', to: '09:00' },
      ]),
    ).toBeUndefined();
  });

  it('ignores one layout’s own windows overlapping each other', () => {
    expect(
      firstOverlap([
        { slot: 'morning', from: '06:30', to: '08:30' },
        { slot: 'morning', from: '07:00', to: '09:00' },
      ]),
    ).toBeUndefined();
  });

  it('says where the overlap starts and which layout the wall draws there — the wall’s own answer', () => {
    const rules = [
      { slot: 'school', from: '07:00', to: '09:00' },
      { slot: 'morning', from: '06:30', to: '08:30' },
    ];
    const overlap = firstOverlap(rules);
    expect(overlap).toEqual({ from: '07:00', slots: ['school', 'morning'], shows: 'school' });
    // The same answer the wall's own pick gives in the middle of it.
    expect(scheduledSlot(rules, '07:30')).toBe(overlap?.shows);
  });

  it('walks a night window back to where it starts, not to midnight', () => {
    const overlap = firstOverlap([
      { slot: 'night', from: '22:00', to: '06:00' },
      { slot: 'late', from: '23:00', to: '01:00' },
    ]);
    expect(overlap?.from).toBe('23:00');
    expect(overlap?.shows).toBe('night');
  });

  it('pays no attention to a half-typed row', () => {
    expect(
      firstOverlap([
        { slot: 'morning', from: '06:30', to: '08:30' },
        { slot: 'school', from: '07:00', to: '' },
      ]),
    ).toBeUndefined();
  });
});
