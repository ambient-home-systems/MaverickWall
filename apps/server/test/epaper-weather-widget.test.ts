import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The weather and clock widgets on a panel.
 *
 * The weather half exists because of a bug found by rendering one and looking
 * at it. `drawPanel`'s tolerant reader hunts for an `items`/`readings` array
 * and, failing that, prints every scalar field on the object. The weather panel
 * has neither — it carries `days` — so a household who put Weather on a panel
 * got exactly two lines:
 *
 *     provider: nws
 *     fetchedAt: 1787654321000
 *
 * Internals, and not one temperature. Every structural test passed over it: the
 * widget drew inside its box, it did not throw, and it produced ink.
 *
 * So the first assertion here is about *content*, not shape — the frame has to
 * depend on the forecast and must not depend on the timestamp. The rest follow
 * the equivalence idiom of `epaper-calendar-widget.test.ts`: the three-day
 * frame is the frame of a three-day forecast, the no-low frame is the frame of
 * a forecast with no lows in it.
 */

const PANEL = { width: 520, height: 240 } as const;
const TODAY = '2026-08-22';

interface Day {
  name: string;
  date?: string;
  high: number | null;
  low: number | null;
  unit: string;
  icon: string;
  summary: string;
}

const day = (name: string, high: number, low: number): Day => ({
  name,
  high,
  low,
  unit: 'C',
  icon: '☀',
  summary: 'Sunny',
});

const FIVE = [
  day('Today', 24, 13),
  day('Sat', 21, 12),
  day('Sun', 19, 11),
  day('Mon', 22, 14),
  day('Tue', 25, 15),
];

function manifestOf(
  days: readonly Day[],
  over: Record<string, unknown> = {},
): Manifest {
  const calendar: ManifestDay[] = [
    { date: TODAY, shifts: [], events: [] } as unknown as ManifestDay,
  ];
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: calendar,
    panels: {
      weather: { provider: 'nws', fetchedAt: 1787654321000, note: null, days, ...over },
    },
  } as unknown as Manifest;
}

function frameOf(
  manifest: Manifest,
  config: Record<string, unknown>,
  type = 'weather',
  box: Partial<PlacedEpaperWidget> = {},
): Framebuffer {
  const widget: PlacedEpaperWidget = {
    type,
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    z: 0,
    config,
    ...box,
  } as PlacedEpaperWidget;
  return renderFreeformEpaper(buildEpaperModel(manifest), manifest, [widget], PANEL);
}

const bitsOf = (fb: Framebuffer): number[] => {
  const out: number[] = [];
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) out.push(fb.get(x, y) ? 1 : 0);
  }
  return out;
};

describe('the weather widget on a panel', () => {
  it('draws the forecast, not the fields around it', () => {
    /*
     * The bug, stated as the two things that have to be true of the frame: it
     * changes when a temperature changes, and it does not change when the
     * fetch timestamp does. The old draw had both backwards — it printed the
     * timestamp and never read a single day.
     */
    const base = bitsOf(frameOf(manifestOf(FIVE), {}));

    const warmer = FIVE.map((d, i) => (i === 0 ? { ...d, high: 31 } : d));
    expect(bitsOf(frameOf(manifestOf(warmer), {}))).not.toEqual(base);

    const later = manifestOf(FIVE, { fetchedAt: 1799999999999, provider: 'openmeteo' });
    expect(bitsOf(frameOf(later, {}))).toEqual(base);
  });

  it('says so plainly when there is no forecast yet', () => {
    expect(bitsOf(frameOf(manifestOf([]), {}))).not.toEqual(bitsOf(frameOf(manifestOf(FIVE), {})));
    // And a panel object of the wrong shape entirely is the same "not yet",
    // never a crash and never a line of internals.
    const wrong = { ...manifestOf(FIVE) } as unknown as { panels: Record<string, unknown> };
    wrong.panels = { weather: { provider: 'nws', fetchedAt: 1 } };
    expect(bitsOf(frameOf(wrong as unknown as Manifest, {}))).toEqual(
      bitsOf(frameOf(manifestOf([]), {})),
    );
  });

  it('draws the number of days the household asked for', () => {
    // The equivalence: three days of a five-day forecast is the frame of a
    // three-day forecast. A renderer ignoring `count` fails this rather than
    // merely differing from the default.
    const three = frameOf(manifestOf(FIVE), { count: 3 });
    expect(bitsOf(three)).toEqual(bitsOf(frameOf(manifestOf(FIVE.slice(0, 3)), {})));
    expect(bitsOf(three)).not.toEqual(bitsOf(frameOf(manifestOf(FIVE), {})));
  });

  it('asks for more days than the forecast has without changing anything', () => {
    expect(bitsOf(frameOf(manifestOf(FIVE), { count: 10 }))).toEqual(
      bitsOf(frameOf(manifestOf(FIVE), {})),
    );
  });

  it('drops the overnight low when asked', () => {
    const noLow = frameOf(manifestOf(FIVE), { showLow: false });
    expect(bitsOf(noLow)).not.toEqual(bitsOf(frameOf(manifestOf(FIVE), {})));
    // Turning it off leaves the highs exactly where they were: the frame still
    // depends on a high, so this is not "drew less of everything".
    const warmer = FIVE.map((d, i) => (i === 0 ? { ...d, high: 31 } : d));
    expect(bitsOf(frameOf(manifestOf(warmer), { showLow: false }))).not.toEqual(bitsOf(noLow));
  });

  it('gives up the ladder from the bottom as the column gets shorter', () => {
    /*
     * The forecast's ladder applies inside each day's column, so a short strip
     * gives up the same row in every column. Asserted by equivalence: the short
     * frame is the frame of a ladder that was that short to begin with.
     */
    const tall = frameOf(manifestOf(FIVE), {});
    const short = frameOf(manifestOf(FIVE), {}, 'weather', { h: 0.28 });
    expect(bitsOf(short)).not.toEqual(bitsOf(tall));
    expect(bitsOf(short)).toEqual(
      bitsOf(frameOf(manifestOf(FIVE), { fields: ['name', 'high'] }, 'weather', { h: 0.28 })),
    );
  });

  it('draws the rows in the household’s order', () => {
    // Reordering is not the same frame drawn differently — it is a different
    // frame, and the reverse of the default is not the default.
    expect(bitsOf(frameOf(manifestOf(FIVE), { fields: ['high', 'name'] }))).not.toEqual(
      bitsOf(frameOf(manifestOf(FIVE), { fields: ['name', 'high'] })),
    );
  });

  it('keeps the temperatures on one line only while they are adjacent', () => {
    // A range reads as one thing. Separated in the list, they separate on the
    // frame — so these two ladders, over the same days, cannot draw the same.
    const together = frameOf(manifestOf(FIVE), { fields: ['high', 'low', 'name'] });
    const apart = frameOf(manifestOf(FIVE), { fields: ['high', 'name', 'low'] });
    expect(bitsOf(together)).not.toEqual(bitsOf(apart));
  });

  it('is unchanged for a widget saved before the ladder existed', () => {
    // The compatibility that matters: a stored `showLow: false` resolves to the
    // same ladder, and so to the same frame, as writing the list out by hand.
    expect(bitsOf(frameOf(manifestOf(FIVE), { showLow: false }))).toEqual(
      bitsOf(frameOf(manifestOf(FIVE), { fields: ['name', 'icon', 'high'] })),
    );
  });

  it('changes nothing for the symbol, which a 1-bit font has no glyph for', () => {
    /*
     * `showIcon` is the wall's. The panel's font is 0x20–0x7E and a forecast
     * glyph is not in it, so there is no symbol here to hide. Pinned as
     * identical rather than left to be discovered on a panel that quietly
     * ignores a switch the editor offered.
     */
    expect(bitsOf(frameOf(manifestOf(FIVE), { showIcon: false }))).toEqual(
      bitsOf(frameOf(manifestOf(FIVE), {})),
    );
  });

  it('falls back to a line each when a column would be too narrow to read', () => {
    // Five days across a 520px panel is a 104px column; five days down a
    // quarter of it is not, and a strip of 26px columns is a smudge.
    const wide = frameOf(manifestOf(FIVE), {});
    const narrow = frameOf(manifestOf(FIVE), {}, 'weather', { w: 0.25 });
    expect(bitsOf(narrow)).not.toEqual(bitsOf(wide));
    // Still a forecast in the narrow box: it depends on a temperature.
    const warmer = FIVE.map((d, i) => (i === 0 ? { ...d, high: 31 } : d));
    expect(bitsOf(frameOf(manifestOf(warmer), {}, 'weather', { w: 0.25 }))).not.toEqual(
      bitsOf(narrow),
    );
  });
});

describe('the clock widget on a panel', () => {
  it('reads the time in the format the household asked for', () => {
    // 15:30 UTC. The household's setting is 24-hour, so following it and
    // asking for 24-hour are the same frame, and 12-hour is a different one.
    const follows = frameOf(manifestOf(FIVE), {}, 'clock');
    expect(bitsOf(frameOf(manifestOf(FIVE), { clockFormat: '24' }, 'clock'))).toEqual(
      bitsOf(follows),
    );
    expect(bitsOf(frameOf(manifestOf(FIVE), { clockFormat: '12' }, 'clock'))).not.toEqual(
      bitsOf(follows),
    );
  });

  it('drops the date when asked, and keeps the time where it was', () => {
    const dated = frameOf(manifestOf(FIVE), {}, 'clock');
    const bare = frameOf(manifestOf(FIVE), { showDate: false }, 'clock');
    expect(bitsOf(bare)).not.toEqual(bitsOf(dated));
    // The time is untouched: the top band of both frames is identical, so this
    // dropped the date rather than redrawing the whole widget smaller.
    const band = (fb: Framebuffer): number[] => {
      const out: number[] = [];
      for (let y = 0; y < 40; y++) for (let x = 0; x < PANEL.width; x++) out.push(fb.get(x, y) ? 1 : 0);
      return out;
    };
    expect(band(bare)).toEqual(band(dated));
  });
});
