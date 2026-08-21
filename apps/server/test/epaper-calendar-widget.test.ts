import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The calendar widget answers the settings the designer offers.
 *
 * Every control on the panel's Calendar options used to do nothing: the editor
 * stores the default mode (`month`) as an *absence*, this renderer tested
 * `=== 'month'`, and so all three "Show as" values drew the same agenda. The
 * household's report was exactly that — "the calendar settings have no impact".
 *
 * These assertions are written so they cannot pass on a renderer that ignores
 * the config. "The frame differs" is never enough on its own — a frame differs
 * just as readily if a setting changes something unrelated — so each case is
 * pinned to an *equivalence* as well: the default equals an explicit month, a
 * filtered list equals the same list with the other calendar deleted, and a
 * setting with nothing to act on changes nothing at all.
 */

const PANEL = { width: 800, height: 480 } as const;
const TODAY = '2026-08-13';

function ev(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e', uid: 'e', title: 'Event', startsAt: 0, endsAt: 0, allDay: false,
    sourceId: 'home', color: '#000', status: 'confirmed', continues: false, ...over,
  };
}

function manifestOf(days: ManifestDay[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 12, 0, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
  } as unknown as Manifest;
}

/** One calendar widget filling the panel, with whatever config is under test. */
function frameOf(manifest: Manifest, config: Record<string, unknown>): Framebuffer {
  const widget: PlacedEpaperWidget = {
    type: 'calendar', x: 0, y: 0, w: 1, h: 1, z: 0, config,
  };
  return renderFreeformEpaper(buildEpaperModel(manifest), manifest, [widget], PANEL);
}

const bytesOf = (fb: Framebuffer): number[] => {
  const out: number[] = [];
  for (let y = 0; y < PANEL.height; y++) for (let x = 0; x < PANEL.width; x++) out.push(fb.get(x, y) ? 1 : 0);
  return out;
};

const inkOf = (fb: Framebuffer): number => bytesOf(fb).reduce((n, bit) => n + bit, 0);

/** A fortnight with events on several days, across two calendars. */
const busy: ManifestDay[] = [
  { date: TODAY, shifts: [], events: [
    ev({ id: '1', title: 'Bin day', allDay: true }),
    ev({ id: '2', title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9, 0) }),
    ev({ id: '3', title: 'Choir', sourceId: 'work', startsAt: Date.UTC(2026, 7, 13, 19, 0) }),
  ] },
  { date: '2026-08-14', shifts: [], events: [
    ev({ id: '4', title: 'Swimming', startsAt: Date.UTC(2026, 7, 14, 8, 0) }),
    ev({ id: '5', title: 'Standup', sourceId: 'work', startsAt: Date.UTC(2026, 7, 14, 9, 30) }),
  ] },
  { date: '2026-08-15', shifts: [], events: [ev({ id: '6', title: 'Market', allDay: true })] },
];

/** The same fortnight with the days present but nothing on them. */
const quiet: ManifestDay[] = busy.map((day) => ({ ...day, events: [] }));

describe('the calendar widget on a panel', () => {
  it('draws the month grid by default, because the editor stores month as an absence', () => {
    const manifest = manifestOf(busy);
    // The whole of the reported bug. `mode` is absent for the default, so a
    // renderer testing `=== 'month'` falls through to the list — which is what
    // every panel drew, whatever the household picked.
    expect(bytesOf(frameOf(manifest, {}))).toEqual(bytesOf(frameOf(manifest, { mode: 'month' })));
    expect(bytesOf(frameOf(manifest, {}))).not.toEqual(bytesOf(frameOf(manifest, { mode: 'list' })));
  });

  it('draws three different things for the three modes it offers', () => {
    const manifest = manifestOf(busy);
    const month = bytesOf(frameOf(manifest, { mode: 'month' }));
    const week = bytesOf(frameOf(manifest, { mode: 'week' }));
    const list = bytesOf(frameOf(manifest, { mode: 'list' }));
    expect(month).not.toEqual(week);
    expect(week).not.toEqual(list);
    expect(month).not.toEqual(list);
  });

  it('names the events in the cells when asked for pills, and only then', () => {
    const manifest = manifestOf(busy);
    const dots = frameOf(manifest, { mode: 'month' });
    const pills = frameOf(manifest, { mode: 'month', cellEvents: 'pills' });
    expect(bytesOf(pills)).not.toEqual(bytesOf(dots));

    // The proof that it *names* them rather than merely drawing differently:
    // two months with the same events on the same days under different titles.
    // Density shading depends only on the count, so under dots these are the
    // same frame; under pills they cannot be, because the words are on the wall.
    const renamed = manifestOf(
      busy.map((day) => ({ ...day, events: day.events.map((e) => ({ ...e, title: `Zzz ${e.id}` })) })),
    );
    expect(bytesOf(frameOf(renamed, { mode: 'month' }))).toEqual(bytesOf(dots));
    expect(bytesOf(frameOf(renamed, { mode: 'month', cellEvents: 'pills' }))).not.toEqual(bytesOf(pills));

    // …and the difference comes from the events rather than from a restyled
    // grid: with nothing on any day, the two settings draw the same frame.
    const empty = manifestOf(quiet);
    expect(bytesOf(frameOf(empty, { mode: 'month', cellEvents: 'pills' }))).toEqual(
      bytesOf(frameOf(empty, { mode: 'month' })),
    );
  });

  it("names today's events too, knocked out of the cell that is filled", () => {
    // Today's cell is drawn as solid ink so it can be found from a doorway.
    // Names drawn *in* ink on top of it are black on black: the one day a
    // household actually reads would be the only one with nothing on it.
    const onlyToday = manifestOf([
      { date: TODAY, shifts: [], events: [ev({ title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9, 0) })] },
    ]);
    const bare = manifestOf([{ date: TODAY, shifts: [], events: [] }]);
    expect(bytesOf(frameOf(onlyToday, { mode: 'month', cellEvents: 'pills' }))).not.toEqual(
      bytesOf(frameOf(bare, { mode: 'month', cellEvents: 'pills' })),
    );
    // Knocked out, not drawn: naming an event *removes* ink from the filled
    // cell. Drawn in ink the two frames would be identical, which is the bug.
    expect(inkOf(frameOf(onlyToday, { mode: 'month', cellEvents: 'pills' }))).toBeLessThan(
      inkOf(frameOf(bare, { mode: 'month', cellEvents: 'pills' })),
    );
  });

  it('shows the days after today, which is what "upcoming" promises', () => {
    // Nothing on today, something tomorrow. The panel used to draw *today's*
    // agenda here, so this frame was the empty-state message.
    const tomorrowOnly = manifestOf([
      { date: TODAY, shifts: [], events: [] },
      { date: '2026-08-14', shifts: [], events: [ev({ title: 'Swimming', startsAt: Date.UTC(2026, 7, 14, 8, 0) })] },
    ]);
    const nothing = manifestOf([
      { date: TODAY, shifts: [], events: [] },
      { date: '2026-08-14', shifts: [], events: [] },
    ]);
    expect(bytesOf(frameOf(tomorrowOnly, { mode: 'list' }))).not.toEqual(
      bytesOf(frameOf(nothing, { mode: 'list' })),
    );
  });

  it('keeps only the calendars ticked, exactly as if the others were not there', () => {
    const manifest = manifestOf(busy);
    const homeOnly = manifestOf(
      busy.map((day) => ({ ...day, events: day.events.filter((e) => e.sourceId === 'home') })),
    );
    // The equivalence is the assertion: filtering to `home` must draw the same
    // frame as a household that only has `home`. A renderer that ignored the
    // filter would draw the work events and fail here.
    expect(bytesOf(frameOf(manifest, { mode: 'list', calendars: ['home'] }))).toEqual(
      bytesOf(frameOf(homeOnly, { mode: 'list' })),
    );
    // And ticking nothing means all of them, not none of them (rule nine).
    expect(bytesOf(frameOf(manifest, { mode: 'list', calendars: [] }))).toEqual(
      bytesOf(frameOf(manifest, { mode: 'list' })),
    );
  });

  it('stops at the number of events the household asked for', () => {
    const manifest = manifestOf(busy);
    const one = frameOf(manifest, { mode: 'list', count: 1 });
    const many = frameOf(manifest, { mode: 'list', count: 20 });
    expect(bytesOf(one)).not.toEqual(bytesOf(many));
    expect(inkOf(one)).toBeLessThan(inkOf(many));
    // A count larger than there is to show is not a different frame from no
    // count at all — the cap is a ceiling, not a demand.
    expect(bytesOf(frameOf(manifest, { mode: 'list', count: 50 }))).toEqual(
      bytesOf(frameOf(manifest, { mode: 'list' })),
    );
  });

  it('reads a stranger\'s config without drawing something absurd', () => {
    const manifest = manifestOf(busy);
    // These are stored JSON, so they are a boundary. A number where a string
    // belongs, or a count of zero, must fall back rather than throw or blank.
    expect(() => frameOf(manifest, { mode: 42, calendars: 'home', count: 'lots' })).not.toThrow();
    expect(bytesOf(frameOf(manifest, { mode: 42, calendars: 'home', count: 'lots' }))).toEqual(
      bytesOf(frameOf(manifest, {})),
    );
    expect(() => frameOf(manifest, { mode: 'list', count: 0 })).not.toThrow();
    expect(() => frameOf(manifest, { mode: 'list', calendars: [7, null] })).not.toThrow();
  });
});
