import { describe, expect, it } from 'vitest';

import { todoListHandle, type Manifest, type ManifestDay } from '../src/api/manifest.js';
import { inkOverrideBody, widgetConfigBody } from '../src/api/widget-schema.js';
import { widgetStyleBody } from '../src/api/widget-style.js';
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
          { name: 'Fri', high: 24, low: 13, glyph: 'clear' },
          { name: 'Sat', high: 22, low: 12, glyph: 'cloudy' },
          { name: 'Sun', high: 20, low: 11, glyph: 'rain' },
        ],
        provider: 'nws',
        fetchedAt: 1,
      },
      home: {
        readings: [
          { label: 'Front door', value: 'Locked', glyph: 'lock', mode: 'label_value' },
          { label: 'Kitchen', value: '19.4 C', glyph: 'temperature', mode: 'label_value' },
          { label: 'Garage', value: 'Open', icon: 'garage', mode: 'label_value' },
        ],
        fetchedAt: 1,
      },
      mymod: { items: [{ label: 'Bins', value: 'Tuesday' }, { label: 'Tide', value: 'High' }] },
      /*
       * A watched to-do list (RFC 012), keyed the way the module keys it — by
       * the handle the manifest mints from the entity id — with one completed
       * item, so `showDone` has something to bring back. Without this fixture
       * the two new `todo` keys could not be proved to move ink at all.
       */
      todo: {
        lists: [
          {
            key: todoListHandle('todo.shopping'),
            name: 'Shopping',
            canTick: true,
            open: 2,
            items: [
              { id: 'h1', summary: 'Milk', done: false, due: null, position: 0 },
              { id: 'h2', summary: 'Eggs', done: false, due: null, position: 1 },
              { id: 'h3', summary: 'Bread', done: true, due: null, position: 2 },
            ],
          },
        ],
      },
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
  // Both sources: `showDone` can only move ink on a list-backed widget, and
  // `list` is proved from the typed base by switching it to the list.
  todo: [{ items: ['Milk', 'Bread'] }, { list: 'todo.shopping' }],
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
  list: ['todo.shopping'],
  showDone: [true],
  background: ['#ff0000'],
  opacity: [40],
  corners: ['rounded'],
  shadow: [true],
  /*
   * The style lane's members (RFC 014 §4.1), each probed *inside* `style` —
   * see `withKey`. Step 0 is the one inset that has to move the frame: the
   * ladder's top is today's padding, so probing 4 alone would compare a frame
   * with itself and "prove" that inset is not honoured.
   */
  'style.--bg': ['#ff0000'],
  'style.--panel': ['#ff0000'],
  'style.--rule': ['#ff0000'],
  'style.--ink': ['#ff0000'],
  'style.--muted': ['#ff0000'],
  'style.--faint': ['#ff0000'],
  'style.--accent': ['#ff0000'],
  'style.--s-day': ['#ff0000'],
  'style.--s-night': ['#ff0000'],
  'style.--s-break': ['#ff0000'],
  'style.--s-straight': ['#ff0000'],
  'style.--disp': ["'Fraunces', Georgia, serif"],
  'style.--f-sans': ["'Fraunces', Georgia, serif"],
  'style.weight': ['bold'],
  'style.tracking': ['wide'],
  'style.inset': [0, 2],
};

/**
 * A config with one key set — a top-level key, or a `style.<key>` member set
 * inside the lane, which is how the honours tables spell a key one level
 * down. The lane's other members are kept, so `style.inset` is probed against
 * whatever the base carried there.
 */
function withKey(start: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (!key.startsWith('style.')) return { ...start, [key]: value };
  const lane = typeof start['style'] === 'object' && start['style'] !== null ? (start['style'] as object) : {};
  return { ...start, style: { ...lane, [key.slice('style.'.length)]: value } };
}

/** Does setting this key change what the panel draws for this widget type? */
function movesInk(type: string, key: string): boolean {
  const values = PROBES[key] ?? [];
  for (const base of BASES[type] ?? []) {
    for (const start of [base, { ...base, showTitle: true, title: 'Base' }]) {
      const before = frame(type, start);
      for (const value of values) {
        if (frame(type, withKey(start, key, value)) !== before) return true;
      }
    }
  }
  return false;
}

const TYPES = Object.keys(BASES);
const IGNORED = new Set(PANEL_IGNORES.map((entry) => entry.key));
/*
 * Every stored option, one level down into the style lane: `style` itself is
 * not a setting a panel can honour or ignore as one thing — its `inset` moves
 * ink and its colours cannot — so it is expanded into its members under the
 * `style.<key>` spelling both tables use. Derived from the two schemas rather
 * than from a list here, so a member added to the lane has to be placed.
 */
const SCHEMA_KEYS = Object.keys(widgetConfigBody.shape)
  .filter((key) => key !== 'ink')
  .flatMap((key) =>
    key === 'style' ? Object.keys(widgetStyleBody.shape).map((member) => `style.${member}`) : [key],
  );

describe('what a panel honours, checked against the panel', () => {
  for (const type of TYPES) {
    it(`draws every key ${type} is said to honour`, () => {
      for (const key of PANEL_HONOURS[type] ?? []) {
        expect(movesInk(type, key), `${type}.${key} is in PANEL_HONOURS and changes nothing`).toBe(
          true,
        );
      }
    });

    /*
     * The other half, and the one that keeps the table honest as the renderer
     * grows: a key the draws started reading without being added here is an
     * option the ink lane could never offer.
     *
     * Two tests rather than one, for the reason the "draws none of them"
     * describe below gives at length: the style lane added sixteen members to
     * SCHEMA_KEYS, and the calendar's month grid is the dearest frame to draw,
     * so one body walking all of them measured 2.2s in isolation and timed
     * out at 5s on a CI runner with the browser suite beside it. The render
     * cost is real and fixed; splitting the lane's members out halves what
     * either body has to pay, and is the shape this file already uses.
     */
    const honoured = new Set(PANEL_HONOURS[type] ?? []);
    const unhonoured = SCHEMA_KEYS.filter((key) => !honoured.has(key));
    it(`draws nothing else for ${type}`, () => {
      for (const key of unhonoured.filter((key) => !key.startsWith('style.'))) {
        expect(movesInk(type, key), `${type}.${key} moves ink but is not in PANEL_HONOURS`).toBe(
          false,
        );
      }
    });

    it(`draws nothing else from the style lane for ${type}`, () => {
      for (const key of unhonoured.filter((key) => key.startsWith('style.'))) {
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

  /*
   * One `it` per type rather than one loop over all of them: `movesInk` renders
   * a frame and walks every one of its 156,000 pixels into a string, and
   * `PANEL_IGNORES.length * TYPES.length` of those in a single test body sat
   * right on the default 5000ms timeout — passing at ~4.9s in isolation and
   * failing at ~5.2s under the load of the rest of the suite, which reads as a
   * flake and is not one: the render cost is real and fixed, only the CPU
   * headroom around it varies. Splitting by type is ten cheap, fast tests
   * instead of one that is one bad scheduling tick from red, and it is the
   * shape the "what a panel honours" describe above already uses for the same
   * reason.
   */
  for (const type of TYPES) {
    it(`draws none of them, on ${type}`, () => {
      /*
       * The sentence in the editor is "set on the wall, not drawn here" — so if
       * one of these did move ink, a household would be told a setting is
       * ignored while watching it work.
       */
      for (const entry of PANEL_IGNORES) {
        expect(movesInk(type, entry.key), `${type}.${entry.key} is ignored but moves ink`).toBe(
          false,
        );
      }
    });
  }

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
    for (const key of ['title', 'showTitle', 'text', 'items', 'image', 'module', 'target', 'list']) {
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
