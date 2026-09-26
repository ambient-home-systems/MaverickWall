/**
 * Home Assistant's `tile` look, measured on a real paired wall (plan item
 * P5.3, decision D4).
 *
 * A tile is Home Assistant's own tile card, drawn by the wall: a reading's
 * mark in a filled circle coloured by what the thing is doing, its name and
 * its state — and controlling nothing. Every promise it makes is a fact about
 * pixels, so every one is asked of a real Chromium on the shipped Classic wall
 * with three family calendars, at 1080x1920 and 1920x1080, with eight readings
 * seeded into the cache the house panel reads, in the shapes Home Assistant
 * really sends: a door that is open, a thermometer, a lamp at brightness 153
 * of 255, a blind at 40%, a lock, a thermostat heating, a fan at 33% and a
 * person at home.
 *
 *  1. **It fits its box.** Nothing is cut (`scrollWidth` past `clientWidth`, the
 *     only reading that sees a clipped run) and nothing ends outside the box;
 *     the tiles drawn are the first readings in the household's order and as
 *     many as the stamp says; every figure is tabular; and on a wall measured
 *     as a 32" television the name and the state are the event and time roles
 *     to the px the page resolves them to.
 *  2. **Each circle is its reading's tone**, read off the computed background
 *     and held to the page's own resolution of `--state-active`,
 *     `--state-alert` and `--state-idle` — expected from what Home Assistant
 *     said about each thing, never from a class the renderer stamped. The mark
 *     inside is the tile's ground, which is what makes it legible on all three.
 *  3. **The bar is the level the words say**: its fill over its track is 60%
 *     for brightness 153, 40% for the blind and 33% for the fan, and a reading
 *     with no level has no bar.
 *  4. **A bar costs no tile.** Pairs of boxes at a run of heights, one asking
 *     for the bar and one not, show the same number of tiles every time — and
 *     some of those heights keep the bar and some give it up, or the rule was
 *     never exercised.
 *  5. **"5 min ago" moves by itself**: with the manifest cut off after the
 *     load, three minutes on the wall's own clock turn "7 min ago" into
 *     "10 min ago", so the words come from the tick and not from a document.
 *  6. **The shadow is the theme's, and a style lane can take it away**, never
 *     add one; the hairline and the ground step are there either way.
 *  7. **The list is the list it was**: a list box draws the same markup
 *     whether or not the readings carry the tone, the time and the level a
 *     tile reads — which is what a server from before P5.3 sends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { readForecastBox, roleSizes, tokenColours, SIZES, WALLS, wallName, type Orientation } from './browser-weather-looks.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

/**
 * The house, as Home Assistant would describe it: entity, state, the cached
 * attributes, the friendly name, the unit, how long ago the state changed —
 * and what a tile should say about it, which is the expectation, written from
 * Home Assistant's own words rather than read back off the renderer.
 */
const HOUSE: readonly {
  readonly entity: string;
  readonly state: string;
  readonly attributes: string;
  readonly name: string;
  readonly unit: string | null;
  readonly minutesAgo: number;
  readonly tone: 'active' | 'alert' | 'idle';
  readonly level?: number;
}[] = [
  { entity: 'binary_sensor.front_door', state: 'on', attributes: '{"device_class":"door"}', name: 'Front door', unit: null, minutesAgo: 7, tone: 'alert' },
  { entity: 'sensor.kitchen_temperature', state: '19.4', attributes: '{"device_class":"temperature"}', name: 'Kitchen', unit: '°C', minutesAgo: 14, tone: 'idle' },
  // 153 of 255 is 60%, which is what the state line says and so the bar.
  { entity: 'light.living_room', state: 'on', attributes: '{"device_class":null,"brightness":153}', name: 'Living room lamp', unit: null, minutesAgo: 21, tone: 'active', level: 60 },
  { entity: 'cover.bedroom_blind', state: 'open', attributes: '{"device_class":null,"current_position":40}', name: 'Bedroom blind', unit: null, minutesAgo: 28, tone: 'active', level: 40 },
  { entity: 'lock.back_door', state: 'locked', attributes: '{"device_class":null}', name: 'Back door', unit: null, minutesAgo: 35, tone: 'idle' },
  { entity: 'climate.hall', state: 'heat', attributes: '{"device_class":null,"hvac_action":"heating","current_temperature":21}', name: 'Hall', unit: null, minutesAgo: 42, tone: 'active' },
  { entity: 'fan.office', state: 'on', attributes: '{"device_class":null,"percentage":33}', name: 'Office fan', unit: null, minutesAgo: 49, tone: 'active', level: 33 },
  { entity: 'person.ada', state: 'home', attributes: '{"device_class":null}', name: 'Ada', unit: null, minutesAgo: 56, tone: 'active' },
];

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  const at = wall.now();
  equipHousehold(wall.db, at);
  /*
   * The readings go straight into the cache the house panel reads, the way
   * `browser-ha-readings` seeds its two: the poll is the Home Assistant
   * suite's subject, and this file's is what the wall draws from the rows.
   * Nothing answers at the address, and a poll that runs leaves the rows be.
   */
  wall.db
    .prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`)
    .run('http://127.0.0.1:1/api', at);
  HOUSE.forEach((reading, order) => {
    wall.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'label_value', NULL, ?)`,
      )
      .run(reading.entity, reading.state, reading.attributes, reading.name, reading.unit,
        at - reading.minutesAgo * 60_000, at, order);
  });
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Box {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly config: Record<string, unknown>;
}

/**
 * Classic's own canvas, with these Home Assistant boxes drawn on top of it —
 * saved through the real `POST /admin/layout`, so the schema is the boundary.
 * Classic has no Home Assistant widget of its own, so the boxes are the ones a
 * household would drag in; on top, so each is measured on its own.
 */
async function place(orientation: Orientation, boxes: readonly Box[]): Promise<void> {
  const classic = readLayoutWidgets(wall.db, screenId, orientation).filter((row) => row.type !== 'homeassistant');
  const aspects = wall.db
    .prepare('SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?')
    .get(screenId) as { p: number; l: number };
  const widgets = [
    ...classic.map((row) => ({
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      ...(row.config !== null && typeof row.config === 'object' && Object.keys(row.config).length > 0
        ? { config: row.config }
        : {}),
    })),
    ...boxes.map((box, index) => ({
      id: `${box.id}-${orientation}`,
      type: 'homeassistant',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      z: 100 + index,
      config: box.config,
    })),
  ];
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: screenId,
      orientation,
      mode: 'freeform',
      aspect: orientation === 'portrait' ? aspects.p : aspects.l,
      widgets,
    }),
  });
  expect(saved.status, `saving the ${orientation} canvas`).toBe(200);
}

/** The wall's own physical facts, or none — `wall-density.test.ts`'s helper. */
function measureScreen(preset: string | undefined): void {
  const size = preset === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === preset);
  wall.db
    .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
    .run(size?.widthMm ?? null, size?.heightMm ?? null, size?.readAtMm ?? null, screenId);
}

interface DrawnTile {
  readonly name: string;
  readonly state: string;
  readonly ago: string;
  readonly circle: string;
  readonly mark: string | undefined;
  readonly fill: number | undefined;
  readonly nameSize: number;
  readonly stateSize: number;
  readonly border: string;
  readonly borderColour: string;
  readonly ground: string;
  readonly shadow: string;
}

/** Every tile a household could see in a box, in the order drawn, read off the computed styles. */
async function readTiles(page: Page, id: string): Promise<{ readonly tiles: readonly DrawnTile[]; readonly stamped: number; readonly bars: number }> {
  return page.evaluate((widgetId) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
    if (box === null) throw new Error(`no box ${widgetId}`);
    const seen = (node: Element): boolean => {
      const rect = node.getBoundingClientRect();
      return getComputedStyle(node).display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const tiles = Array.from(box.querySelectorAll<HTMLElement>('.ht-tile')).filter(seen).map((tile) => {
      const style = getComputedStyle(tile);
      const circle = tile.querySelector('.ht-circle');
      const mark = tile.querySelector('.ht-circle svg');
      const name = tile.querySelector('.ht-name');
      const state = tile.querySelector('.ht-state');
      const track = tile.querySelector('.ht-bar');
      const fill = tile.querySelector('.ht-fill');
      const words = (node: Element | null): string =>
        node === null
          ? ''
          : Array.from(node.childNodes)
              .filter((one) => one.nodeType === Node.TEXT_NODE)
              .map((one) => one.textContent ?? '')
              .join('')
              .trim();
      return {
        name: words(name),
        state: words(state),
        ago: tile.querySelector('.ht-ago')?.textContent?.trim() ?? '',
        circle: circle === null ? '' : getComputedStyle(circle).backgroundColor,
        mark: mark === null ? undefined : getComputedStyle(mark).color,
        fill:
          track !== null && fill !== null && seen(track)
            ? fill.getBoundingClientRect().width / track.getBoundingClientRect().width
            : undefined,
        nameSize: name === null ? 0 : parseFloat(getComputedStyle(name).fontSize),
        stateSize: state === null ? 0 : parseFloat(getComputedStyle(state).fontSize),
        border: style.borderTopWidth,
        borderColour: style.borderTopColor,
        ground: style.backgroundColor,
        shadow: style.boxShadow,
      };
    });
    return {
      tiles,
      stamped: Number(box.getAttribute('data-tier-items') ?? '-1'),
      bars: Array.from(box.querySelectorAll('.ht-bar')).filter(seen).length,
    };
  }, id);
}

/** What `var(--shadow-card)` resolves to inside a box, in the form `box-shadow` computes to. */
async function themeShadow(page: Page, id: string): Promise<string> {
  return page.evaluate((widgetId) => {
    const host = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"] .house-tiles`) ?? document.body;
    const probe = document.createElement('div');
    probe.style.boxShadow = 'var(--shadow-card, none)';
    host.appendChild(probe);
    const shadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return shadow;
  }, id);
}

/** Two boxes for every orientation: the mark beside the words, and above them. */
function boxesFor(orientation: Orientation): Box[] {
  return orientation === 'portrait'
    ? [
        { id: 'across', x: 0, y: 0.55, w: 1, h: 0.22, config: { variant: 'tile', showBar: true } },
        { id: 'stacked', x: 0, y: 0.78, w: 1, h: 0.22, config: { variant: 'tile', tileLayout: 'vertical', showBar: true } },
      ]
    : [
        { id: 'across', x: 0, y: 0.5, w: 0.5, h: 0.5, config: { variant: 'tile', showBar: true } },
        { id: 'stacked', x: 0.5, y: 0.5, w: 0.5, h: 0.5, config: { variant: 'tile', tileLayout: 'vertical', showBar: true } },
      ];
}

describe('tiles on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `fit their box, read at the wall's roles and sit apart, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(preset);
          await place(size.orientation, boxesFor(size.orientation));
          const { page, close } = await loadWallSettled(link, size);
          try {
            const roles = await roleSizes(page);
            for (const box of boxesFor(size.orientation)) {
              const id = `${box.id}-${size.orientation}`;
              const where = `${wallName(preset)} ${size.width}x${size.height} ${box.id}`;
              const fit = await readForecastBox(page, id);
              expect(fit.clipped, where).toEqual([]);
              for (const run of fit.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');

              const { tiles, stamped } = await readTiles(page, id);
              expect(tiles.length, `${where}: no tile drawn`).toBeGreaterThan(0);
              expect(tiles.length, `${where}: the stamp and the glass disagree`).toBe(stamped);
              // The first readings in the household's order, never a gap.
              expect(tiles.map((tile) => tile.name), where).toEqual(HOUSE.slice(0, tiles.length).map((one) => one.name));

              if (preset !== undefined) {
                for (const tile of tiles) {
                  expect(tile.nameSize, `${where} ${tile.name}'s name`).toBeCloseTo(roles['event']!, 1);
                  expect(tile.stateSize, `${where} ${tile.name}'s state`).toBeCloseTo(roles['time']!, 1);
                }
              } else {
                expect(roles['event'], 'an unmeasured wall resolved a role').toBeUndefined();
              }

              // Separated in the rule's order: a hairline, a ground step, and
              // the theme's shadow on top — never the shadow alone.
              const ground = await tokenColours(page, id, ['--bg', '--rule', '--panel']);
              const shadow = await themeShadow(page, id);
              expect(ground['--bg'], 'the tile ground is the canvas colour').not.toBe(ground['--panel']);
              expect(shadow, `${where}: Panels casts a shadow`).not.toBe('none');
              for (const tile of tiles) {
                expect(tile.border, `${where} ${tile.name}`).toBe('1px');
                expect(tile.borderColour, `${where} ${tile.name}`).toBe(ground['--rule']);
                expect(tile.ground, `${where} ${tile.name}`).toBe(ground['--bg']);
                expect(tile.shadow, `${where} ${tile.name}`).toBe(shadow);
              }
            }
          } finally {
            await close();
          }
        },
        SLOW,
      );
    }
  }

  it(
    'colours each circle by what the reading is doing, with the mark in the tile’s own ground',
    async () => {
      measureScreen(undefined);
      const size = SIZES[1]!;
      await place(size.orientation, boxesFor(size.orientation));
      const { page, close } = await loadWallSettled(link, size);
      try {
        const id = `across-${size.orientation}`;
        const colours = await tokenColours(page, id, ['--state-active', '--state-alert', '--state-idle', '--bg']);
        // Three different colours, or a circle painted the wrong one would pass.
        expect(new Set([colours['--state-active'], colours['--state-alert'], colours['--state-idle']]).size).toBe(3);
        const { tiles } = await readTiles(page, id);
        expect(tiles.length, 'every reading fits this box').toBe(HOUSE.length);
        for (const tile of tiles) {
          const expected = HOUSE.find((one) => one.name === tile.name)!;
          expect(tile.circle, `${tile.name} is ${expected.tone}`).toBe(colours[`--state-${expected.tone}`]);
          expect(tile.mark, `${tile.name}'s mark`).toBe(colours['--bg']);
        }
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'draws the bar at the level its state says, and none on a reading without one',
    async () => {
      measureScreen(undefined);
      const size = SIZES[1]!;
      await place(size.orientation, [
        ...boxesFor(size.orientation),
        { id: 'barless', x: 0, y: 0, w: 0.5, h: 0.5, config: { variant: 'tile' } },
      ]);
      const { page, close } = await loadWallSettled(link, size);
      try {
        for (const box of ['across', 'stacked']) {
          const { tiles } = await readTiles(page, `${box}-${size.orientation}`);
          for (const tile of tiles) {
            const expected = HOUSE.find((one) => one.name === tile.name)!;
            if (expected.level === undefined) {
              expect(tile.fill, `${box}: ${tile.name} has no level and drew a bar`).toBeUndefined();
            } else {
              expect(tile.fill, `${box}: ${tile.name} drew no bar`).toBeDefined();
              expect(Math.abs(tile.fill! - expected.level / 100), `${box}: ${tile.name}'s bar`).toBeLessThanOrEqual(0.01);
              expect(tile.state, `${box}: ${tile.name}'s words and bar disagree`).toContain(`${expected.level}%`);
            }
          }
        }
        expect((await readTiles(page, `barless-${size.orientation}`)).bars, 'a box that asked for none drew a bar').toBe(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'keeps a bar only where it costs no tile',
    async () => {
      measureScreen(undefined);
      const size = SIZES[0]!;
      /*
       * Pairs at a run of heights, one asking for the bar and one not, both
       * showing the three readings that carry a level — so every tile a bar
       * could be drawn on is in the first row, and a bar that is missing was
       * given up by the rule rather than hidden along with its tile. The first
       * draft of this test showed all eight readings, whose first row is a
       * door and a thermometer, and "counted" bars given up that were in fact
       * on tiles the box had no room for; forcing the bar on at every height
       * left it green, which is how that was found. The boxes overlap, which
       * costs nothing: each is measured by its own rectangles, never by what
       * is on top.
       */
      const levelled = HOUSE.filter((one) => one.level !== undefined);
      const heights = Array.from({ length: 15 }, (_, index) => Math.round((0.045 + index * 0.005) * 1000) / 1000);
      const readings = levelled.map((one) => one.entity);
      const boxes: Box[] = heights.flatMap((h, index) => [
        { id: `bar${index}`, x: 0, y: 0, w: 1, h, config: { variant: 'tile', showBar: true, readings } },
        { id: `plain${index}`, x: 0, y: 0, w: 1, h, config: { variant: 'tile', readings } },
      ]);
      await place(size.orientation, boxes);
      const { page, close } = await loadWallSettled(link, size);
      try {
        let kept = 0;
        let gaveUp = 0;
        for (let index = 0; index < heights.length; index++) {
          const barred = await readTiles(page, `bar${index}-${size.orientation}`);
          const plain = await readTiles(page, `plain${index}-${size.orientation}`);
          const where = `h=${heights[index]}`;
          expect(barred.tiles.length, `${where}: the bar cost a tile`).toBe(plain.tiles.length);
          if (plain.tiles.length === levelled.length) {
            if (barred.bars === levelled.length) kept++;
            else if (barred.bars === 0) gaveUp++;
            else expect.fail(`${where}: ${barred.bars} of ${levelled.length} bars drawn — a bar is all or nothing`);
          }
        }
        expect(kept, 'no height kept the bars, so nothing was measured').toBeGreaterThan(0);
        expect(gaveUp, 'no height with every tile showing gave the bars up, so the rule was never exercised').toBeGreaterThan(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'gives up the time first and the name next, and keeps the state to the last',
    async () => {
      measureScreen(undefined);
      const size = SIZES[0]!;
      const config = { variant: 'tile', showChanged: true, readings: ['binary_sensor.front_door', 'sensor.kitchen_temperature'] };
      /*
       * Three widths of one box, one tile across in each, so the width is the
       * tile's and the tier is read off it (`HOUSE_TILE_TIERS`). Picked from
       * the stamps a first run printed, not from arithmetic: the table's `ch`
       * is the name's own, which is bold and so wider than a regular run's,
       * and 0.25 of this wall was still T0 where arithmetic said T1.
       */
      const widths = { narrow: 0.12, middle: 0.275, wide: 0.4 } as const;
      /*
       * And a box as wide as the wall holding four of them, each asking for
       * the time. The box has room for it; each tile's own cell does not, and
       * the tier is one tile's (`HOUSE_TILE_TIERS`) — read off the whole box,
       * every tile would promise itself a width it has a quarter of.
       */
      const crowded = {
        variant: 'tile',
        showChanged: true,
        readings: ['binary_sensor.front_door', 'sensor.kitchen_temperature', 'light.living_room', 'cover.bedroom_blind'],
      };
      await place(size.orientation, [
        ...Object.entries(widths).map(([id, w], index) => ({ id, x: 0, y: index * 0.2, w, h: 0.18, config })),
        { id: 'crowded', x: 0, y: 0.6, w: 1, h: 0.18, config: crowded },
      ]);
      const { page, close } = await loadWallSettled(link, size);
      try {
        const said = async (id: string): Promise<{ name: string; state: string; ago: string }> =>
          (await readTiles(page, `${id}-${size.orientation}`)).tiles[0]!;
        const narrow = await said('narrow');
        const middle = await said('middle');
        const wide = await said('wide');
        // The narrowest tile still says what the door is doing, and nothing else.
        expect(narrow, 'the narrow tile').toMatchObject({ name: '', state: 'Open', ago: '' });
        // Room for its name before room for when it changed.
        expect(middle, 'the middle tile').toMatchObject({ name: 'Front door', state: 'Open', ago: '' });
        expect(wide.name, 'the wide tile').toBe('Front door');
        expect(wide.ago, 'the wide tile').toMatch(/^· \d+ min ago$/);
        const four = (await readTiles(page, `crowded-${size.orientation}`)).tiles;
        expect(four.map((tile) => tile.name), 'four across').toEqual(['Front door', 'Kitchen', 'Living room lamp', 'Bedroom blind']);
        for (const tile of four) expect(tile.ago, `${tile.name} was given a time its own tile has no room for`).toBe('');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'says when it changed, and the wall keeps it up to date with no new document',
    async () => {
      measureScreen(undefined);
      const size = SIZES[1]!;
      await place(size.orientation, [
        {
          id: 'changed', x: 0, y: 0.5, w: 1, h: 0.5,
          config: { variant: 'tile', showChanged: true, readings: ['binary_sensor.front_door', 'light.living_room'] },
        },
      ]);
      /*
       * Re-stamped now rather than trusted from the setup, because the tests
       * before this one took real minutes and the wall's clock ran on through
       * them. Five seconds short of a whole minute, so a slow load reads the
       * same "7 min ago" as a quick one.
       */
      for (const reading of HOUSE) {
        wall.db
          .prepare('UPDATE ha_entity_cache SET last_changed_at = ? WHERE entity_id = ?')
          .run(wall.now() - reading.minutesAgo * 60_000 - 5_000, reading.entity);
      }
      const { page, close } = await loadWallSettled(link, size, { clock: 'installed' });
      try {
        const id = `changed-${size.orientation}`;
        const first = await readTiles(page, id);
        expect(first.tiles.map((tile) => tile.ago)).toEqual(['· 7 min ago', '· 21 min ago']);
        // The document is cut off from here: whatever changes next is the tick.
        await page.route('**/d/manifest*', (route) => route.abort('connectionrefused'));
        await page.clock.runFor(3 * 60_000);
        const later = await readTiles(page, id);
        expect(later.tiles.map((tile) => tile.ago)).toEqual(['· 10 min ago', '· 24 min ago']);
        // …and the state beside it is the state it was: only the words for the time moved.
        expect(later.tiles.map((tile) => tile.state)).toEqual(first.tiles.map((tile) => tile.state));
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'casts the theme’s shadow, which a widget’s style lane can take away',
    async () => {
      measureScreen(undefined);
      const size = SIZES[1]!;
      await place(size.orientation, [
        { id: 'shadowed', x: 0, y: 0.5, w: 0.5, h: 0.5, config: { variant: 'tile' } },
        { id: 'flat', x: 0.5, y: 0.5, w: 0.5, h: 0.5, config: { variant: 'tile', style: { shadow: 'none' } } },
      ]);
      const { page, close } = await loadWallSettled(link, size);
      try {
        const shadowed = await readTiles(page, `shadowed-${size.orientation}`);
        const flat = await readTiles(page, `flat-${size.orientation}`);
        const theme = await themeShadow(page, `shadowed-${size.orientation}`);
        expect(theme, 'Panels casts no shadow, so nothing here can tell the two apart').not.toBe('none');
        for (const tile of shadowed.tiles) expect(tile.shadow, tile.name).toBe(theme);
        for (const tile of flat.tiles) {
          expect(tile.shadow, `${tile.name} kept a shadow its lane took away`).toBe('none');
          // Still a tile: the hairline is the separation, not the shadow.
          expect(tile.border, tile.name).toBe('1px');
        }
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'draws a list box exactly as it did before a reading carried what a tile reads',
    async () => {
      measureScreen(undefined);
      const size = SIZES[1]!;
      await place(size.orientation, [{ id: 'list', x: 0, y: 0.5, w: 1, h: 0.5, config: {} }]);
      const id = `list-${size.orientation}`;
      const markup = async (strip: boolean): Promise<{ html: string; carried: number }> => {
        let carried = 0;
        const { page, close } = await loadWallSettled(link, size, {
          patchManifest: (body) => {
            const readings = ((body['panels'] as Record<string, { readings?: Record<string, unknown>[] }> | undefined)?.['home']
              ?.readings ?? []);
            // Per document, not summed: the wall may poll more than once.
            carried = readings.filter((reading) => 'tone' in reading || 'changedAt' in reading || 'level' in reading).length;
            for (const reading of readings) {
              if (strip) {
                delete reading['tone'];
                delete reading['changedAt'];
                delete reading['level'];
              }
            }
          },
        });
        try {
          const html = await page.evaluate(
            (widgetId) => document.querySelector(`#wall .canvas .fw[data-widget-id="${widgetId}"]`)?.outerHTML ?? '',
            id,
          );
          return { html, carried };
        } finally {
          await close();
        }
      };
      const now = await markup(false);
      const before = await markup(true);
      // Not vacuous: the document really carried what the list must not read.
      expect(now.carried, 'no reading carried a tone, a time or a level').toBe(HOUSE.length);
      expect(now.html, 'the list box drew nothing').toContain('hs-item');
      expect(now.html).toBe(before.html);
    },
    SLOW,
  );
});
