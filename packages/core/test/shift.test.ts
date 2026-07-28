import { describe, expect, it } from 'vitest';
import {
  nextWorkingShift,
  resolveShifts,
  type CalendarPlan,
  type PatternPlan,
  type ShiftType,
} from '../src/domain/shift.js';

const TYPES: ShiftType[] = [
  { key: 'day', label: 'Day', shortCode: 'D', colorToken: '--s-day', isWorking: true },
  { key: 'night', label: 'Night', shortCode: 'N', colorToken: '--s-night', isWorking: true },
  { key: 'break', label: 'Break', shortCode: 'B', colorToken: '--s-break', isWorking: false },
];

/** A 10-week rotation: a week of days, a week of nights, a week off, repeating. */
function tenWeekCycle(): (string | null)[] {
  const cycle: (string | null)[] = [];
  for (let week = 0; week < 10; week++) {
    for (let day = 0; day < 7; day++) {
      cycle.push(week % 3 === 0 ? 'day' : week % 3 === 1 ? 'night' : null);
    }
  }
  return cycle;
}

const TEN_WEEK: PatternPlan = {
  kind: 'pattern',
  id: 'p1',
  name: '10 week rotation',
  effectiveFrom: '2020-01-01',
  effectiveTo: null,
  priority: 0,
  anchorDate: '2026-01-05',
  cycle: tenWeekCycle(),
};

describe('pattern rotation', () => {
  it('is seventy days long', () => {
    expect(TEN_WEEK.cycle).toHaveLength(70);
  });

  it('walks the cycle and wraps', () => {
    const shifts = resolveShifts({
      from: '2026-01-05',
      to: '2026-03-22',
      plans: [TEN_WEEK],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(shifts[0]?.shiftTypeKey).toBe('day');
    expect(shifts[7]?.shiftTypeKey).toBe('night');
    expect(shifts[14]?.shiftTypeKey).toBe(null);
    expect(shifts[70]?.shiftTypeKey).toBe('day');
    expect(shifts[0]?.source).toBe('pattern');
  });

  it('resolves dates before the anchor', () => {
    // Negative offsets need a true modulo. Plain % would return a negative
    // index and read off the end of the cycle array.
    const shifts = resolveShifts({
      from: '2025-12-29',
      to: '2026-01-04',
      plans: [TEN_WEEK],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(shifts[0]?.shiftTypeKey).toBe(TEN_WEEK.cycle[63]);
  });
});

describe('overrides', () => {
  it('a swap beats the pattern and leaves neighbours alone', () => {
    const shifts = resolveShifts({
      from: '2026-01-05',
      to: '2026-01-07',
      plans: [TEN_WEEK],
      overrides: [{ date: '2026-01-06', shiftTypeKey: 'night', note: 'swapped with Dave' }],
      shiftTypes: TYPES,
    });
    expect(shifts[1]?.shiftTypeKey).toBe('night');
    expect(shifts[1]?.source).toBe('override');
    expect(shifts[1]?.note).toBe('swapped with Dave');
    expect([shifts[0]?.shiftTypeKey, shifts[2]?.shiftTypeKey]).toEqual(['day', 'day']);
  });

  it('an explicit day off is distinct from an unknown day', () => {
    const shifts = resolveShifts({
      from: '2026-01-05',
      to: '2026-01-05',
      plans: [TEN_WEEK],
      overrides: [{ date: '2026-01-05', shiftTypeKey: null }],
      shiftTypes: TYPES,
    });
    // Both read as null, but the source distinguishes "not working" from
    // "no roster loaded", and the display should say different things.
    expect(shifts[0]?.shiftTypeKey).toBe(null);
    expect(shifts[0]?.source).toBe('override');
  });
});

describe('roster changes', () => {
  const oldPlan: PatternPlan = { ...TEN_WEEK, id: 'old', effectiveTo: '2026-02-01' };
  const newPlan: PatternPlan = {
    kind: 'pattern',
    id: 'new',
    name: 'new roster',
    effectiveFrom: '2026-02-02',
    effectiveTo: null,
    priority: 0,
    anchorDate: '2026-02-02',
    cycle: ['night', 'night', 'day', 'day', null, null, null],
  };

  it('hands over cleanly between adjacent plans', () => {
    const shifts = resolveShifts({
      from: '2026-02-01',
      to: '2026-02-04',
      plans: [oldPlan, newPlan],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(shifts[0]?.planId).toBe('old');
    expect(shifts[1]?.planId).toBe('new');
    expect(shifts[1]?.shiftTypeKey).toBe('night');
    expect(shifts[3]?.shiftTypeKey).toBe('day');
  });

  it('a pattern that ends leaves nothing behind', () => {
    const shifts = resolveShifts({
      from: '2026-02-01',
      to: '2026-02-03',
      plans: [oldPlan],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(shifts[1]?.shiftTypeKey).toBe(null);
    expect(shifts[1]?.source).toBe('none');
  });
});

describe('calendar-derived shifts', () => {
  const plan: CalendarPlan = {
    kind: 'calendar',
    id: 'c1',
    name: 'from work calendar',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    priority: 0,
    calendarSourceId: 'src1',
    matchers: [
      { shiftTypeKey: 'night', pattern: 'night shift', isRegex: false },
      { shiftTypeKey: 'day', pattern: '^D/S', isRegex: true },
    ],
  };

  const titles = new Map<string, string[]>([
    ['2026-01-06', ['Night Shift 1900-0700']],
    ['2026-01-07', ['D/S 0700-1900']],
    ['2026-01-08', ['Dentist']],
  ]);

  it('matches titles by substring and by regex, and beats the pattern', () => {
    const shifts = resolveShifts({
      from: '2026-01-06',
      to: '2026-01-08',
      plans: [TEN_WEEK, plan],
      overrides: [],
      titlesByDate: titles,
      shiftTypes: TYPES,
    });
    expect([shifts[0]?.shiftTypeKey, shifts[0]?.source]).toEqual(['night', 'calendar']);
    expect([shifts[1]?.shiftTypeKey, shifts[1]?.source]).toEqual(['day', 'calendar']);
    // An unrelated event must not consume the day.
    expect(shifts[2]?.source).toBe('pattern');
  });
});

describe('degradation', () => {
  const titles = new Map<string, string[]>([['2026-01-06', ['Night Shift']]]);

  it('a malformed regex falls through instead of throwing', () => {
    const broken: CalendarPlan = {
      kind: 'calendar',
      id: 'bad',
      name: 'broken',
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      priority: 10,
      calendarSourceId: 'src1',
      matchers: [{ shiftTypeKey: 'day', pattern: '[unclosed', isRegex: true }],
    };
    const shifts = resolveShifts({
      from: '2026-01-06',
      to: '2026-01-06',
      plans: [broken, TEN_WEEK],
      overrides: [],
      titlesByDate: titles,
      shiftTypes: TYPES,
    });
    expect(shifts[0]?.source).toBe('pattern');
  });

  it('an unknown shift key is ignored rather than rendered broken', () => {
    const shifts = resolveShifts({
      from: '2026-01-06',
      to: '2026-01-06',
      plans: [TEN_WEEK],
      overrides: [{ date: '2026-01-06', shiftTypeKey: 'nonexistent' }],
      shiftTypes: TYPES,
    });
    expect(shifts[0]?.source).toBe('pattern');
  });

  it('an empty cycle is skipped', () => {
    const shifts = resolveShifts({
      from: '2026-01-06',
      to: '2026-01-06',
      plans: [{ ...TEN_WEEK, id: 'empty', cycle: [] }],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(shifts[0]?.source).toBe('none');
  });

  it('covers every requested date even with no plans at all', () => {
    const shifts = resolveShifts({
      from: '2026-01-01',
      to: '2026-01-31',
      plans: [],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(shifts).toHaveLength(31);
    expect(shifts.every((shift) => shift.source === 'none')).toBe(true);
  });
});

describe('nextWorkingShift', () => {
  it('skips rest days', () => {
    const shifts = resolveShifts({
      from: '2026-01-19',
      to: '2026-02-10',
      plans: [TEN_WEEK],
      overrides: [],
      shiftTypes: TYPES,
    });
    const next = nextWorkingShift(shifts, TYPES, '2026-01-19');
    expect(next).toBeTruthy();
    expect(next?.shiftTypeKey).toBeTruthy();
  });

  it('returns nothing when the range holds no working days', () => {
    const restOnly: PatternPlan = { ...TEN_WEEK, id: 'rest', cycle: [null, null, null] };
    const shifts = resolveShifts({
      from: '2026-01-19',
      to: '2026-01-25',
      plans: [restOnly],
      overrides: [],
      shiftTypes: TYPES,
    });
    expect(nextWorkingShift(shifts, TYPES, '2026-01-19')).toBeUndefined();
  });
});
