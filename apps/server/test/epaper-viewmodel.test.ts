import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import {
  buildEpaperModel,
  EPAPER_AGENDA_LIMIT,
  EPAPER_CELL_TITLES_LIMIT,
} from '../src/epaper/viewmodel.js';

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
    expect(model.agendaTotal).toBe(3);
  });

  /**
   * The panel ceiling is gone, and the *total* is what travels instead.
   *
   * This used to assert `EPAPER_TODAY_LIMIT` — six rows, measured on a 7.5"
   * panel and then applied to every panel from 640×384 to 1872×1404, which drew
   * six rows on all of them and left half of the largest white. The cut happens
   * where the box is known now, so this file cannot know how many rows were
   * left out; it carries the day's own count and the renderer subtracts what it
   * drew. The household's density is still applied here, because "show me at
   * most eight things" is a request about the day rather than about the panel.
   */
  it('carries the household density and the day it was cut from', () => {
    const many = Array.from({ length: 9 }, (_, i) => event({ title: `E${i}`, startsAt: at(8 + i, 0) }));
    const model = buildEpaperModel(fakeManifest([day('2026-08-13', many)]));
    expect(model.agenda).toHaveLength(8); // `todayEvents`, the fixture's default
    expect(model.agendaTotal).toBe(9);
  });

  it('honours a lower household limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => event({ title: `E${i}`, startsAt: at(8 + i, 0) }));
    const model = buildEpaperModel(fakeManifest([day('2026-08-13', many)], { todayEvents: 2 }));
    expect(model.agenda).toHaveLength(2);
    expect(model.agendaTotal).toBe(5);
  });

  /**
   * …and the working set is still bounded, which is the half a box-derived cut
   * would otherwise lose: a household asking for a hundred on a 13.3" panel
   * must not have a hundred rows built for a box that holds seventeen.
   */
  it('stops at the working set when the household asks for more than a day has', () => {
    const many = Array.from({ length: 40 }, (_, i) => event({ title: `E${i}`, startsAt: at(1, i) }));
    const model = buildEpaperModel(fakeManifest([day('2026-08-13', many)], { todayEvents: 100 }));
    expect(model.agenda).toHaveLength(EPAPER_AGENDA_LIMIT);
    expect(model.agendaTotal).toBe(40);
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

  /**
   * A cell carries names for the largest cell any panel has, not for the
   * smallest.
   *
   * `EPAPER_CELL_TITLES` was four — what a 34px cell on a 7.5" panel could
   * show. A 235px cell on a 13.3" one has room for eight and was drawing four
   * and a "+9", because the model had thrown the other names away two layers
   * before anything knew how big the cell was. The renderer counts what fits;
   * this only bounds the working set.
   */
  it('carries a generous set of names per cell, for the renderer to cut', () => {
    const many = Array.from({ length: 20 }, (_, i) => event({ title: `E${i}`, startsAt: at(1, i) }));
    const busy = buildEpaperModel(fakeManifest([day('2026-08-13', many)]));
    const today = busy.weeks.flat().find((cell) => cell.isToday)!;
    expect(today.titles).toHaveLength(EPAPER_CELL_TITLES_LIMIT);
    // The count is the day's own, so a cell that draws eight still says "+12".
    expect(today.eventCount).toBe(20);
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
