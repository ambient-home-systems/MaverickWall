/**
 * Running a scene or a script from a real paired wall, by press-and-hold
 * (RFC 018 phase 4, OQ6).
 *
 * A scene or a script cannot be undone by tapping again, so the wall asks for
 * a hold of 600 ms — by a finger, or by holding the OK key — and a shorter
 * press sends nothing and says so. `ha-act.test.ts` holds the route; this is
 * the press itself, measured against the posts the fake house received and
 * the computed outline of the button, never a class.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

const SLOW = 180_000;
const SCENE = 'scene.movie_night';
const SCRIPT = 'script.goodnight';
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

interface Wall {
  readonly ha: FakeHa;
  readonly link: string;
}

/** A scene and a script, both marked controllable, in one acting tile box. */
async function wallWithScenes(): Promise<Wall> {
  const app = await install({ feed: true, calendars: HOUSEHOLD_CALENDARS });
  installations.push(app);
  const ha = await fakeHomeAssistant();
  expect(
    (await app.post('/admin/home-assistant/connect', {
      base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
    })).status,
  ).toBe(302);
  const at = app.now();
  const seed = (entity: string, state: string, name: string, order: number): void => {
    app.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, '{"device_class":null}', ?, NULL, ?, ?, 1, 'label_value', NULL, ?)`,
      )
      .run(entity, state, name, at - 600_000, at, order);
  };
  seed(SCENE, new Date(at - 86_400_000).toISOString(), 'Movie night', 0);
  seed(SCRIPT, 'off', 'Goodnight', 1);
  for (const entity of [SCENE, SCRIPT]) {
    expect(
      (await app.post('/admin/home-assistant/entities/control', { entity_id: entity, controllable: '1' })).status,
    ).toBe(302);
  }
  const link = await app.pairLink('Kitchen');
  const screen = (
    app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }
  ).id;
  app.db.prepare('UPDATE screens SET allow_control = 1, layout_mode = ? WHERE id = ?').run('freeform', screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
  };
  place('w-act', 'homeassistant', [0.06, 0.03, 0.88, 0.2], { variant: 'tile', tapAction: 'act' });
  place('w-cal', 'calendar', [0.06, 0.26, 0.88, 0.7], { mode: 'list', count: 4 });
  return { ha, link };
}

const runs = (ha: FakeHa): string[] =>
  ha.posts
    .filter((post) => post.path.startsWith('/api/services/') && !post.path.includes('/todo/'))
    .map((post) => `${post.path.slice('/api/services/'.length)} ${post.body}`);

/** The tile button for one reading, by the name it draws. */
async function buttonFor(page: Page, name: string): Promise<{ x: number; y: number }> {
  const centre = await page.evaluate((wanted) => {
    const tile = [...document.querySelectorAll<HTMLElement>('#wall [data-widget-id="w-act"] .ht-tile')].find(
      (one) => (one.querySelector('.ht-name')?.textContent ?? '').trim() === wanted,
    );
    if (tile === undefined) return undefined;
    const r = tile.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  expect(centre, name).toBeDefined();
  return centre!;
}

const ring = (page: Page, name: string): Promise<string> =>
  page.evaluate((wanted) => {
    const tile = [...document.querySelectorAll<HTMLElement>('#wall [data-widget-id="w-act"] .ht-tile')].find(
      (one) => (one.querySelector('.ht-name')?.textContent ?? '').trim() === wanted,
    );
    if (tile === undefined) return 'missing';
    const style = getComputedStyle(tile);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  }, name);

const wait = (page: Page, ms: number): Promise<unknown> =>
  page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);

describe('running a scene or a script from a paired wall', () => {
  it(
    'sends nothing for a tap and says to hold; a hold of 600 ms runs it once, with a ring while held',
    async () => {
      const wall = await wallWithScenes();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-hold]', { timeout: 25_000 });
        const scene = await buttonFor(page, 'Movie night');

        // A tap: down and straight up. Nothing leaves, and the box says why.
        await page.mouse.click(scene.x, scene.y);
        const note = page.locator('#wall [data-widget-id="w-act"] [role="alert"]');
        await note.waitFor({ timeout: 5_000 });
        expect((await note.textContent())?.trim()).toBe('Press and hold to run it.');
        await wait(page, 800);
        expect(runs(wall.ha)).toEqual([]);

        // A hold: the ring is up while the finger is down, and the scene runs
        // once. Measured again first — the sentence sits above the tiles.
        const again = await buttonFor(page, 'Movie night');
        await page.mouse.move(again.x, again.y);
        await page.mouse.down();
        await wait(page, 200);
        const held = await ring(page, 'Movie night');
        expect(held.startsWith('solid')).toBe(true);
        expect(runs(wall.ha)).toEqual([]);
        await wait(page, 600);
        await page.mouse.up();
        await expect.poll(() => runs(wall.ha), { timeout: 10_000 }).toEqual([
          `scene/turn_on ${JSON.stringify({ entity_id: SCENE })}`,
        ]);
        // And only once: the click that ends a long hold is not a second press.
        await wait(page, 800);
        expect(runs(wall.ha)).toHaveLength(1);
        // And the ring is gone once the hold has run.
        expect((await ring(page, 'Movie night')).startsWith('solid')).toBe(false);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'runs on the OK key held, and not on the OK key pressed',
    async () => {
      const wall = await wallWithScenes();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-hold]', { timeout: 25_000 });
        const focusScript = (): Promise<void> =>
          page.evaluate(() => {
            const tile = [...document.querySelectorAll<HTMLElement>('#wall [data-widget-id="w-act"] .ht-tile')].find(
              (one) => (one.querySelector('.ht-name')?.textContent ?? '').trim() === 'Goodnight',
            );
            tile?.focus();
          });
        await focusScript();
        await page.keyboard.press('Enter');
        await wait(page, 800);
        expect(runs(wall.ha)).toEqual([]);

        await focusScript();
        await page.keyboard.down('Enter');
        await wait(page, 750);
        await page.keyboard.up('Enter');
        await expect.poll(() => runs(wall.ha), { timeout: 10_000 }).toEqual([
          `script/turn_on ${JSON.stringify({ entity_id: SCRIPT })}`,
        ]);
        await wait(page, 800);
        expect(runs(wall.ha)).toHaveLength(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'outlives a rebuild under the finger',
    async () => {
      const wall = await wallWithScenes();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-hold]', { timeout: 25_000 });
        const scene = await buttonFor(page, 'Movie night');
        await page.mouse.move(scene.x, scene.y);
        await page.mouse.down();
        // The wall rebuilds every node while the finger is down.
        await page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());
        await wait(page, 150);
        expect((await ring(page, 'Movie night')).startsWith('solid')).toBe(true);
        await wait(page, 600);
        await page.mouse.up();
        await expect.poll(() => runs(wall.ha).length, { timeout: 10_000 }).toBe(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
