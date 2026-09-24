/**
 * A Home Assistant widget that shows some readings keeps them through a rename
 * (P1.3), measured on a real paired wall.
 *
 * The widget used to store the readings it showed by **label**, because the
 * label was the only name the manifest carried — so renaming a reading on the
 * Home Assistant screen took it off every widget that had picked it, silently:
 * the box drew the readings it still matched, or nothing. It stores the entity
 * id now, which a rename cannot touch, and the wall receives a handle in its
 * place (`displayConfig`, `haReadingHandle`) because rule 12 says it never
 * receives an entity id.
 *
 * Asked of the glass rather than of the manifest, because the manifest can be
 * right and the wall wrong — the wall matches the handle it is sent against
 * the handle each reading carries, and a mistake in either half is a box with
 * nothing in it that no server-side test can see. A reading counts only when
 * a household could see it: not `display: none`, and a rect with real size.
 *
 * Two boxes, so the two ways a selection is stored are both on the wall: one
 * naming an entity id, which is what the editor writes now, and one naming a
 * label, which is what every widget saved before this names — and which no
 * migration rewrites, because the server reads a label that is a current
 * reading's as that reading.
 *
 * Checked by reverting each half: the wall filtering on the label again leaves
 * the id box empty before any rename, and the server passing `readings` through
 * unrewritten leaves it empty too (an entity id matches no handle) — both red
 * here, the second also red in `homeassistant.test.ts` for putting the id in
 * the document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

/** Long: this boots a server and a browser context, twice over. */
const SLOW = 180_000;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install();
  /*
   * Two readings straight into the cache the house panel reads, the way
   * `browser-widget-tiers` seeds eight: the poll is the Home Assistant suite's
   * subject, and this file's is what the wall does with the rows once they are
   * there. Nothing answers at the address — a poll that runs records its error
   * and leaves the rows alone, which is rule nine and costs this file nothing.
   */
  wall.db
    .prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`)
    .run('http://127.0.0.1:1/api', wall.now());
  const rows = [
    ['sensor.kitchen_temperature', '19.4', 'Kitchen', '°C'],
    ['binary_sensor.freezer_door', 'off', 'Freezer door', null],
  ] as const;
  let order = 0;
  for (const [id, state, name, unit] of rows) {
    wall.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, '{}', ?, ?, ?, ?, 1, 'label_value', NULL, ?)`,
      )
      .run(id, state, name, unit, wall.now(), wall.now(), order++);
  }
  link = await wall.pairLink('Kitchen');
  screenId = (
    wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
  for (const orientation of ['portrait', 'landscape'] as const) {
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: [
        // The editor's spelling since P1.3: the entity id.
        {
          id: `by-id-${orientation}`, type: 'homeassistant', x: 0, y: 0, w: 1, h: 0.5, z: 0,
          config: { readings: ['sensor.kitchen_temperature'] },
        },
        // Every widget saved before it: the label the household saw.
        {
          id: `by-label-${orientation}`, type: 'homeassistant', x: 0, y: 0.5, w: 1, h: 0.5, z: 1,
          config: { readings: ['Freezer door'] },
        },
      ],
      background: null,
    });
  }
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** The labels a box draws that a household could see, by the box's widget id prefix. */
async function labelsIn(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate((wanted) => {
    const box = [...document.querySelectorAll('#wall .canvas .fw')].find((node) =>
      ((node as HTMLElement).dataset['widgetId'] ?? '').startsWith(wanted),
    );
    if (!(box instanceof HTMLElement)) return [];
    return [...box.querySelectorAll('.hs-item')]
      .filter((item) => {
        const style = getComputedStyle(item);
        const rect = item.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })
      .map((item) => (item.querySelector('.hs-label')?.textContent ?? '').trim());
  }, prefix);
}

describe('a Home Assistant widget that shows some readings', () => {
  it(
    'draws the one it picked by entity id, and the one it picked by label',
    async () => {
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        expect(await labelsIn(page, 'by-id-')).toEqual(['Kitchen']);
        expect(await labelsIn(page, 'by-label-')).toEqual(['Freezer door']);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'keeps drawing a reading after it is renamed',
    async () => {
      /*
       * The rename a household makes: the Readings screen's own form, which
       * sets the label on an entity already watched. Through the real route,
       * with a session, rather than an UPDATE behind it.
       */
      const renamed = await wall.post('/admin/home-assistant/entities', {
        entity_id: 'sensor.kitchen_temperature',
        label: 'Cooking',
        display_mode: 'label_value',
      });
      expect(renamed.status).toBe(302);
      expect(
        (wall.db.prepare(`SELECT label FROM ha_entity_cache WHERE entity_id = 'sensor.kitchen_temperature'`).get() as {
          label: string;
        }).label,
      ).toBe('Cooking');

      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        // The whole fix: the new name, still on the widget that picked it.
        expect(await labelsIn(page, 'by-id-')).toEqual(['Cooking']);
        // And nothing leaked into the other box by the rename.
        expect(await labelsIn(page, 'by-label-')).toEqual(['Freezer door']);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the editor', () => {
  it(
    'ticks a reading by entity id, previews exactly it, and saves the id',
    async () => {
      /*
       * The picker's half, in the editor a household uses. It used to offer
       * and write labels; it offers the watched readings by entity id now, and
       * the live preview — the wall's own renderer over the real house panel —
       * has to draw the box by the handle the server would send, which the
       * editor substitutes from what the server handed the picker. A picker
       * writing labels saves the wrong thing; a preview not substituting draws
       * an empty box for a choice that will work on the wall. Both are read
       * back here: the preview's drawn readings, and the stored row.
       */
      for (const orientation of ['portrait', 'landscape'] as const) {
        replaceLayout(wall.db, screenId, orientation, {
          mode: 'freeform',
          aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
          widgets: [{ id: `pick-${orientation}`, type: 'homeassistant', x: 0, y: 0, w: 1, h: 1, z: 0, config: {} }],
          background: null,
        });
      }
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.on('dialog', (dialog) => void dialog.accept());
      try {
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget[data-id="pick-portrait"]', { timeout: 20_000 });
        await page.locator('.le-overlay .le-widget[data-id="pick-portrait"]').click();

        const choices = page.locator('.le-cfg-check');
        await choices.first().waitFor({ timeout: 10_000 });
        // Two watched readings, offered by the name the wall draws.
        const offered = (await choices.allTextContents()).map((text) => text.trim());
        expect(offered).toHaveLength(2);
        expect(offered).toContain('Freezer door');
        await page.locator('.le-cfg-check', { hasText: 'Freezer door' }).locator('input').check();

        // The preview redraws on a short debounce; wait for it to agree.
        await page.waitForFunction(
          () => {
            const box = document
              .querySelector<HTMLElement>('.le-preview')
              ?.shadowRoot?.querySelector('[data-widget-id="pick-portrait"]');
            return box !== null && box !== undefined && box.querySelectorAll('.hs-item').length === 1;
          },
          undefined,
          { timeout: 20_000 },
        );
        const previewed = await page.evaluate(() =>
          [
            ...(document
              .querySelector<HTMLElement>('.le-preview')
              ?.shadowRoot?.querySelectorAll('[data-widget-id="pick-portrait"] .hs-item') ?? []),
          ]
            .filter((item) => {
              const rect = item.getBoundingClientRect();
              return getComputedStyle(item).display !== 'none' && rect.width > 0 && rect.height > 0;
            })
            .map((item) => (item.querySelector('.hs-label')?.textContent ?? '').trim()),
        );
        expect(previewed).toEqual(['Freezer door']);

        const saved = await page.evaluate(() =>
          (window as unknown as { mwEditor: { saveCurrent(): Promise<{ ok: boolean }> } }).mwEditor.saveCurrent(),
        );
        expect(saved.ok).toBe(true);
        const stored = wall.db
          .prepare(`SELECT config FROM layout_widgets WHERE id = 'pick-portrait'`)
          .get() as { config: string };
        expect(JSON.parse(stored.config).readings).toEqual(['binary_sensor.freezer_door']);
      } finally {
        await page.close({ runBeforeUnload: false });
        await context.close();
      }
    },
    SLOW,
  );
});
