/**
 * The status card (plan item M6.8) and the day's line (plan item M6.10),
 * measured on a real paired wall.
 *
 * Seeded the way `browser-ha-tile` seeds its house: rows straight into the
 * cache the house panel reads, in the shapes Home Assistant sends — a washer
 * saying what it is doing, its programme progress as a percentage, a
 * thermometer with a day of history, a door, and a person whose picture is a
 * handle nothing can serve (the house is not reachable here) — so the card's
 * picture has to give way to its mark.
 *
 *  1. **The card says one thing large and fits its box**: the state is the
 *     card's one large reading, larger than the name and at most 1.8 times it,
 *     with nothing cut and nothing outside the box.
 *  2. **The progress bar is the number the reading says**: its fill over its
 *     track is 45%.
 *  3. **Loud when finished**: the state in the page's own `--state-alert`, and
 *     a ring that breathes on the wall clock's `STATUS_RING_MS` where motion is
 *     allowed and stands still where it is not.
 *  4. **A picture that does not arrive gives way to the mark.**
 *  5. **A sparkline is a fixed-height row**: a reading with a day and one with
 *     none draw rows of one height, the day as a line, and a tile row with
 *     lines is the same height across.
 *  6. **A sparkline costs no tile**: boxes at a run of heights show the same
 *     tiles with the line asked for and without, and some keep the line and
 *     some give it up.
 *  7. **The list's line is a width, never a row**: a list reading is the same
 *     height with its line as without.
 *  8. **The editor writes what it shows**: the card's reading, its finished
 *     words and the line switch, saved as entity ids and words — and the
 *     card's controls are offered on the card's look alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { HISTORY_POINTS, historyWindowEnd } from '../src/modules/homeassistant/history.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
const PORTRAIT = { width: 1080, height: 1920 };
const PICTURE_KEY = 'ab'.repeat(32);

const DAY = Array.from({ length: HISTORY_POINTS }, (_, i) => (i === 10 ? null : Math.round((18 + 3 * Math.sin(i / 6)) * 10) / 10));

const HOUSE = [
  { entity: 'sensor.washer_status', state: 'Running', attributes: '{"device_class":null}', name: 'Washer', unit: null },
  { entity: 'sensor.washer_progress', state: '45', attributes: '{"device_class":null}', name: 'Washer progress', unit: '%' },
  { entity: 'sensor.kitchen_temperature', state: '19.4', attributes: '{"device_class":"temperature"}', name: 'Kitchen', unit: '°C', history: DAY },
  { entity: 'binary_sensor.front_door', state: 'off', attributes: '{"device_class":"door"}', name: 'Front door', unit: null },
  { entity: 'person.ada', state: 'home', attributes: `{"device_class":null,"picture_key":"${PICTURE_KEY}"}`, name: 'Ada', unit: null },
] as const;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  const at = wall.now();
  equipHousehold(wall.db, at);
  wall.db
    .prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`)
    .run('http://127.0.0.1:1/api', at);
  HOUSE.forEach((reading, order) => {
    const history = 'history' in reading ? JSON.stringify(reading.history) : null;
    wall.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order, history, history_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'label_value', NULL, ?, ?, ?)`,
      )
      .run(reading.entity, reading.state, reading.attributes, reading.name, reading.unit,
        at - 20 * 60_000, at, order, history, history === null ? null : historyWindowEnd(at));
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

/** Classic's own canvas with these Home Assistant boxes on top, saved through the real route. */
async function place(boxes: readonly Box[]): Promise<void> {
  const classic = readLayoutWidgets(wall.db, screenId, 'portrait').filter((row) => row.type !== 'homeassistant');
  const aspects = wall.db.prepare('SELECT layout_aspect AS p FROM screens WHERE id = ?').get(screenId) as { p: number };
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
      id: box.id,
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
    body: JSON.stringify({ screen: screenId, orientation: 'portrait', mode: 'freeform', aspect: aspects.p, widgets }),
  });
  expect(saved.status).toBe(200);
}

const CARD = { variant: 'status', subject: 'sensor.washer_status', progress: 'sensor.washer_progress', readings: ['sensor.kitchen_temperature', 'binary_sensor.front_door'] };

/** What a household could see of a card, read off the computed styles. */
async function readCard(page: Page, id: string) {
  return page.evaluate((widgetId) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
    if (box === null) throw new Error(`no box ${widgetId}`);
    const card = box.querySelector<HTMLElement>('.house-status');
    if (card === null) throw new Error(`no card in ${widgetId}`);
    const shown = (node: Element): boolean => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
    const state = card.querySelector<HTMLElement>('.st-state');
    const name = card.querySelector<HTMLElement>('.st-name');
    const track = card.querySelector('.st-progress');
    const fill = card.querySelector('.st-fill');
    const ring = card.querySelector('.st-ring');
    const probe = document.createElement('span');
    probe.style.color = 'var(--state-alert)';
    card.appendChild(probe);
    const alert = getComputedStyle(probe).color;
    probe.remove();
    const boxRect = box.getBoundingClientRect();
    const spilled = Array.from(card.querySelectorAll<HTMLElement>('*'))
      .filter(shown)
      .filter((node) => {
        const r = node.getBoundingClientRect();
        return r.bottom > boxRect.bottom + 0.5 || r.right > boxRect.right + 0.5;
      }).length;
    return {
      done: card.hasAttribute('data-done'),
      state: state?.textContent ?? '',
      stateColour: state === null ? '' : getComputedStyle(state).color,
      alert,
      ratio: state !== null && name !== null ? parseFloat(getComputedStyle(state).fontSize) / parseFloat(getComputedStyle(name).fontSize) : 0,
      clipped: state !== null && state.scrollWidth > state.clientWidth + 1,
      spilled,
      fill: track !== null && fill !== null ? fill.getBoundingClientRect().width / track.getBoundingClientRect().width : undefined,
      details: Array.from(card.querySelectorAll('.st-detail')).filter(shown).map((row) => row.querySelector('.st-detail-name')?.textContent ?? ''),
      ring: ring === null ? undefined : ring.getAnimations().map((a) => ({
        name: (a as CSSAnimation).animationName,
        duration: Number(a.effect?.getTiming().duration),
      })),
      picture: card.querySelector('.st-picture') !== null,
      mark: card.querySelector('.st-circle svg') !== null,
      sparkLines: card.querySelectorAll('.st-spark polyline').length,
    };
  }, id);
}

describe('the status card', () => {
  it('says its state large, at most 1.8 times its name, with its progress, its readings and nothing cut', async () => {
    await place([{ id: 'card', x: 0.05, y: 0.05, w: 0.6, h: 0.3, config: CARD }]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const card = await readCard(page, 'card');
      expect(card.done).toBe(false);
      expect(card.state).toBe('Running');
      expect(card.ratio).toBeGreaterThan(1);
      expect(card.ratio).toBeLessThanOrEqual(1.8);
      expect(card.clipped).toBe(false);
      expect(card.spilled).toBe(0);
      expect(card.fill).toBeCloseTo(0.45, 2);
      // The progress reading is the bar, not a line under it.
      expect(card.details).toEqual(['Kitchen', 'Front door']);
      expect(card.ring).toBeUndefined();
    } finally {
      await close();
    }
  }, SLOW);

  it('is loud once it says the finished words: the alert colour, and a ring that breathes only where motion is allowed', async () => {
    await place([{ id: 'card', x: 0.05, y: 0.05, w: 0.6, h: 0.3, config: { ...CARD, doneState: 'running' } }]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const card = await readCard(page, 'card');
      expect(card.done).toBe(true);
      expect(card.stateColour).toBe(card.alert);
      expect(card.ring).toEqual([{ name: 'st-ring', duration: 2400 }]);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const still = await readCard(page, 'card');
      expect(still.ring).toEqual([]);
      expect(still.done).toBe(true);
    } finally {
      await close();
    }
  }, SLOW);

  it('gives its own picture up for its mark when the picture does not arrive', async () => {
    await place([{ id: 'card', x: 0.05, y: 0.05, w: 0.6, h: 0.3, config: { variant: 'status', subject: 'person.ada', subjectPicture: true } }]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      await page.waitForFunction(() => document.querySelector('.house-status .st-picture') === null, undefined, { timeout: 10_000 });
      const card = await readCard(page, 'card');
      expect(card.picture).toBe(false);
      expect(card.mark).toBe(true);
    } finally {
      await close();
    }
  }, SLOW);
});

/** Every spark row in a box, and the tiles' heights. */
async function readSparks(page: Page, id: string) {
  return page.evaluate((widgetId) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${widgetId}"]`);
    if (box === null) throw new Error(`no box ${widgetId}`);
    const shown = (node: Element): boolean => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
    return {
      sparks: Array.from(box.querySelectorAll('.spark')).filter(shown).map((spark) => ({
        h: Math.round(spark.getBoundingClientRect().height * 10) / 10,
        lines: spark.querySelectorAll('polyline').length,
      })),
      tiles: Array.from(box.querySelectorAll('.ht-tile')).filter(shown).map((tile) => Math.round(tile.getBoundingClientRect().height * 10) / 10),
      items: Array.from(box.querySelectorAll('.hs-item')).filter(shown).map((item) => Math.round(item.getBoundingClientRect().height * 10) / 10),
      stamped: Number(box.getAttribute('data-tier-items') ?? '-1'),
      rungs: box.getAttribute('data-rungs') ?? '',
    };
  }, id);
}

describe('the day’s line', () => {
  it('is a row of one height whether or not the day has arrived, the day drawn as a line, the gap split', async () => {
    const readings = ['sensor.kitchen_temperature', 'binary_sensor.front_door'];
    await place([
      { id: 'tiles', x: 0.05, y: 0.05, w: 0.9, h: 0.25, config: { variant: 'tile', sparkline: true, readings } },
      { id: 'card', x: 0.05, y: 0.32, w: 0.6, h: 0.3, config: { ...CARD, subject: 'sensor.kitchen_temperature', sparkline: true } },
    ]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const tiles = await readSparks(page, 'tiles');
      expect(tiles.sparks).toHaveLength(2);
      // The kitchen's day has a gap, so it is two lines; the door has none.
      expect(tiles.sparks.map((s) => s.lines)).toEqual([2, 0]);
      expect(tiles.sparks[0]?.h).toBeGreaterThan(0);
      expect(tiles.sparks[0]?.h).toBe(tiles.sparks[1]?.h);
      expect(new Set(tiles.tiles).size).toBe(1);
      expect(tiles.rungs).toContain('spark');
      expect((await readCard(page, 'card')).sparkLines).toBe(2);
    } finally {
      await close();
    }
  }, SLOW);

  it('costs no tile: the same tiles with it and without, at every height, and it gives way where it would', async () => {
    const readings = ['sensor.kitchen_temperature', 'binary_sensor.front_door', 'sensor.washer_status', 'person.ada'];
    const heights = [0.05, 0.07, 0.09, 0.11, 0.13, 0.16];
    await place(
      heights.flatMap((h, index) => [
        { id: `plain-${index}`, x: 0.02, y: 0.02 + index * 0.16, w: 0.45, h, config: { variant: 'tile', readings } },
        { id: `lined-${index}`, x: 0.52, y: 0.02 + index * 0.16, w: 0.45, h, config: { variant: 'tile', readings, sparkline: true } },
      ]),
    );
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      let kept = 0;
      let given = 0;
      for (let index = 0; index < heights.length; index++) {
        const plain = await readSparks(page, `plain-${index}`);
        const lined = await readSparks(page, `lined-${index}`);
        expect(lined.tiles.length, `height ${heights[index]}`).toBe(plain.tiles.length);
        if (lined.sparks.length > 0) kept++;
        else given++;
      }
      expect(kept).toBeGreaterThan(0);
      expect(given).toBeGreaterThan(0);
    } finally {
      await close();
    }
  }, SLOW);

  it('is a width on a list reading’s line, never a row', async () => {
    const readings = ['sensor.kitchen_temperature', 'binary_sensor.front_door'];
    await place([
      { id: 'plain', x: 0.05, y: 0.05, w: 0.9, h: 0.1, config: { readings } },
      { id: 'lined', x: 0.05, y: 0.2, w: 0.9, h: 0.1, config: { readings, sparkline: true } },
    ]);
    const { page, close } = await loadWallSettled(link, PORTRAIT);
    try {
      const plain = await readSparks(page, 'plain');
      const lined = await readSparks(page, 'lined');
      expect(lined.sparks).toHaveLength(2);
      expect(lined.items).toEqual(plain.items);
    } finally {
      await close();
    }
  }, SLOW);
});

describe('the editor', () => {
  it('offers the card’s controls on the card alone, and saves its reading, its finished words and the line', async () => {
    await place([{ id: 'card', x: 0.05, y: 0.05, w: 0.6, h: 0.3, config: { variant: 'status' } }]);
    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget[data-id="card"]', { timeout: 20_000 });
      await page.locator('.le-overlay .le-widget[data-id="card"]').click();
      const subject = page.locator('[data-cfg-key="subject"] select');
      await subject.waitFor({ timeout: 10_000 });
      expect(await subject.locator('option').allTextContents()).toContain('Washer');
      await subject.selectOption('sensor.washer_status');
      const done = page.locator('[data-cfg-key="doneState"] input');
      await done.fill('  Complete  ');
      await done.press('Tab');
      await page.locator('[data-cfg-key="sparkline"] input').check();
      // A tile's state switch moves nothing on a card, so it is not offered.
      expect(await page.locator('[data-cfg-key="hideState"]').count()).toBe(0);

      // Save writes the canvas, then submits the wall's settings, which
      // reloads the page: wait for that load rather than race it.
      const saved = page.waitForEvent('load');
      await page.locator('[data-action="save"]').click();
      await saved;
      await expect
        .poll(() => {
          const row = wall.db
            .prepare(`SELECT config FROM layout_widgets WHERE id = 'card' AND orientation = 'portrait'`)
            .get() as { config: string } | undefined;
          return row === undefined ? undefined : JSON.parse(row.config);
        }, { timeout: 10_000 })
        .toMatchObject({ variant: 'status', subject: 'sensor.washer_status', doneState: 'Complete', sparkline: true });

      // Cleared to nothing but spaces is no words at all — never a save the
      // server would refuse for words that are empty.
      await page.waitForSelector('.le-overlay .le-widget[data-id="card"]', { timeout: 20_000 });
      await page.locator('.le-overlay .le-widget[data-id="card"]').click();
      await done.waitFor({ timeout: 10_000 });
      expect(await done.inputValue()).toBe('Complete');
      await done.fill('   ');
      await done.press('Tab');
      const again = page.waitForEvent('load');
      await page.locator('[data-action="save"]').click();
      await again;
      await expect
        .poll(() => {
          const row = wall.db
            .prepare(`SELECT config FROM layout_widgets WHERE id = 'card' AND orientation = 'portrait'`)
            .get() as { config: string } | undefined;
          return row === undefined ? undefined : 'doneState' in (JSON.parse(row.config) as Record<string, unknown>);
        }, { timeout: 10_000 })
        .toBe(false);
    } finally {
      await context.close();
    }
  }, SLOW);
});
