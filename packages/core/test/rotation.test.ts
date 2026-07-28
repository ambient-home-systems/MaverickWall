import { describe, expect, it } from 'vitest';
import {
  buildRotationCycle,
  DEFAULT_SHIFT_MATCHERS,
  countWorkingDays,
  isPayPeriodAligned,
  presetByKey,
  resolveShifts,
  ROTATION_PRESETS,
  type PatternPlan,
  type RotationBlock,
  type ShiftType,
} from '../src/domain/shift/index.js';
import { addDays, dayOfWeek } from '../src/time/civil.js';

// The Sunday that begins a Days fortnight in the real roster this was built
// against. A US federal pay period is fourteen days beginning on a Sunday.
const ANCHOR = '2026-09-06';

const TEN_WEEK: readonly RotationBlock[] = presetByKey('ten-week-federal')!.blocks;

const TYPES: ShiftType[] = [
  { key: 'day', label: 'Days', shortCode: 'D', colorToken: '--s-day', isWorking: true },
  { key: 'night', label: 'Mids', shortCode: 'M', colorToken: '--s-night', isWorking: true },
  { key: 'straight', label: 'Straights', shortCode: 'S', colorToken: '--s-straight', isWorking: true },
];

describe('the ten week rotation', () => {
  const cycle = buildRotationCycle({ blocks: TEN_WEEK, anchorDate: ANCHOR });

  it('anchors on a Sunday', () => {
    expect(dayOfWeek(ANCHOR)).toBe(0);
  });

  it('is seventy days, which is exactly five pay periods', () => {
    expect(cycle).toHaveLength(70);
    expect(isPayPeriodAligned(ANCHOR, cycle.length)).toBe(true);
  });

  it('rejects an anchor that breaks pay period alignment', () => {
    expect(isPayPeriodAligned('2026-01-05', 70)).toBe(false); // a Monday
    expect(isPayPeriodAligned(ANCHOR, 21)).toBe(false); // not a whole fortnight
  });

  it('marks fifty-six days, twenty-eight of them on shift', () => {
    // 7 worked in each of the four shift fortnights, plus all 14 straights.
    expect(countWorkingDays(cycle)).toBe(42);
    expect(cycle.filter((key) => key === 'straight')).toHaveLength(14);
    expect(cycle.filter((key) => key === 'day')).toHaveLength(14);
    expect(cycle.filter((key) => key === 'night')).toHaveLength(14);
  });

  it('runs Days three on, four off, four on, three off', () => {
    expect(cycle.slice(0, 14)).toEqual([
      'day', 'day', 'day', null, null, null, null,
      'day', 'day', 'day', 'day', null, null, null,
    ]);
  });

  it('runs the second Days fortnight as the exact complement of the first', () => {
    for (let position = 0; position < 14; position++) {
      expect(cycle[position] === null).toBe(cycle[position + 14] !== null);
    }
  });

  it('runs Mids on a different phasing to Days', () => {
    // Four on, three off, three on, four off. Not a mirror of the Days blocks —
    // assuming it was is the mistake the real roster corrected.
    expect(cycle.slice(56, 70)).toEqual([
      'night', 'night', 'night', 'night', null, null, null,
      'night', 'night', 'night', null, null, null, null,
    ]);
  });

  it('treats Straights as a status covering the whole fortnight', () => {
    // Not a work pattern. Every day of the fortnight carries it, weekends
    // included, because the person is off shift rather than off work.
    expect(cycle.slice(42, 56).every((key) => key === 'straight')).toBe(true);
  });

  it('places the blocks in the order the roster describes', () => {
    const firstWorked = (fortnight: number): string | null =>
      cycle.slice(fortnight * 14, fortnight * 14 + 14).find((key) => key !== null) ?? null;
    expect([firstWorked(0), firstWorked(1), firstWorked(2), firstWorked(3), firstWorked(4)]).toEqual([
      'day', 'day', 'night', 'straight', 'night',
    ]);
  });

  it('works weekends during shift blocks', () => {
    // The point of the half-week rotation: unlike a weekday job, shift blocks
    // land on Saturdays and Sundays. If none do, the pattern is wrong.
    const weekendWork = [...Array(42).keys()].filter((position) => {
      const day = dayOfWeek(addDays(ANCHOR, position));
      return (day === 0 || day === 6) && cycle[position] !== null;
    });
    expect(weekendWork.length).toBeGreaterThan(0);
  });
});

describe('rotation feeding the resolver', () => {
  const plan: PatternPlan = {
    kind: 'pattern',
    id: 'rota',
    name: 'Ten week rotation',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    priority: 0,
    anchorDate: ANCHOR,
    cycle: buildRotationCycle({ blocks: TEN_WEEK, anchorDate: ANCHOR }),
  };

  it('repeats every seventy days', () => {
    const shifts = resolveShifts({
      from: ANCHOR,
      to: addDays(ANCHOR, 209),
      plans: [plan],
      overrides: [],
      shiftTypes: TYPES,
    });
    for (let position = 0; position < 70; position++) {
      expect(shifts[position]?.shiftTypeKey).toBe(shifts[position + 70]?.shiftTypeKey);
      expect(shifts[position]?.shiftTypeKey).toBe(shifts[position + 140]?.shiftTypeKey);
    }
  });

  it('stays on Sunday restarts across a year, including both DST transitions', () => {
    // Doing this arithmetic in instant-space rather than civil-date space is
    // exactly how a rotation slides a day in March and back in November.
    const shifts = resolveShifts({
      from: ANCHOR,
      to: addDays(ANCHOR, 420),
      plans: [plan],
      overrides: [],
      shiftTypes: TYPES,
    });
    for (let position = 0; position < shifts.length; position += 70) {
      const shift = shifts[position];
      expect(shift).toBeTruthy();
      expect(dayOfWeek(shift!.date), `restart at ${shift!.date}`).toBe(0);
      expect(shift!.shiftTypeKey).toBe('day');
    }
  });

  it('supports a swapped shift on top of the rotation', () => {
    const shifts = resolveShifts({
      from: ANCHOR,
      to: addDays(ANCHOR, 6),
      plans: [plan],
      overrides: [{ date: addDays(ANCHOR, 4), shiftTypeKey: 'night', note: 'covering a mid' }],
      shiftTypes: TYPES,
    });
    // Position 4 is a rest day in the base rotation, so this is someone picking
    // up a mid on a day off.
    expect(shifts[4]?.shiftTypeKey).toBe('night');
    expect(shifts[4]?.source).toBe('override');
    // Neighbours are untouched: position 2 is the last working day of the
    // three-on stretch, position 3 the first rest day.
    expect(shifts[2]?.shiftTypeKey).toBe('day');
    expect(shifts[3]?.shiftTypeKey).toBe(null);
    expect(shifts[3]?.source).toBe('pattern');
  });
});

describe('presets', () => {
  it.each(ROTATION_PRESETS.map((preset) => preset.key))('%s builds to its stated length', (key) => {
    const preset = presetByKey(key)!;
    const cycle = buildRotationCycle({ blocks: preset.blocks, anchorDate: ANCHOR });
    expect(cycle).toHaveLength(preset.cycleDays);
  });

  it('Panama works seven days a fortnight', () => {
    const cycle = buildRotationCycle({ blocks: presetByKey('panama')!.blocks, anchorDate: ANCHOR });
    expect(countWorkingDays(cycle)).toBe(7);
    expect(cycle.slice(0, 7)).toEqual(['day', 'day', null, null, 'day', 'day', 'day']);
  });

  it('DuPont changes shift type inside its cycle and ends with seven days off', () => {
    // The reason blocks can state explicit cells: no single shift key plus
    // pattern can express a rotation that switches days and nights internally.
    const cycle = buildRotationCycle({ blocks: presetByKey('dupont')!.blocks, anchorDate: ANCHOR });
    expect(cycle).toHaveLength(28);
    expect(new Set(cycle.filter((key) => key !== null))).toEqual(new Set(['day', 'night']));
    expect(cycle.slice(21)).toEqual([null, null, null, null, null, null, null]);
  });

  it('every preset resolves without error', () => {
    for (const preset of ROTATION_PRESETS) {
      const plan: PatternPlan = {
        kind: 'pattern',
        id: preset.key,
        name: preset.name,
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        priority: 0,
        anchorDate: ANCHOR,
        cycle: buildRotationCycle({ blocks: preset.blocks, anchorDate: ANCHOR }),
      };
      const shifts = resolveShifts({
        from: ANCHOR,
        to: addDays(ANCHOR, 90),
        plans: [plan],
        overrides: [],
      });
      expect(shifts, preset.key).toHaveLength(91);
    }
  });
});

describe('other roster shapes', () => {
  it('handles a cycle that is not a whole number of weeks', () => {
    const cycle = buildRotationCycle({
      blocks: [{ shiftTypeKey: 'day', days: 8, pattern: 'four-four' }],
      anchorDate: ANCHOR,
    });
    expect(cycle).toHaveLength(8);
    expect(countWorkingDays(cycle)).toBe(4);
  });

  it('treats a rest block as rest regardless of its shift key', () => {
    const cycle = buildRotationCycle({
      blocks: [{ shiftTypeKey: 'day', weeks: 2, pattern: 'none' }],
      anchorDate: ANCHOR,
    });
    expect(cycle.every((key) => key === null)).toBe(true);
  });

  it('realigns weekday blocks when the anchor moves', () => {
    const wednesday = '2026-01-07';
    expect(dayOfWeek(wednesday)).toBe(3);
    const cycle = buildRotationCycle({
      blocks: [{ shiftTypeKey: 'straight', weeks: 2, pattern: 'weekdays' }],
      anchorDate: wednesday,
    });
    expect(countWorkingDays(cycle)).toBe(10);
    expect(cycle[0]).toBe('straight'); // Wednesday
    expect(cycle[3]).toBe(null); // Saturday
    expect(cycle[4]).toBe(null); // Sunday
    expect(cycle[5]).toBe('straight'); // Monday
  });
});

describe('calendar-derived shifts from real title formats', () => {
  // Every one of these is a title format seen in the calendar this was built
  // against. They are not tidy: the same feed writes both "Daddy - Working Day
  // Shift" and "Daddy Working - Day Shift", and annotates traded fortnights
  // with a "(shift swap)" suffix.
  const plan = {
    kind: 'calendar' as const,
    id: 'work',
    name: 'Work calendar',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    priority: 10,
    calendarSourceId: 'src',
    matchers: [...DEFAULT_SHIFT_MATCHERS],
  };

  const cases: [string, string | null][] = [
    ['Daddy - Working Day Shift', 'day'],
    ['Daddy Working - Day Shift', 'day'],
    ['Daddy - Working Night Shift', 'night'],
    ['Daddy - Break Day', null],
    ['Daddy - Straights (Not on shift)', 'straight'],
    ['Daddy - Break Day (shift swap)', null],
    ['Daddy - Night Shift (shift swap)', 'night'],
  ];

  it.each(cases)('%s resolves correctly', (title, expected) => {
    const shifts = resolveShifts({
      from: ANCHOR,
      to: ANCHOR,
      plans: [plan],
      overrides: [],
      titlesByDate: new Map([[ANCHOR, [title]]]),
    });
    expect(shifts[0]?.shiftTypeKey).toBe(expected);
    expect(shifts[0]?.source).toBe('calendar');
  });

  it('tests "break day" before any day-shift pattern', () => {
    // "Break Day" contains the word "day". If matcher order were reversed,
    // every rest day would resolve as a working day shift — a silent, total
    // inversion of the roster.
    const breakIndex = DEFAULT_SHIFT_MATCHERS.findIndex((m) => m.pattern === 'break day');
    const dayIndex = DEFAULT_SHIFT_MATCHERS.findIndex((m) => m.pattern === 'day shift');
    expect(breakIndex).toBeGreaterThanOrEqual(0);
    expect(dayIndex).toBeGreaterThan(breakIndex);
  });

  it('an explicit rest day from the calendar overrides a pattern plan', () => {
    const pattern = {
      kind: 'pattern' as const,
      id: 'rota',
      name: 'rota',
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
      priority: 0,
      anchorDate: ANCHOR,
      cycle: buildRotationCycle({ blocks: TEN_WEEK, anchorDate: ANCHOR }),
    };
    const shifts = resolveShifts({
      from: ANCHOR,
      to: ANCHOR,
      plans: [plan, pattern],
      overrides: [],
      titlesByDate: new Map([[ANCHOR, ['Daddy - Break Day']]]),
    });
    // The rotation says this is a working day; the calendar says otherwise and
    // wins, because a stated rest day is information rather than absence.
    expect(pattern.cycle[0]).toBe('day');
    expect(shifts[0]?.shiftTypeKey).toBe(null);
    expect(shifts[0]?.source).toBe('calendar');
  });
});
