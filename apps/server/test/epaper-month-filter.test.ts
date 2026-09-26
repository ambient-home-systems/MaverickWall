import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * A panel's month grid honours the widget's "Which calendars" (plan item P5.4,
 * part 5), because the wall's month does now and a panel following a wall
 * must draw the same month.
 *
 * The assertion is the strongest one available for a filter: a frame drawn
 * with one calendar kept is **byte-identical** to the frame of a household
 * that never had the other calendar at all — the names, the counts, the
 * density marks and the bars all agree — and a frame with nothing picked is
 * byte-identical to today's. "The frame changed" would pass just as happily
 * on a filter that dropped the wrong calendar, or dropped the names and left
 * the counts.
 */

const PANEL = { width: 800, height: 480 } as const;

interface Ev {
  readonly id: string;
  readonly title: string;
  readonly sourceId: string;
  readonly allDay?: boolean;
  readonly continues?: boolean;
}

/** Three calendars across a fortnight, one of them busy enough to need a "+N". */
function events(date: string, day: number): Ev[] {
  const out: Ev[] = [];
  if (day % 2 === 0) out.push({ id: `f${day}`, title: 'Swimming', sourceId: 'family' });
  if (day % 3 === 0) out.push({ id: `s${day}`, title: 'Assembly', sourceId: 'school', allDay: true });
  for (let n = 0; n < (day % 4 === 0 ? 14 : 1); n++) {
    out.push({ id: `w${day}-${n}`, title: `Standup ${n}`, sourceId: 'work' });
  }
  // A week-long all-day event on the work calendar, which is a bar.
  if (day >= 24 && day <= 28) out.push({ id: 'conf', title: 'Conference', sourceId: 'work', allDay: true, continues: true });
  void date;
  return out;
}

function manifest(keep: (event: Ev) => boolean = () => true): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 21; d <= 31; d++) {
    const date = `2026-08-${d}`;
    days.push({
      date,
      shifts: [],
      events: events(date, d)
        .filter(keep)
        .map((event, index) => ({
          id: event.id,
          title: event.title,
          sourceId: event.sourceId,
          allDay: event.allDay === true,
          continues: event.continues === true,
          startsAt: Date.UTC(2026, 7, d, 8 + index),
          endsAt: Date.UTC(2026, 7, d, 9 + index),
          color: '#336699',
        })),
    } as unknown as ManifestDay);
  }
  return {
    manifestVersion: 1,
    appVersion: 'test',
    generatedAt: Date.UTC(2026, 7, 22, 10),
    timezone: 'UTC',
    theme: { active: 'panels' },
    window: { from: '2026-08-21', to: '2026-09-30' },
    days,
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'sunday' },
    people: [],
    sources: [],
    notices: [],
    interrupts: [],
  } as unknown as Manifest;
}

function bits(fb: Framebuffer): string {
  let out = '';
  for (let y = 0; y < PANEL.height; y++) for (let x = 0; x < PANEL.width; x++) out += fb.get(x, y) ? '1' : '0';
  return out;
}

function frame(config: Record<string, unknown>, m: Manifest = manifest()): string {
  const widget: PlacedEpaperWidget = { type: 'calendar', x: 0, y: 0, w: 1, h: 1, z: 0, config };
  return bits(renderFreeformEpaper(buildEpaperModel(m), m, [widget], PANEL));
}

describe('a panel month grid, filtered to some calendars', () => {
  for (const cellEvents of [undefined, 'dots'] as const) {
    const base = cellEvents === undefined ? {} : { cellEvents };
    const named = cellEvents === undefined ? 'names' : 'dots';

    it(`draws exactly the month of a household without the other calendars (${named})`, () => {
      const filtered = frame({ ...base, calendars: ['family', 'school'] });
      const without = frame(base, manifest((event) => event.sourceId !== 'work'));
      expect(filtered).toBe(without);
      expect(filtered, 'the filter must change something here, or the case proves nothing').not.toBe(frame(base));
    });

    it(`draws today’s month when nothing is picked (${named})`, () => {
      expect(frame({ ...base, calendars: [] })).toBe(frame(base));
    });
  }

  it('keeps a bar on the calendar that owns it and drops it from the one that does not', () => {
    const work = frame({ calendars: ['work'] });
    expect(work).toBe(frame({}, manifest((event) => event.sourceId === 'work')));
  });
});
