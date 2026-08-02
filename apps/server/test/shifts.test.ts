import { describe, expect, it } from 'vitest';
import {
  cycleFrom,
  planFrom,
  previewFor,
  previewSummary,
  SLOT_OFF,
  SLOT_UNUSED,
  type Draft,
} from '../src/http/shifts.js';
import { DEFAULT_SHIFT_TYPES } from '@maverick-wall/core';

/**
 * The rotation editor's thinking, tested against documents.
 *
 * The four-week preview is the whole reason this screen exists — nobody can
 * verify a rota by reading back a cycle string; they verify it by looking at
 * four weeks and recognising their own life. So the preview has to be right,
 * and it has to come from the same resolver the wall uses.
 */

const TYPES = [...DEFAULT_SHIFT_TYPES];

const draft = (over: Partial<Draft> = {}): Draft => ({
  personId: 'p1',
  kind: 'pattern',
  sourceId: '',
  anchorDate: '2026-08-03',
  slots: Array.from({ length: 14 }, () => SLOT_UNUSED),
  titleMap: [],
  ...over,
});

const slots = (...values: string[]): string[] => {
  const all = Array.from({ length: 14 }, () => SLOT_UNUSED);
  values.forEach((value, index) => { all[index] = value; });
  return all;
};

describe('reading a cycle from the slot dropdowns', () => {
  it('stops at the last day that says something', () => {
    expect(cycleFrom(slots('day', 'day', SLOT_OFF))).toEqual(['day', 'day', null]);
  });

  it('calls a gap a mistake rather than a shorter cycle', () => {
    // Somebody cleared the wrong row. Silently accepting it would shift the
    // whole rota by a day and look like the resolver was broken.
    const result = cycleFrom(slots('day', SLOT_UNUSED, 'night'));
    expect(result).toHaveProperty('message', 'The cycle has a gap in it.');
  });

  it('refuses an empty cycle', () => {
    expect(cycleFrom(slots())).toHaveProperty('message');
  });

  it('keeps a rest day, which is not the same as an unused slot', () => {
    expect(cycleFrom(slots(SLOT_OFF, 'day'))).toEqual([null, 'day']);
  });
});

describe('turning a draft into a plan', () => {
  it('needs a real anchor date', () => {
    const result = planFrom(draft({ anchorDate: 'soon', slots: slots('day') }), 'x');
    expect(result).toHaveProperty('message');
  });

  it('builds a pattern plan', () => {
    const plan = planFrom(draft({ slots: slots('day', 'day', 'night', SLOT_OFF) }), 'x');
    expect(plan).toMatchObject({ kind: 'pattern', anchorDate: '2026-08-03' });
    expect((plan as { cycle: unknown }).cycle).toEqual(['day', 'day', 'night', null]);
  });

  it('matches tagged titles exactly, not by substring', () => {
    // These were picked from a list of what is genuinely in the feed, so a
    // substring test could quietly also match something never looked at.
    const plan = planFrom(
      draft({
        kind: 'calendar',
        sourceId: 's1',
        titleMap: [
          { title: 'Daddy - Working Day Shift', key: 'day' },
          { title: 'Break Day', key: SLOT_OFF },
          { title: 'Swimming', key: '' },
        ],
      }),
      'x',
    );
    expect((plan as unknown as { matchers: unknown[] }).matchers).toEqual([
      { shiftTypeKey: 'day', pattern: 'Daddy - Working Day Shift', matchMode: 'exact' },
      { shiftTypeKey: null, pattern: 'Break Day', matchMode: 'exact' },
    ]);
  });

  it('refuses a calendar plan with nothing tagged', () => {
    const plan = planFrom(
      draft({ kind: 'calendar', sourceId: 's1', titleMap: [{ title: 'Swimming', key: '' }] }),
      'x',
    );
    expect(plan).toHaveProperty('message');
  });
});

describe('the four-week preview', () => {
  const patternPlan = planFrom(
    draft({ slots: slots('day', 'day', 'night', 'night', SLOT_OFF, SLOT_OFF) }),
    'x',
  ) as never;

  it('runs the cycle out over four weeks from the anchor', () => {
    const days = previewFor(patternPlan, '2026-08-03', TYPES, new Map(), 'Europe/London');
    expect(days).toHaveLength(28);
    expect(days.slice(0, 6).map((day) => day.shortCode)).toEqual(['D', 'D', 'M', 'M', 'B', 'B']);
    // Six-day cycle, so day seven is day one again.
    expect(days[6]?.shortCode).toBe('D');
  });

  it('marks a rest day differently from a day the rota says nothing about', () => {
    const days = previewFor(patternPlan, '2026-08-03', TYPES, new Map(), 'Europe/London');
    const off = days.find((day) => day.shortCode === 'B');
    expect(off?.isWorking).toBe(false);
    expect(off?.unknown).toBe(false);
  });

  it('resolves a calendar plan against the titles actually in the feed', () => {
    const plan = planFrom(
      draft({
        kind: 'calendar',
        sourceId: 's1',
        titleMap: [
          { title: 'Working Day Shift', key: 'day' },
          { title: 'Break Day', key: SLOT_OFF },
        ],
      }),
      'x',
    ) as never;

    const titles = new Map<string, string[]>([
      ['2026-08-03', ['Working Day Shift']],
      ['2026-08-04', ['Break Day']],
      ['2026-08-05', ['Dentist']],
    ]);
    const days = previewFor(plan, '2026-08-03', TYPES, titles, 'Europe/London');

    expect(days[0]?.shortCode).toBe('D');
    expect(days[1]?.label).toBe('Off');
    // A day whose only event is an appointment is not a shift day.
    expect(days[2]?.unknown).toBe(true);
  });

  it('says plainly when nothing resolved at all', () => {
    const plan = planFrom(
      draft({ kind: 'calendar', sourceId: 's1', titleMap: [{ title: 'Nope', key: 'day' }] }),
      'x',
    ) as never;
    const days = previewFor(plan, '2026-08-03', TYPES, new Map(), 'Europe/London');
    expect(previewSummary(days)).toContain('Nothing resolved');
  });

  it('counts the working days so the summary can be checked at a glance', () => {
    const days = previewFor(patternPlan, '2026-08-03', TYPES, new Map(), 'Europe/London');
    // Four working in every six: 28 days is four whole cycles (16) plus four
    // more days at positions D, D, M, M.
    expect(previewSummary(days)).toContain('20 working days');
  });
});
