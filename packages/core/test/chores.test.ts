import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  dueDatesBetween,
  dueOn,
  nextDueOn,
  type ChoreSchedule,
} from '../src/domain/chores/index.js';
import { dayOfWeek } from '../src/time/civil.js';

/**
 * The chore schedule model.
 *
 * Everything here is civil dates, which is the point: a chore's day is what the
 * kitchen calendar says, not an instant. The tests that matter most are the
 * ones about what happens either side of a boundary — the anchor of an
 * every-N-days chore, the 28th of a month, and a schedule this build cannot
 * read.
 */

// 2026-08-25 is a Tuesday. Every weekday assertion below is anchored to it
// rather than to a comment, so a wrong day fails rather than reads oddly.
const TUESDAY = '2026-08-25';
const WEDNESDAY = '2026-08-26';

describe('the fixture dates are the weekdays they claim to be', () => {
  it('anchors on a real Tuesday', () => {
    expect(dayOfWeek(TUESDAY)).toBe(2);
    expect(dayOfWeek(WEDNESDAY)).toBe(3);
  });
});

describe('daily', () => {
  it('is due every day', () => {
    expect(dueOn({ kind: 'daily' }, TUESDAY)).toBe(true);
    expect(dueOn({ kind: 'daily' }, WEDNESDAY)).toBe(true);
  });
});

describe('weekdays', () => {
  const bins: ChoreSchedule = { kind: 'weekdays', days: [2] };

  it('is due on its day and not the next', () => {
    expect(dueOn(bins, TUESDAY)).toBe(true);
    expect(dueOn(bins, WEDNESDAY)).toBe(false);
  });

  it('handles several days', () => {
    const weekend: ChoreSchedule = { kind: 'weekdays', days: [0, 6] };
    expect(dueOn(weekend, '2026-08-29')).toBe(true); // Saturday
    expect(dueOn(weekend, '2026-08-30')).toBe(true); // Sunday
    expect(dueOn(weekend, TUESDAY)).toBe(false);
  });

  it('with no days chosen is never due, rather than always', () => {
    // The form refuses this, but a row that predates the form must not turn
    // into a chore that appears every single day.
    expect(dueOn({ kind: 'weekdays', days: [] }, TUESDAY)).toBe(false);
  });
});

describe('every N days', () => {
  const everyThird: ChoreSchedule = { kind: 'everyNDays', n: 3, from: TUESDAY };

  it('is due on the anchor and every third day after it', () => {
    expect(dueOn(everyThird, TUESDAY)).toBe(true);
    expect(dueOn(everyThird, '2026-08-26')).toBe(false);
    expect(dueOn(everyThird, '2026-08-27')).toBe(false);
    expect(dueOn(everyThird, '2026-08-28')).toBe(true);
  });

  it('is not due before its anchor', () => {
    // The half of this that is easy to get wrong: `elapsed % n === 0` is
    // perfectly happy three days *before* the anchor. A household setting a
    // chore to start next Monday means it starts then.
    expect(dueOn(everyThird, '2026-08-22')).toBe(false); // -3 days
    expect(dueOn(everyThird, '2026-08-24')).toBe(false);
  });

  it('crosses a month end without counting the month', () => {
    const daily: ChoreSchedule = { kind: 'everyNDays', n: 2, from: '2026-08-30' };
    expect(dueOn(daily, '2026-09-01')).toBe(true);
    expect(dueOn(daily, '2026-08-31')).toBe(false);
  });

  it('crosses a leap day', () => {
    const alternating: ChoreSchedule = { kind: 'everyNDays', n: 2, from: '2028-02-27' };
    expect(dueOn(alternating, '2028-02-29')).toBe(true);
    expect(dueOn(alternating, '2028-03-02')).toBe(true);
    expect(dueOn(alternating, '2028-03-01')).toBe(false);
  });
});

describe('a day of the month', () => {
  it('is due on that date in every month', () => {
    const first: ChoreSchedule = { kind: 'monthlyDate', day: 1 };
    expect(dueOn(first, '2026-09-01')).toBe(true);
    expect(dueOn(first, '2026-10-01')).toBe(true);
    expect(dueOn(first, '2026-09-02')).toBe(false);
  });

  it('is due on the 28th of February like any other month', () => {
    const twentyEighth: ChoreSchedule = { kind: 'monthlyDate', day: 28 };
    expect(dueOn(twentyEighth, '2027-02-28')).toBe(true);
    expect(dueOn(twentyEighth, '2028-02-28')).toBe(true); // a leap year
  });

  it('refuses a day past 28 rather than clamping it', () => {
    // Clamping 31 to "the last day" would make one chore behave differently in
    // February from every other month, with nothing on the form to say which
    // the household asked for. A control that means the last day is a sixth
    // case, not a special value in this one.
    const impossible = { kind: 'monthlyDate', day: 31 } as ChoreSchedule;
    expect(dueOn(impossible, '2026-08-31')).toBe(false);
    expect(describeSchedule(impossible)).toBe('No schedule');
  });
});

describe('once', () => {
  it('is due on exactly its day', () => {
    const schedule: ChoreSchedule = { kind: 'once', date: TUESDAY };
    expect(dueOn(schedule, TUESDAY)).toBe(true);
    expect(dueOn(schedule, WEDNESDAY)).toBe(false);
  });
});

describe('a schedule this build cannot read', () => {
  /*
   * `dueOn` runs inside manifest assembly, which rule nine forbids from
   * failing. Every one of these is a column a rolled-back build could be
   * looking at, and the answer to all of them is "not due" rather than a
   * thrown wall.
   */
  it('answers not-due rather than throwing', () => {
    expect(dueOn(null, TUESDAY)).toBe(false);
    expect(dueOn(undefined, TUESDAY)).toBe(false);
    expect(dueOn({ kind: 'lunar' } as unknown as ChoreSchedule, TUESDAY)).toBe(false);
    expect(dueOn({ kind: 'everyNDays', n: 0, from: TUESDAY }, TUESDAY)).toBe(false);
    expect(dueOn({ kind: 'everyNDays', n: 3, from: 'not-a-date' }, TUESDAY)).toBe(false);
    expect(dueOn({ kind: 'weekdays', days: 2 } as unknown as ChoreSchedule, TUESDAY)).toBe(false);
  });

  it('answers not-due for a date that is not a date', () => {
    expect(dueOn({ kind: 'daily' }, '2026-02-30')).toBe(false);
    expect(dueOn({ kind: 'daily' }, 'today')).toBe(false);
  });
});

describe('dueDatesBetween', () => {
  it('lists the Tuesdays in a fortnight, inclusive at both ends', () => {
    const dates = dueDatesBetween({ kind: 'weekdays', days: [2] }, TUESDAY, '2026-09-08');
    expect(dates).toEqual([TUESDAY, '2026-09-01', '2026-09-08']);
  });

  it('is empty for a backwards range, and for one longer than it will walk', () => {
    expect(dueDatesBetween({ kind: 'daily' }, WEDNESDAY, TUESDAY)).toEqual([]);
    expect(dueDatesBetween({ kind: 'daily' }, '2026-01-01', '2030-01-01')).toEqual([]);
  });
});

describe('nextDueOn', () => {
  it('finds the next occurrence, counting today', () => {
    expect(nextDueOn({ kind: 'weekdays', days: [2] }, TUESDAY)).toBe(TUESDAY);
    expect(nextDueOn({ kind: 'weekdays', days: [2] }, WEDNESDAY)).toBe('2026-09-01');
  });

  it('gives up rather than searching forever', () => {
    // A one-off in the past has no next date, and neither has a schedule a
    // newer build wrote. "Nothing coming up" is a real answer.
    expect(nextDueOn({ kind: 'once', date: '2020-01-01' }, TUESDAY)).toBeUndefined();
    expect(nextDueOn({ kind: 'lunar' } as unknown as ChoreSchedule, TUESDAY)).toBeUndefined();
  });
});

describe('describeSchedule', () => {
  it('says each kind the way somebody would', () => {
    expect(describeSchedule({ kind: 'daily' })).toBe('Every day');
    expect(describeSchedule({ kind: 'weekdays', days: [2] })).toBe('Every Tuesday');
    expect(describeSchedule({ kind: 'weekdays', days: [1, 3, 5] })).toBe(
      'Every Monday, Wednesday and Friday',
    );
    expect(describeSchedule({ kind: 'everyNDays', n: 2, from: TUESDAY })).toBe('Every other day');
    expect(describeSchedule({ kind: 'everyNDays', n: 4, from: TUESDAY })).toBe('Every 4 days');
    expect(describeSchedule({ kind: 'monthlyDate', day: 1 })).toBe('The 1st of each month');
    expect(describeSchedule({ kind: 'monthlyDate', day: 2 })).toBe('The 2nd of each month');
    expect(describeSchedule({ kind: 'monthlyDate', day: 3 })).toBe('The 3rd of each month');
    expect(describeSchedule({ kind: 'monthlyDate', day: 11 })).toBe('The 11th of each month');
    expect(describeSchedule({ kind: 'once', date: TUESDAY })).toBe(`Once, on ${TUESDAY}`);
  });

  it('collapses every weekday to the sentence the daily case uses', () => {
    // Two schedules that mean the same thing must read the same way, or a
    // household reading the list sees a difference the wall will not draw.
    expect(describeSchedule({ kind: 'weekdays', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day');
    expect(describeSchedule({ kind: 'everyNDays', n: 1, from: TUESDAY })).toBe('Every day');
  });
});
