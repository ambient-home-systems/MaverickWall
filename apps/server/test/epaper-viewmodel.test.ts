import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { buildEpaperModel, EPAPER_TODAY_LIMIT } from '../src/epaper/viewmodel.js';

/**
 * The eInk viewmodel selects the right things from a real-shaped manifest.
 *
 * Synthetic manifest here, on purpose kept to the fields the viewmodel reads;
 * the whole-app path (a real manifest through the endpoint) is proven in the
 * endpoint test. 2026-08-13 is a Thursday, so the grid geometry is exact: the
 * Monday of that week is the 10th.
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

  it('is whole Monday-first weeks of the requested count', () => {
    expect(model.weeks).toHaveLength(5);
    for (const week of model.weeks) expect(week).toHaveLength(7);
    expect(model.weekdayLabels).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  it('starts on the Monday of the current week', () => {
    expect(model.weeks[0]![0]!.date).toBe('2026-08-10');
    expect(model.weeks[0]![0]!.day).toBe(10);
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
});

describe('the header', () => {
  it('localises the parts of today', () => {
    const model = buildEpaperModel(fakeManifest([]));
    expect(model.today).toBe('2026-08-13');
    expect(model.header).toEqual({ weekday: 'Thursday', day: '13', month: 'August', year: '2026' });
  });
});
