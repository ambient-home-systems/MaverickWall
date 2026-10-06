/**
 * An Environment widget on a real paired wall and in the editor (plan item M5.6).
 *
 * The readings are real answers — London's air from the air-quality service
 * and Washington's forecast with its sunlight — moved to the harness's now and
 * written into the cache the weather panel reads, and two Home Assistant
 * readings in the cache the house panel reads. What is measured: the tiles a
 * household asked for and only those, in their order, the sensors it named
 * and no others, and a box that holds fewer tiles drawing fewer whole ones
 * rather than cutting one. Then the air-quality switch: off, and the air's
 * tiles go while the wind's stay.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { TEARDOWN, browser, equipHousehold, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { parseAirQuality, parseOpenMeteo } from '../src/modules/weather/open-meteo.js';

const SLOW = 180_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const real = (name: string): string => readFileSync(join(HERE, 'fixtures', 'open-meteo', 'real', name), 'utf8');

let app: Installation;
let link: string;
let screen: string;

beforeAll(async () => {
  app = await install();
  const at = app.now();
  equipHousehold(app.db, at);
  app.db.prepare(`UPDATE household_settings SET weather_units = 'imperial', air_quality_enabled = 1 WHERE id = 'singleton'`).run();
  const air = { ...parseAirQuality(real('air-pollutants-london.json'), 'eu')!, observedAt: at - 20 * 60_000, pollen: { birch: 120.5 } };
  const parts = parseOpenMeteo(real('forecast-dc-solar.json'), {
    now: Date.parse('2026-10-06T19:05:00Z'),
    units: 'imperial',
    todayIso: '2026-10-06',
    limit: 5,
  });
  const current = { ...parts.current!, observedAt: at - 10 * 60_000 };
  const write = (key: string, payload: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
         VALUES (?, 'openmeteo', ?, ?, ?, NULL)
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      )
      .run(key.replace(/[^a-z0-9]/gi, ''), key, JSON.stringify(payload), at);
  };
  write('openmeteo:current', { reading: current });
  write('openmeteo:air', { air });
  app.db.prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`).run('http://127.0.0.1:1/api', at);
  for (const [order, [entity, state, name, unit]] of [
    ['sensor.indoor_co2', '612', 'Indoor CO2', 'ppm'],
    ['sensor.garden_temperature', '14.2', 'Garden', '°C'],
  ].entries()) {
    app.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, '{"device_class":null}', ?, ?, ?, ?, 1, 'label_value', NULL, ?)`,
      )
      .run(entity, state, name, unit, at, at, order);
  }
  link = await app.pairLink('Kitchen');
  screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db.prepare('UPDATE screens SET layout_mode = ? WHERE id = ?').run('freeform', screen);
}, SLOW);

afterAll(async () => {
  await app.dispose();
  await shutDownBrowser();
}, TEARDOWN);

function place(widgets: readonly { id: string; x?: number; y: number; w?: number; h: number; config: object }[]): void {
  const stamp = app.now();
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ?`).run(screen);
  for (const one of widgets) {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', 'environment', ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(one.id, screen, one.x ?? 0.05, one.y, one.w ?? 0.9, one.h, JSON.stringify(one.config), stamp, stamp);
  }
}

const box = (id: string): string => `#wall .canvas .fw[data-widget-id="${id}"]`;

const tilesOf = (page: Page, id: string) =>
  page.$$eval(`${box(id)} .env-tile`, (nodes) =>
    nodes.map((node) => ({
      tile: node.getAttribute('data-tile'),
      label: node.querySelector('.env-label')?.textContent,
      value: node.querySelector('.env-num')?.textContent,
      unit: node.querySelector('.env-unit')?.textContent ?? undefined,
      detail: node.querySelector('.env-detail')?.textContent ?? undefined,
    })),
  );

describe('the environment on the wall', () => {
  it(
    'draws the tiles asked for, in their order, and the sensors named, and no others',
    async () => {
      place([
        { id: 'e-default', y: 0.02, h: 0.3, config: {} },
        {
          id: 'e-chosen',
          y: 0.35,
          h: 0.3,
          config: { envFields: ['wind', 'solar', 'no2'], readings: ['sensor.indoor_co2'] },
        },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        expect(await tilesOf(page, 'e-default')).toEqual([
          { tile: 'aqi', label: 'Air quality (EU)', value: '68', detail: 'Poor' },
          { tile: 'pm25', label: 'PM2.5', value: '12', unit: 'µg/m³' },
          { tile: 'pollen', label: 'Pollen', value: 'Birch', detail: 'High' },
          { tile: 'uv', label: 'UV', value: '0', detail: 'Low' },
          { tile: 'wind', label: 'Wind', value: '4', unit: 'mph', detail: 'W' },
        ]);
        // Its own order, whatever order the config names them in; and the one sensor named.
        expect((await tilesOf(page, 'e-chosen')).map((tile) => [tile.tile, tile.label])).toEqual([
          ['no2', 'NO₂'],
          ['solar', 'Sunlight'],
          ['wind', 'Wind'],
          ['sensor', 'Indoor CO2'],
        ]);
        expect(await page.textContent(`${box('e-chosen')} [data-tile="solar"] .env-num`)).toBe('639');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'keeps only the whole tiles a smaller box holds, in its order, and lays more across a wider one',
    async () => {
      const all = { envFields: ['aqi', 'pm25', 'pm10', 'ozone', 'no2', 'pollen', 'uv', 'solar', 'wind'] };
      place([
        { id: 'e-wide', y: 0.02, h: 0.12, config: all },
        { id: 'e-short', x: 0.05, y: 0.2, w: 0.4, h: 0.11, config: all },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const read = (id: string) =>
          page.evaluate((sel) => {
            const root = document.querySelector(sel) as HTMLElement;
            const room = (root.querySelector('.env') as HTMLElement).getBoundingClientRect();
            const tiles = [...root.querySelectorAll<HTMLElement>('.env-tile')];
            return {
              keys: tiles.map((tile) => tile.getAttribute('data-tile')),
              columns: new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
              inside: tiles.every((tile) => tile.getBoundingClientRect().bottom <= room.bottom + 0.5),
            };
          }, box(id));
        const wide = await read('e-wide');
        const short = await read('e-short');
        expect(wide.inside && short.inside).toBe(true);
        expect(wide.columns).toBeGreaterThan(short.columns);
        expect(short.keys.length).toBeGreaterThan(0);
        expect(short.keys.length).toBeLessThan(9);
        // The first ones, in the household's order: a shorter box gives up the end of the list.
        expect(short.keys).toEqual(['aqi', 'pm25', 'pm10', 'ozone', 'no2', 'pollen', 'uv', 'solar', 'wind'].slice(0, short.keys.length));
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'loses the air’s tiles and keeps the wind’s when air quality is switched off',
    async () => {
      app.db.prepare(`UPDATE household_settings SET air_quality_enabled = 0 WHERE id = 'singleton'`).run();
      try {
        place([{ id: 'e-off', y: 0.02, h: 0.3, config: {} }]);
        const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
        try {
          expect((await tilesOf(opened.page, 'e-off')).map((tile) => tile.tile)).toEqual(['uv', 'wind']);
        } finally {
          await opened.close();
        }
      } finally {
        app.db.prepare(`UPDATE household_settings SET air_quality_enabled = 1 WHERE id = 'singleton'`).run();
      }
    },
    SLOW,
  );
});

describe('the environment in the editor', () => {
  it(
    'offers every reading and the sensors, and saves what was ticked',
    async () => {
      place([{ id: 'e-edit', y: 0.05, h: 0.3, config: {} }]);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await app.signIn(editor);
        await editor.goto(`${app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.click('.insp-tab:has-text("Content")');
        const field = editor.locator('.le-cfg-field[data-cfg-key="envFields"]');
        await field.locator('label:has-text("PM2.5") input').uncheck();
        await field.locator('label:has-text("Ozone") input').check();
        await editor.locator('.le-cfg-field[data-cfg-key="readings"] label:has-text("Garden") input').check();
        /*
         * Read off the air's tiles and the sensor's only: the preview judges the
         * current conditions' age by the browser's clock, which under the
         * harness is hours from the server's pinned one, so the wind is left
         * out there as stale — on a real install the two clocks agree.
         */
        const preview = () =>
          editor.evaluate(() =>
            [...(document.querySelector('.le-preview')?.shadowRoot?.querySelectorAll('.env-tile') ?? [])].map((tile) =>
              tile.getAttribute('data-tile'),
            ),
          );
        await expect.poll(preview).toContain('ozone');
        expect(await preview()).toContain('sensor');
        expect(await preview()).not.toContain('pm25');
        await Promise.all([editor.waitForNavigation({ timeout: 20_000 }), editor.click('[data-action="save"]')]);
        const stored = app.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'e-edit'`).get() as { config: string };
        expect(JSON.parse(stored.config)).toEqual({
          envFields: ['aqi', 'ozone', 'pollen', 'uv', 'wind'],
          readings: ['sensor.garden_temperature'],
        });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
