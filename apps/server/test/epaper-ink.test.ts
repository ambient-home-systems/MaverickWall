import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { inkOverrideBody, widgetConfigBody } from '../src/api/widget-schema.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { INK_KEYS, INK_LANE, PANEL_HONOURS, PANEL_IGNORES, withInk } from '../src/epaper/honours.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The ink lane (RFC 005, direction B): one canvas, two media.
 *
 * A widget carries the household's wall settings and, optionally, an `ink`
 * object saying what it does differently on a black-and-white panel following
 * the same canvas. Two things have to be true and neither is provable by
 * reading the source:
 *
 * 1. **The tables are facts about the renderer, not opinions about it.** The
 *    lane offers a subset of a widget's options because a panel reads a subset,
 *    and every entry in `PANEL_HONOURS` is checked here by *rendering* — set the
 *    key, decode the frame, see whether the ink moved. An entry that changes
 *    nothing is a control that does nothing, which this project has shipped
 *    before (`options.json`) and does not intend to again. `PANEL_IGNORES` is
 *    checked the same way in reverse: each of those keys must move no ink on any
 *    widget, or the sentence beside it in the editor is a lie.
 *
 * 2. **The lanes are one-way.** An override changes the panel and never the
 *    wall.
 *
 * The reverse direction of (1) is the one that would rot quietly: a key added to
 * the schema and read by a draw, but named in neither table, is an option the
 * lane can never offer and nobody would notice. Every key in `widgetConfigBody`
 * is accounted for below, derived from the schema itself rather than from a list
 * kept here — the same reason the ladder's parity test derives its sets from the
 * two files rather than from a third.
 */

const PANEL = { width: 520, height: 300 } as const;
const TODAY = '2026-08-22';

function manifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 22; d <= 27; d++) {
    days.push({
      date: `2026-08-${d}`,
      shifts: [
        {
          personId: 'p1', personName: 'Amy', label: 'Days', shortCode: 'D',
          startTime: '07:00', endTime: '19:00', isWorking: true, color: '#f00',
        },
        {
          personId: 'p2', personName: 'Ben', label: 'Nights', shortCode: 'N',
          startTime: '19:00', endTime: '07:00', isWorking: true, color: '#00f',
        },
      ],
      events: [
        {
          id: `e${d}`, uid: `e${d}`, title: `Dentist ${d}`, startsAt: Date.UTC(2026, 7, d, 9),
          endsAt: Date.UTC(2026, 7, d, 10), allDay: false, sourceId: 's1', color: '#000',
          status: 'confirmed', continues: false, location: 'Clinic',
        },
        {
          id: `f${d}`, uid: `f${d}`, title: `Swim ${d}`, startsAt: Date.UTC(2026, 7, d, 17),
          endsAt: Date.UTC(2026, 7, d, 18), allDay: false, sourceId: 's2', color: '#000',
          status: 'confirmed', continues: false,
        },
      ],
    } as unknown as ManifestDay);
  }
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [
      { id: 's1', name: 'Family', color: '#000' },
      { id: 's2', name: 'School', color: '#111' },
    ],
    panels: {
      weather: {
        days: [
          { name: 'Fri', high: 24, low: 13, icon: 'sun' },
          { name: 'Sat', high: 22, low: 12, icon: 'cloud' },
          { name: 'Sun', high: 20, low: 11, icon: 'rain' },
        ],
        provider: 'nws',
        fetchedAt: 1,
      },
      home: {
        readings: [
          { label: 'Front door', value: 'Locked', icon: 'lock', mode: 'label_value' },
          { label: 'Kitchen', value: '19.4 C', icon: 'therm', mode: 'label_value' },
          { label: 'Garage', value: 'Open', icon: 'garage', mode: 'label_value' },
        ],
        fetchedAt: 1,
      },
      mymod: { items: [{ label: 'Bins', value: 'Tuesday' }, { label: 'Tide', value: 'High' }] },
    },
  } as unknown as Manifest;
}

const M = manifest();
const MODEL = buildEpaperModel(M);

/** One widget, alone on a panel, as a string of bits — comparable and exact. */
function frame(type: string, config: Record<string, unknown>): string {
  const widget: PlacedEpaperWidget = { type, x: 0, y: 0, w: 1, h: 1, z: 0, config };
  const fb: Framebuffer = renderFreeformEpaper(MODEL, M, [widget], PANEL);
  let bits = '';
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) bits += fb.get(x, y) ? '1' : '0';
  }
  return bits;
}

/**
 * The starting configs each type is probed from.
 *
 * More than one where a key only means something in one shape — a calendar's
 * `count` is the agenda's length and says nothing about a month grid, so a
 * single month-mode base would have "proved" that `count` is not honoured.
 * Every base is also tried with a title, since `showTitle` cannot move anything
 * without one.
 */
const BASES: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  clock: [{}],
  calendar: [{ mode: 'month' }, { mode: 'list' }, { mode: 'week' }],
  shift: [{}],
  countdown: [{ target: '2026-12-25' }],
  notes: [{ text: 'Hello there wall' }],
  todo: [{ items: ['Milk', 'Bread'] }],
  weather: [{}],
  homeassistant: [{}],
  external: [{ module: 'mymod' }],
  image: [{ image: `${'a'.repeat(64)}.png` }],
};

/** Values that would visibly change a widget that reads the key at all. */
const PROBES: Readonly<Record<string, readonly unknown[]>> = {
  title: ['A different title'],
  showTitle: [false],
  align: ['center', 'right'],
  calendars: [['s1']],
  mode: ['list', 'week', 'month', 'skyweek'],
  /*
   * `compact` is the value that would move ink if a panel read density at all.
   * It must not: a panel is already edge to edge with hairline rules and has no
   * gaps, cards or padding to give up, so both densities draw one frame — which
   * is also what keeps a canvas storing `skymonth` drawing what it always did.
   * Probed against a month base *and* a week base, since those are the two
   * views density means anything on.
   */
  density: ['compact'],
  /*
   * Both directions, because the default moved. `cellEvents` unset means flat
   * names now, so probing `pills` alone compares names against names and finds
   * nothing — which is how a key that genuinely stopped being read would look.
   * `dots` is the value that changes the frame, and probing both keeps this
   * honest whichever way the default goes next.
   */
  cellEvents: ['dots', 'pills'],
  count: [1, 2],
  showWeather: [true],
  showWeekNumbers: [true],
  showShifts: [false],
  showTimes: [false],
  showLocations: [true],
  people: [['p1']],
  fields: [['shift'], ['value'], ['high'], ['label']],
  shiftName: ['code'],
  showFace: [false],
  showHours: [false],
  showRun: [false],
  clockFormat: ['12'],
  showDate: [false],
  showLow: [false],
  showIcon: [false],
  readings: [['Kitchen']],
  target: ['2027-01-01'],
  module: ['weather'],
  image: [`${'b'.repeat(64)}.png`],
  text: ['Different words entirely'],
  items: [['Cheese']],
  background: ['#ff0000'],
  opacity: [40],
  corners: ['rounded'],
  shadow: [true],
};

/** Does setting this key change what the panel draws for this widget type? */
function movesInk(type: string, key: string): boolean {
  const values = PROBES[key] ?? [];
  for (const base of BASES[type] ?? []) {
    for (const start of [base, { ...base, showTitle: true, title: 'Base' }]) {
      const before = frame(type, start);
      for (const value of values) {
        if (frame(type, { ...start, [key]: value }) !== before) return true;
      }
    }
  }
  return false;
}

const TYPES = Object.keys(BASES);
const IGNORED = new Set(PANEL_IGNORES.map((entry) => entry.key));
const SCHEMA_KEYS = Object.keys(widgetConfigBody.shape).filter((key) => key !== 'ink');

describe('what a panel honours, checked against the panel', () => {
  for (const type of TYPES) {
    it(`draws every key ${type} is said to honour`, () => {
      for (const key of PANEL_HONOURS[type] ?? []) {
        expect(movesInk(type, key), `${type}.${key} is in PANEL_HONOURS and changes nothing`).toBe(
          true,
        );
      }
    });

    it(`draws nothing else for ${type}`, () => {
      // The other half, and the one that keeps the table honest as the
      // renderer grows: a key the draws started reading without being added
      // here is an option the ink lane could never offer.
      const honoured = new Set(PANEL_HONOURS[type] ?? []);
      for (const key of SCHEMA_KEYS) {
        if (honoured.has(key)) continue;
        expect(movesInk(type, key), `${type}.${key} moves ink but is not in PANEL_HONOURS`).toBe(
          false,
        );
      }
    });
  }
});

describe('what a panel cannot honour, and says so', () => {
  it('names a real setting for every note', () => {
    for (const entry of PANEL_IGNORES) {
      expect(SCHEMA_KEYS, `${entry.key} is not a stored option`).toContain(entry.key);
      expect(entry.label.length).toBeGreaterThan(0);
      // Written for somebody in a kitchen: a reason, not a category.
      expect(entry.why.length).toBeGreaterThan(12);
    }
  });

  it('draws none of them, on any widget', () => {
    /*
     * The sentence in the editor is "set on the wall, not drawn here" — so if
     * one of these did move ink, a household would be told a setting is ignored
     * while watching it work.
     */
    for (const entry of PANEL_IGNORES) {
      for (const type of TYPES) {
        expect(movesInk(type, entry.key), `${type}.${entry.key} is ignored but moves ink`).toBe(
          false,
        );
      }
    }
  });

  it('accounts for every stored option, one way or the other', () => {
    // Derived from the schema rather than from a list here, so a new key has to
    // be placed deliberately instead of falling between the two tables.
    for (const key of SCHEMA_KEYS) {
      const honouredSomewhere = TYPES.some((type) => (PANEL_HONOURS[type] ?? []).includes(key));
      expect(honouredSomewhere || IGNORED.has(key), `${key} is in neither table`).toBe(true);
      expect(honouredSomewhere && IGNORED.has(key), `${key} is in both tables`).toBe(false);
    }
  });
});

describe('the lane the editor offers', () => {
  it('offers nothing the renderer would not draw', () => {
    for (const [type, keys] of Object.entries(INK_LANE)) {
      for (const key of keys) {
        expect(PANEL_HONOURS[type] ?? [], `${type}.${key}`).toContain(key);
      }
    }
  });

  it('leaves a widget’s identity on the wall', () => {
    /*
     * A panel says *less* than the wall it follows, never something else — a
     * household looking at two screens has to be able to believe they are
     * showing the same canvas. So the lane may not carry a title, a note's
     * words, a picture, a module or a countdown's date, all of which a panel
     * does otherwise honour.
     */
    for (const key of ['title', 'showTitle', 'text', 'items', 'image', 'module', 'target']) {
      expect(INK_KEYS, key).not.toContain(key);
    }
  });

  it('names a lane for every type that can be placed', () => {
    for (const type of TYPES) expect(Object.keys(INK_LANE)).toContain(type);
  });

  it('is exactly what the schema will store', () => {
    // Two lists, one idea: `INK_KEYS` is the renderer's side and the schema's
    // pick is the boundary's. A key in one and not the other is either an
    // option the editor offers and the server rejects, or the reverse.
    expect(Object.keys(inkOverrideBody.shape).sort()).toEqual([...INK_KEYS].sort());
  });
});

describe('the override itself', () => {
  it('changes what the panel draws', () => {
    const wall = frame('weather', { count: 3 });
    const inked = frame('weather', { count: 3, ink: { count: 1 } });
    expect(inked).not.toBe(wall);
    // And it draws *exactly* what the overridden value draws — the merge is a
    // merge, not an approximation of one.
    expect(inked).toBe(frame('weather', { count: 1 }));
  });

  it('is dropped from the config it is merged into', () => {
    // `ink` is the lane, not a setting. A tolerant reader downstream should
    // never meet it.
    expect(withInk({ count: 3, ink: { count: 1 } })).toEqual({ count: 1 });
    expect(withInk({ count: 3 })).toEqual({ count: 3 });
    expect(withInk({ count: 3, ink: 'nonsense' })).toEqual({ count: 3 });
  });

  it('adds a setting the wall never had', () => {
    expect(frame('shift', { ink: { shiftName: 'code' } })).toBe(frame('shift', { shiftName: 'code' }));
  });

  it('is refused by the schema when it nests, or names something unknown', () => {
    // One level deep is a fact about the shape rather than a promise: `ink` is
    // not among the picked keys, so there is no recursion to bound.
    expect(widgetConfigBody.safeParse({ ink: { ink: { count: 1 } } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ ink: { background: '#ff0000' } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ ink: { nonsense: 1 } }).success).toBe(false);
    // …and accepted when it says something the lane offers.
    expect(widgetConfigBody.safeParse({ count: 6, ink: { count: 2 } }).success).toBe(true);
  });

  it('is bounded by the same rule its wall twin is', () => {
    // Picked from the wall's own fields, so a value out of range on the wall is
    // out of range here — with the same message, for ever, without anybody
    // having to remember two places.
    expect(widgetConfigBody.safeParse({ ink: { count: 0 } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ ink: { count: 999 } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ ink: { mode: 'nonsense' } }).success).toBe(false);
  });
});

describe('the fixture itself', () => {
  it('draws something for every type, or the probes prove nothing', () => {
    // A base that renders an empty box would make every "moves no ink"
    // assertion above pass for the wrong reason.
    for (const type of TYPES) {
      const base = BASES[type]?.[0] ?? {};
      expect(frame(type, base).includes('1'), type).toBe(true);
    }
    expect(TODAY).toBe(MODEL.today);
  });
});
