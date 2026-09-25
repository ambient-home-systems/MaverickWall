import { describe, expect, it } from 'vitest';

import {
  keepWidgetsWithSomethingToSay,
  todoListHandle,
  type HouseholdSetUp,
  type Manifest,
  type ManifestDay,
} from '../src/api/manifest.js';
import { inkOverrideBody, widgetConfigBody } from '../src/api/widget-schema.js';
import { widgetStyleBody } from '../src/api/widget-style.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import {
  INK_KEYS,
  INK_LANE,
  INK_LOOKS,
  PANEL_HONOURS,
  PANEL_IGNORES,
  PANEL_LOOKS,
  WIDGET_ROW_KEYS,
  withInk,
  type PanelIgnores,
} from '../src/epaper/honours.js';
import { VARIANTS, hasVariants, variantsFor } from '../src/epaper/variants.js';
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

/*
 * A household with nothing set up, which is what makes a box *empty*.
 *
 * Every frame goes through `keepWidgetsWithSomethingToSay` first, because
 * that is the panel's own path (`/d/epaper/:file` runs it before
 * `renderScreenFrame`) and it is where `whenEmpty` is resolved — a probe that
 * rendered the widget directly could never see a fallback move ink. Nothing
 * else moves for it: a widget alone on its canvas is kept by the guard however
 * little is set up, so every other key is probed against exactly the frame it
 * always was.
 */
const NOTHING_SET_UP: HouseholdSetUp = { modules: [], shift: false, todoLists: [] };

/**
 * A group's children, for the one type whose keys move ink only through
 * what it holds (RFC 014 §5.1). Four, so that a grid two across and a grid
 * three across draw different cells — two children would fill one row of
 * either — and every one a type that always has something to say, so the
 * group is kept under `NOTHING_SET_UP` and the probes compare two drawn
 * frames rather than two blanks.
 */
const GROUP_CHILDREN: readonly PlacedEpaperWidget[] = [
  { type: 'clock', x: 0, y: 0, w: 0.5, h: 0.5, z: 0, config: {}, parentId: 'g' },
  { type: 'notes', x: 0.5, y: 0, w: 0.5, h: 0.5, z: 1, config: { text: 'Bins Tuesday' }, parentId: 'g' },
  { type: 'countdown', x: 0, y: 0.5, w: 0.5, h: 0.5, z: 2, config: { target: '2026-12-25' }, parentId: 'g' },
  { type: 'notes', x: 0.5, y: 0.5, w: 0.5, h: 0.5, z: 3, config: { text: 'Swim kit' }, parentId: 'g' },
];

/** One widget, alone on a panel, as a string of bits — comparable and exact. */
function frame(type: string, config: Record<string, unknown>): string {
  const placed: PlacedEpaperWidget =
    type === 'group'
      ? { type, x: 0, y: 0, w: 1, h: 1, z: 0, config, id: 'g' }
      : { type, x: 0, y: 0, w: 1, h: 1, z: 0, config };
  const canvas = type === 'group' ? [placed, ...GROUP_CHILDREN] : [placed];
  const widgets = keepWidgetsWithSomethingToSay(canvas, NOTHING_SET_UP).map((widget) => ({
    ...widget,
    config: widget.config as Record<string, unknown>,
  }));
  const fb: Framebuffer = renderFreeformEpaper(MODEL, M, widgets, PANEL);
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
  /*
   * Counting down, and on the day (plan item P5.2). The day is the only time a
   * countdown's `celebrate` does anything and the time its picture sits beside
   * "Today!" — so a base that never reaches it would "prove" both are ignored
   * by never giving them a chance. The model's today is 22 August.
   *
   * And a progress bar and an occasion (the item's second half): `from` moves
   * ink only on the bar, so a base that never draws one would "prove" it is
   * ignored, and `occasion` is proved to move none on the one look that reads
   * it on the wall — which is what `PANEL_IGNORES` says of it.
   */
  countdown: [
    { target: '2026-12-25' },
    { target: '2026-08-22' },
    { target: '2026-12-25', variant: 'progress', from: '2026-08-01' },
    { target: '2026-12-25', variant: 'occasion', occasion: 'christmas' },
  ],
  notes: [{ text: 'Hello there wall' }],
  // Both sources: `showDone` can only move ink on a list-backed widget, and
  // `list` is proved from the typed base by switching it to the list.
  todo: [{ items: ['Milk', 'Bread'] }, { list: 'todo.shopping' }],
  weather: [{}],
  homeassistant: [{}],
  external: [{ module: 'mymod' }],
  image: [{ image: `${'a'.repeat(64)}.png` }],
  // Both a row and a grid, because `columns` can only move ink on a grid —
  // probed from a row alone it would have "proved" the key is not honoured.
  group: [{ layout: 'row' }, { layout: 'grid' }],
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
  /*
   * A designed variant (RFC 014 §4.2). Every type is probed with **every value
   * the schema holds** — read off the enum rather than listed here, so a look
   * added for a type later is probed the day it is added (plan item P4.1). A
   * Weather widget handed a clock's `analogue` is proved to draw nothing
   * different ("not for me"), the clock is proved to draw its two, and every
   * look the plan added ahead of its drawing is proved to draw nothing yet on
   * the type it belongs to — which is what the scoped notes in
   * `PANEL_IGNORES` say. `LOOKS` below asks the same thing value by value.
   */
  variant: widgetConfigBody.shape.variant.unwrap().options,
  showDate: [false],
  // A group's layout and its grid width (RFC 014 §5.1): every other type is
  // proved to draw nothing different for either, and the group both.
  layout: ['column', 'grid'],
  columns: [3],
  showLow: [false],
  showIcon: [false],
  readings: [['Kitchen']],
  target: ['2027-01-01'],
  // The countdown's words, picture and confetti (plan item P5.2).
  unitWords: ['sleeps'],
  emoji: ['christmas-tree', 'party-popper'],
  celebrate: [false],
  // …and the second half's: which occasion, and where a bar counts from.
  occasion: ['birthday', 'new-year'],
  from: ['2026-06-01'],
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
  /*
   * A fallback (RFC 014 §5.3): draws where the widget has nothing to say, which
   * under `NOTHING_SET_UP` is every type that can be left out — and nowhere
   * else, which is what keeps it off a clock's row of `PANEL_HONOURS`.
   */
  whenEmpty: [{ type: 'notes', config: { text: 'Instead of the forecast' } }],
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
/**
 * Whether a note is about this type: every note is about every type, except
 * the scoped ones — a Look is honoured on a clock and said to be ignored on a
 * forecast (plan item P4.1), so its notes name the types they are true of.
 */
const isAbout = (entry: PanelIgnores, type: string): boolean =>
  entry.types === undefined || entry.types.includes(type);
const ignoredOn = (type: string, key: string): boolean =>
  PANEL_IGNORES.some((entry) => entry.key === key && isAbout(entry, type));
/**
 * Keys asked value by value in their own block rather than by `movesInk` in
 * the loops below. A Look is the one: `movesInk` asks whether *any* value
 * moves a frame, and `a Look, value by value` asks which ones do on every
 * type, which is strictly the stronger question — and probing all eighteen
 * values again in the "draws nothing else" and "draws none of them" loops
 * took the calendar's body from 2.7s to 3.4s in isolation, in a file whose
 * own history is a 2.2s body timing out at 5s on a loaded CI runner.
 * `draws every key … is said to honour` still asks it of the clock.
 */
const ASKED_BY_VALUE: ReadonlySet<string> = new Set(['variant']);
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
/*
 * And the one setting that is a column beside the config rather than a key in
 * it: a widget's own CSS (RFC 014 §7). `WIDGET_ROW_KEYS` is the honours
 * table's own statement of that, so a note may name it; the probe below sets
 * it on the config anyway, where it is an unknown key, which is the only route
 * a stored value could ever take to `drawWidget` — and it takes none.
 */
const STORED_KEYS = [...SCHEMA_KEYS, ...WIDGET_ROW_KEYS];

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
      for (const key of unhonoured.filter((key) => !key.startsWith('style.') && !ASKED_BY_VALUE.has(key))) {
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
      expect(STORED_KEYS, `${entry.key} is not a stored option`).toContain(entry.key);
      expect(entry.label.length).toBeGreaterThan(0);
      // Written for somebody in a kitchen: a reason, not a category.
      expect(entry.why.length).toBeGreaterThan(12);
      // A scoped note names real types, and at least one — an empty scope is
      // a note about nothing, which the editor would never show.
      if (entry.types !== undefined) {
        expect(entry.types.length, `${entry.key} is scoped to no type`).toBeGreaterThan(0);
        for (const type of entry.types) expect(TYPES, `${entry.key} names ${type}`).toContain(type);
      }
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
      for (const entry of PANEL_IGNORES.filter((one) => isAbout(one, type) && !ASKED_BY_VALUE.has(one.key))) {
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
      const ignoredSomewhere = TYPES.some((type) => ignoredOn(type, key));
      expect(honouredSomewhere || ignoredSomewhere, `${key} is in neither table`).toBe(true);
      /*
       * "Both tables" is asked per type now rather than per key: a Look is
       * honoured on a clock and ignored on a forecast, which is two facts about
       * two renderers, and only a type told both at once is a contradiction.
       */
      for (const type of TYPES) {
        const honoured = (PANEL_HONOURS[type] ?? []).includes(key);
        expect(honoured && ignoredOn(type, key), `${type}.${key} is in both tables`).toBe(false);
      }
    }
  });

  it('says what happens to a Look on every type that has looks, and on no other', () => {
    /*
     * A type with looks either honours `variant` or carries a note saying what
     * its panel draws instead — never neither, which would leave a household
     * who picked a weather look on the wall with no sentence on the panel. And
     * a type with no looks carries no note about one: a note about a control
     * the editor never draws is a sentence about nothing.
     */
    for (const type of TYPES) {
      const honoured = (PANEL_HONOURS[type] ?? []).includes('variant');
      const noted = PANEL_IGNORES.some((entry) => entry.key === 'variant' && entry.types?.includes(type) === true);
      if (hasVariants(type)) expect(honoured !== noted, `${type}: honoured ${honoured}, noted ${noted}`).toBe(true);
      else expect(honoured || noted, `${type} has no looks to honour or ignore`).toBe(false);
    }
    // And every type with looks is one this file probes.
    for (const type of Object.keys(VARIANTS)) expect(TYPES, type).toContain(type);
  });
});

describe('a Look, value by value', () => {
  /*
   * `movesInk` asks whether *any* value of a key moves a frame, which proves a
   * key is read and says nothing about which of its values are. For a Look
   * the values are the whole question (plan items P4.1 and P5.1): the clock
   * draws its two non-default looks, the forecast draws `range` as black bars
   * and its other looks as the strip, and every other type's looks — added
   * ahead of their drawings — draw that type's default. So every schema value
   * is rendered on every type and held to `PANEL_LOOKS`, which is where that
   * statement lives: a value moves the frame if, and only if, the table names
   * it for the type.
   */
  const LOOKS: readonly string[] = PROBES['variant'] as readonly string[];

  for (const type of TYPES) {
    it(`draws only its own looks, on ${type}`, () => {
      const drawn = PANEL_LOOKS[type] ?? [];
      for (const withLook of BASES[type] ?? []) {
        // From the base with its own Look taken off, so the frame compared
        // against is the type's default: a countdown's progress base carries
        // one, because `from` moves ink only on the bar (P5.2).
        const { variant: _look, ...base } = withLook;
        // With a title too, the way `movesInk` probes every key.
        for (const start of [base, { ...base, showTitle: true, title: 'Base' }]) {
          const before = frame(type, start);
          for (const value of LOOKS) {
            const moved = frame(type, { ...start, variant: value }) !== before;
            expect(moved, `${type} ${JSON.stringify(start)} with variant ${value}`).toBe(drawn.includes(value));
          }
        }
      }
    });
  }

  it('names a type’s drawn looks exactly when it honours the key, and only its own non-default looks', () => {
    for (const type of TYPES) {
      const honours = (PANEL_HONOURS[type] ?? []).includes('variant');
      const drawn = PANEL_LOOKS[type];
      expect(drawn !== undefined && drawn.length > 0, `${type}: honours ${honours}, PANEL_LOOKS ${JSON.stringify(drawn)}`).toBe(honours);
      const own = variantsFor(type);
      for (const value of drawn ?? []) {
        expect(own, `${type} draws ${value}`).toContain(value);
        expect(value, `${type}'s default is not a look of its own`).not.toBe(own[0]);
      }
    }
    // The countdown joined in P5.2, with the page, the ticket, the bar and the
    // month as still frames.
    expect(Object.keys(PANEL_LOOKS).sort()).toEqual(['clock', 'countdown', 'weather']);
  });

  it('draws a forecast’s range as bars, and its colour as the strip (plan item P5.1)', () => {
    // The two named in the brief, asked directly rather than through the table.
    const strip = frame('weather', {});
    expect(frame('weather', { variant: 'range' })).not.toBe(strip);
    expect(frame('weather', { variant: 'colour' })).toBe(strip);
    expect(frame('weather', { variant: 'strip' })).toBe(strip);
  });

  it('probes every value the schema holds', () => {
    expect([...LOOKS].sort()).toEqual([...widgetConfigBody.shape.variant.unwrap().options].sort());
    expect(LOOKS.length).toBe(18);
  });
});

describe('the Looks the lane offers', () => {
  /*
   * `INK_LOOKS` narrows a Look on the ink lane (plan item P5.1): a forecast's
   * lane offers the strip, `today` and the range, and never a look a panel
   * would draw as its strip — `colour` there would be a control that moves
   * nothing. Every narrowed type offers its default, and only its own looks.
   */
  it('offers only a type’s own looks, its default among them, on a type whose lane has the key', () => {
    for (const [type, looks] of Object.entries(INK_LOOKS)) {
      const own = variantsFor(type);
      expect(looks, type).toContain(own[0]);
      for (const look of looks) expect(own, `${type} offers ${look}`).toContain(look);
      expect(INK_LANE[type] ?? [], `${type} narrows a Look its lane does not offer`).toContain('variant');
    }
    expect(INK_LOOKS['weather']).toEqual(['strip', 'today', 'range']);
    expect(INK_LOOKS['countdown']).toEqual(['number', 'page', 'ticket', 'progress', 'month']);
  });

  it('offers no look a panel draws as its default, bar the ones owned by a later session', () => {
    for (const [type, looks] of Object.entries(INK_LOOKS)) {
      const own = variantsFor(type);
      for (const look of looks.filter((one) => one !== own[0] && !AWAITING.has(`${type}.${one}`))) {
        expect(PANEL_LOOKS[type] ?? [], `${type}.${look} is offered and drawn as the default`).toContain(look);
      }
    }
  });

  /*
   * The lane offers `today` because a panel draws it as its own look — a
   * large temperature with its "at HH:MM" stamp (P5.1). This was an expected
   * failure owned by the session that designed `today`, and it passes now
   * that the draw exists.
   */
  it('draws a forecast’s today as its own look on a panel', () => {
    expect(frame('weather', { variant: 'today' })).not.toBe(frame('weather', {}));
  });
});

/**
 * Lane looks a later session will draw: offered now, drawn as the default
 * until then. Empty since P5.1 drew `today` on a panel; kept as the device the
 * next such look uses, and the assertion that reads it still runs.
 */
const AWAITING: ReadonlySet<string> = new Set<string>();

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

  it('is refused by the schema when a fallback nests, or carries an ink lane', () => {
    // `whenEmpty.config` is the widget's config less `whenEmpty` and `ink`,
    // by omission rather than by a second declaration — so a fallback's
    // fallback is a rejected key, and one level deep is a fact about the shape.
    const notes = { type: 'notes', config: { text: 'Hi' } };
    expect(widgetConfigBody.safeParse({ whenEmpty: notes }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ whenEmpty: { type: 'notes' } }).success).toBe(true);
    expect(
      widgetConfigBody.safeParse({ whenEmpty: { type: 'notes', config: { whenEmpty: notes } } }).success,
    ).toBe(false);
    expect(
      widgetConfigBody.safeParse({ whenEmpty: { type: 'notes', config: { ink: { count: 1 } } } }).success,
    ).toBe(false);
    expect(widgetConfigBody.safeParse({ whenEmpty: { type: 'website' } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ whenEmpty: { type: 'notes', nonsense: 1 } }).success).toBe(false);
    // And the ink lane cannot carry one: a panel substitutes where its wall does.
    expect(widgetConfigBody.safeParse({ ink: { whenEmpty: notes } }).success).toBe(false);
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

describe('a fallback for an empty box, on the panel', () => {
  /*
   * RFC 014 §5.3. Resolved before the renderer, in the same function the wall's
   * canvas goes through, so the panel draws the note exactly where the wall
   * does — and draws the forecast, untouched, wherever the forecast has
   * something to say.
   */
  const notes = { type: 'notes', config: { text: 'Instead of the forecast' } };

  it('draws the fallback, and exactly the fallback, in an empty box', () => {
    const empty = frame('weather', {});
    const withFallback = frame('weather', { whenEmpty: notes });
    expect(withFallback).not.toBe(empty);
    expect(withFallback).toBe(frame('notes', notes.config));
  });

  it('never replaces a widget that has something to say', () => {
    const placed: PlacedEpaperWidget = { type: 'weather', x: 0, y: 0, w: 1, h: 1, z: 0, config: { whenEmpty: notes } };
    const setUp: HouseholdSetUp = { modules: ['weather'], shift: false, todoLists: [] };
    const [resolved] = keepWidgetsWithSomethingToSay([placed], setUp);
    expect(resolved?.type).toBe('weather');
    expect(resolved?.substituted).toBeUndefined();
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
