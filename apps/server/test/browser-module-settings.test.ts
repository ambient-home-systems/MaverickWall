/**
 * A Module widget's own settings (plan item M7.6), in a real editor and on a
 * real paired wall.
 *
 * The editor half drives the controls a household uses: a list, a switch, a
 * number and a reading picker drawn from the recipe's own fields, each showing
 * the install's value until it is changed, and Save writing only what differs.
 * The wall half is what only a browser shows: a widget with settings draws its
 * own panel by the handle it was given, says it is waiting until that panel's
 * first read, and is never handed the settings themselves.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { createRecipeModule, writeModuleVariantPanel } from '../src/api/external-modules.js';
import { moduleVariantKey } from '../src/api/module-variant.js';

const SLOW = 180_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const RECIPE = {
  name: 'Weather by city',
  contract: 1,
  config: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      options: [
        { value: 'london', label: 'London' },
        { value: 'york', label: 'York' },
      ],
      default: 'london',
    },
    { key: 'units', label: 'Metric units', type: 'boolean', default: 'true' },
    { key: 'days', label: 'Days', type: 'number', min: 1, max: 7, default: '3' },
    { key: 'outside', label: 'Outside temperature', type: 'ha_reading' },
  ],
  fetch: { url: 'https://example.com/w?city={city}&units={units}&days={days}&t={outside}' },
  panel: { kind: 'text', title: 'Weather', text: '{reading}' },
};

async function linkFor(wall: Installation, screenId: string): Promise<string> {
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  return found;
}

function place(wall: Installation, screenId: string, id: string, config: Record<string, unknown>, y: number): void {
  wall.db
    .prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, 'portrait', 'external', 0.05, ?, 0.9, 0.12, 100, ?, ?, ?)`,
    )
    .run(id, screenId, y, JSON.stringify(config), Date.now(), Date.now());
}

const settingsOf = (wall: Installation, id: string): unknown => {
  const row = wall.db
    .prepare(`SELECT config FROM layout_widgets WHERE id = ? AND orientation = 'portrait'`)
    .get(id) as { config: string } | undefined;
  return row === undefined ? undefined : (JSON.parse(row.config) as Record<string, unknown>)['settings'];
};

async function setUp(): Promise<{ wall: Installation; screenId: string }> {
  const wall = await install();
  installations.push(wall);
  createRecipeModule(wall.db, { id: 'wx', name: 'Weather by city', url: RECIPE.fetch.url, recipe: RECIPE, config: {} });
  wall.db
    .prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = 'wx'`)
    .run(JSON.stringify({ kind: 'text', title: 'Weather', text: 'London is grey' }), wall.now());
  wall.db
    .prepare(
      `INSERT INTO ha_entity_cache (entity_id, friendly_name, state, watched, fetched_at)
       VALUES ('sensor.outside_temp', 'Outside', '12.5', 1, ?)`,
    )
    .run(wall.now());
  const screenId = await wall.pairWall('Kitchen');
  return { wall, screenId };
}

describe('a Module widget’s own settings', () => {
  it('are set in the editor from the recipe’s own controls, and only what differs is saved', async () => {
    const { wall, screenId } = await setUp();
    place(wall, screenId, 'wx-box', { module: 'wx' }, 0.02);
    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
      const box = page.locator('.le-overlay .le-widget[data-id="wx-box"]');
      await box.waitFor({ timeout: 20_000 });
      await box.click();
      await page.locator('[data-module-settings-lead]').waitFor({ timeout: 10_000 });

      // Each control starts at the install's value.
      const city = page.locator('[data-module-setting="city"] select');
      expect(await city.inputValue()).toBe('london');
      const days = page.locator('[data-module-setting="days"] input');
      expect(await days.inputValue()).toBe('');
      expect(await days.getAttribute('placeholder')).toBe('3');
      expect(await days.getAttribute('min')).toBe('1');
      expect(await days.getAttribute('max')).toBe('7');
      const outside = page.locator('[data-module-setting="outside"] select');
      expect(await outside.locator('option').allTextContents()).toEqual(['None', 'Outside']);

      await city.selectOption('york');
      // A number the recipe would not take is no setting.
      await days.fill('9');
      await days.dispatchEvent('change');
      await outside.selectOption('sensor.outside_temp');
      // Put back to the install's value: no setting.
      const units = page.getByRole('checkbox', { name: 'Metric units' });
      expect(await units.isChecked()).toBe(true);
      await units.click();
      await units.click();

      const reloaded = page.waitForURL(/[?&]saved=/);
      await page.locator('[data-action="save"]').click();
      await reloaded;
      await expect
        .poll(() => settingsOf(wall, 'wx-box'), { timeout: 10_000 })
        .toEqual({ city: 'york', outside: 'sensor.outside_temp' });

      // Back to London: the widget follows the install again, with no settings.
      await page.locator('.le-overlay .le-widget[data-id="wx-box"]').click();
      await page.locator('[data-module-setting="city"] select').selectOption('london');
      await page.locator('[data-module-setting="outside"] select').selectOption('');
      const again = page.waitForURL(/[?&]saved=/);
      await page.locator('[data-action="save"]').click();
      await again;
      await expect.poll(() => settingsOf(wall, 'wx-box'), { timeout: 10_000 }).toBeUndefined();
    } finally {
      await context.close();
    }
  }, SLOW);

  it('draw on the wall by a handle, waiting for their own first read, never as the settings', async () => {
    const { wall, screenId } = await setUp();
    const settings = { city: 'york', outside: 'sensor.outside_temp' };
    place(wall, screenId, 'install-box', { module: 'wx' }, 0.02);
    place(wall, screenId, 'york-box', { module: 'wx', settings }, 0.16);
    const link = await linkFor(wall, screenId);

    const text = (page: import('playwright-core').Page, id: string): Promise<string | undefined> =>
      page.evaluate(
        (widgetId) => document.querySelector(`#wall .canvas .fw[data-widget-id="${widgetId}"]`)?.textContent?.trim(),
        id,
      );

    const first = await loadWallSettled(link, { width: 1080, height: 1920 });
    try {
      expect(await text(first.page, 'install-box')).toContain('London is grey');
      expect(await text(first.page, 'york-box')).toContain('Waiting for the first reading with these settings.');
      const html = await first.page.content();
      expect(html).not.toContain('sensor.outside_temp');
    } finally {
      await first.close();
    }

    writeModuleVariantPanel(
      wall.db,
      'wx',
      moduleVariantKey('wx', settings),
      { kind: 'text', title: 'Weather', text: 'York is sunny' },
      wall.now(),
    );
    const second = await loadWallSettled(link, { width: 1080, height: 1920 });
    try {
      expect(await text(second.page, 'york-box')).toContain('York is sunny');
      expect(await text(second.page, 'install-box')).toContain('London is grey');
    } finally {
      await second.close();
    }
  }, SLOW);
});
