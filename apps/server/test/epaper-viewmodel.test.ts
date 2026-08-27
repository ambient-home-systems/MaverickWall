import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { buildEpaperModel, EPAPER_TODAY_LIMIT } from '../src/epaper/viewmodel.js';

/**
 * The eInk viewmodel selects the right things from a real-shaped manifest.
 *
 * Synthetic manifest here, on purpose kept to the fields the viewmodel reads;
 * the whole-app path (a real manifest through the endpoint) is proven in the
 * endpoint test. 2026-08-13 is a Thursday, so the grid geometry is exact: the
 * Sunday of that week is the 9th (the default), the Monday the 10th.
 */

function event(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e',
    uid: 'e',
    title: 'Event',
    startsAt: 0,
    endsAt: 0,
    allDay: false,
    sourceId: 's',
    color: '#000',
    status: 'confirmed',
    continues: false,
    ...over,
  };
}

function day(date: string, events: ManifestEvent[]): ManifestDay {
  return { date, shifts: [], events };
}

function fakeManifest(days: ManifestDay[], display?: Partial<Manifest['display']>): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 12, 0, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, ...display },
    days,
  } as unknown as Manifest;
}

const at = (h: number, m: number): number => Date.UTC(2026, 7, 13, h, m, 0);

describe('agenda', () => {
  it('lists today all-day first, then by time, formatted in the zone', () => {
    const model = buildEpaperModel(
      fakeManifest([
        day('2026-08-13', [
          event({ title: 'Football', startsAt: at(14, 30) }),
          event({ title: 'Bin day', allDay: true }),
          event({ title: 'Dentist', startsAt: at(9, 0) }),
        ]),
      ]),
    );
    expect(model.agenda).toEqual([
      { time: '', title: 'Bin day', allDay: true },
      { time: '09:00', title: 'Dentist', allDay: false },
      { time: '14:30', title: 'Football', allDay: false },
    ]);
    expect(model.agendaOverflow).toBe(0);
  });

  it('caps at the panel ceiling and reports the overflow', () => {
    const many = Array.from({ length: 9 }, (_, i) => event({ title: `E${i}`, startsAt: at(8 + i, 0) }));
    const model = buildEpaperModel(fakeManifest([day('2026-08-13', many)]));
    expect(model.agenda).toHaveLength(EPAPER_TODAY_LIMIT);
    expect(model.agendaOverflow).toBe(9 - EPAPER_TODAY_LIMIT);
  });

  it('honours a lower household limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => event({ title: `E${i}`, startsAt: at(8 + i, 0) }));
    const model = buildEpaperModel(fakeManifest([day('2026-08-13', many)], { todayEvents: 2 }));
    expect(model.agenda).toHaveLength(2);
    expect(model.agendaOverflow).toBe(3);
  });
});

describe('the month grid', () => {
  const model = buildEpaperModel(
    fakeManifest([day('2026-08-13', [event({ title: 'x', startsAt: at(9, 0) })]), day('2026-08-14', [])]),
  );

  it('is whole Sunday-first weeks of the requested count by default', () => {
    expect(model.weeks).toHaveLength(5);
    for (const week of model.weeks) expect(week).toHaveLength(7);
    expect(model.weekdayLabels).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  });

  it('starts on the Sunday of the current week by default', () => {
    // 2026-08-13 is a Thursday; the Sunday of that week is the 9th.
    expect(model.weeks[0]![0]!.date).toBe('2026-08-09');
    expect(model.weeks[0]![0]!.day).toBe(9);
  });

  it('starts on Monday and rotates the labels when the household picks it', () => {
    const monday = buildEpaperModel(
      fakeManifest([day('2026-08-13', [])], { weekStart: 'monday' }),
    );
    expect(monday.weeks[0]![0]!.date).toBe('2026-08-10');
    expect(monday.weekdayLabels).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  it('marks exactly today and shades days by event count', () => {
    const cells = model.weeks.flat();
    const todays = cells.filter((c) => c.isToday);
    expect(todays).toHaveLength(1);
    expect(todays[0]!.date).toBe('2026-08-13');
    expect(todays[0]!.eventCount).toBe(1);
    // The day after (the 14th) has an entry but no events — different from a
    // day the manifest never mentions.
    const fourteenth = cells.find((c) => c.date === '2026-08-14')!;
    expect(fourteenth.inWindow).toBe(true);
    expect(fourteenth.eventCount).toBe(0);
  });

  /**
   * The panel has to reach the same answer the wall does.
   *
   * Two renderers reading one stored value and disagreeing is this project's
   * most repeated bug — `shifts[0]`, `display_mode`, `cellEvents` — and a panel
   * that follows a wall has to draw the wall's month, not a fuller one. The
   * server stamps the event and both viewmodels filter at the same seam.
   */
  it('leaves a calendar the household kept off the grid out of the cells', () => {
    const off = buildEpaperModel(
      fakeManifest([
        day('2026-08-13', [
          event({ title: 'Dentist', startsAt: at(9, 0) }),
          event({ title: 'Standup', startsAt: at(9, 30), sourceId: 'work', showInGrid: false }),
        ]),
      ]),
    );
    const today = off.weeks.flat().find((cell) => cell.isToday)!;
    expect(today.titles).toEqual(['Dentist']);
    // The count as well as the names: `drawMonthBox` shades a cell by it and
    // draws "+N" from it, so a cell claiming two and naming one would report a
    // meeting the household asked not to see.
    expect(today.eventCount).toBe(1);
    // And the panel's own lists keep it — the switch takes a calendar out of
    // the squares, not off the panel.
    expect(off.agenda.map((item) => item.title)).toEqual(['Dentist', 'Standup']);
    expect(off.upcoming.map((item) => item.title)).toEqual(['Dentist', 'Standup']);
  });
});

describe('the header', () => {
  it('localises the parts of today', () => {
    const model = buildEpaperModel(fakeManifest([]));
    expect(model.today).toBe('2026-08-13');
    expect(model.header).toEqual({ weekday: 'Thursday', day: '13', month: 'August', year: '2026' });
  });
});
