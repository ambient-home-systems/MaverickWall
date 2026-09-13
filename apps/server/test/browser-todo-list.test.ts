/**
 * A Home Assistant to-do list on a real paired wall (RFC 012 phase 1).
 *
 * The unit tests hold the module to the fake house and the renderer to a
 * fixture; what neither can see is whether any of it reaches the glass. This
 * pairs a wall through the harness, connects a fake Home Assistant through the
 * real form, adds a list through the real form, and reads what the wall's own
 * renderer drew — with the household's calendars beside it, because a wall is
 * never one widget. Then it disconnects Home Assistant and reads the wall
 * again, which is the case rule nine is about: the typed checklist is still
 * there, the list-backed box is gone rather than drawing a list that will never
 * refresh, and the editor says why.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  install,
  loadWallSettled,
  settleWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 120_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

/** Every To-do box on the wall: its id, and each row's words and done state. */
async function todoBoxes(page: Page): Promise<Record<string, { text: string; done: boolean }[]>> {
  return page.evaluate(() => {
    const out: Record<string, { text: string; done: boolean }[]> = {};
    for (const box of document.querySelectorAll<HTMLElement>('#wall .canvas > .fw-todo')) {
      out[box.dataset['widgetId'] ?? ''] = [...box.querySelectorAll<HTMLElement>('.td-row')].map((row) => ({
        text: (row.querySelector('.td-text')?.textContent ?? '').trim(),
        done: row.classList.contains('is-done'),
      }));
    }
    return out;
  });
}

/** Every widget box drawn on the wall, by id. */
const drawnIds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#wall .canvas > .fw')].map((box) => box.dataset['widgetId'] ?? ''),
  );

describe('a to-do list on a paired wall', () => {
  it(
    'draws the open items, hides the ticked ones unless asked, leaves a typed list alone, and yields when Home Assistant goes',
    async () => {
      const wall = await install({ feed: true, calendars: HOUSEHOLD_CALENDARS });
      installations.push(wall);
      const ha = await fakeHomeAssistant();

      // The real forms, in the order a household would use them.
      const connected = await wall.post('/admin/home-assistant/connect', {
        base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
      });
      expect(connected.status).toBe(302);
      const listed = await wall.post('/admin/home-assistant/lists', { entity_id: 'todo.shopping', label: 'Shopping' });
      expect(listed.headers.get('location')).toBe('/admin/home-assistant?saved=todo-list-added');

      // A wall, and a canvas the way the editor's save writes one: a list-backed
      // box, one asking for the ticked items too, a typed checklist beside them,
      // and the household's own calendar so the never-empty guard stands down.
      const link = await wall.pairLink('Kitchen');
      const screen = (wall.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      const at = wall.now();
      wall.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
      wall.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
        wall.db
          .prepare(
            `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
             VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
      };
      place('w-list', 'todo', [0.05, 0.02, 0.9, 0.2], { list: 'todo.shopping' });
      place('w-done', 'todo', [0.05, 0.24, 0.9, 0.2], { list: 'todo.shopping', showDone: true });
      place('w-typed', 'todo', [0.05, 0.46, 0.9, 0.16], { items: ['Call the plumber', 'Return the library books'] });
      place('w-cal', 'calendar', [0.05, 0.64, 0.9, 0.34], { mode: 'list', count: 6 });

      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const boxes = await todoBoxes(page);

        // The list's open items — both Milks, since they are two items — and
        // not the completed Bread.
        expect(boxes['w-list']).toEqual([
          { text: 'Milk', done: false },
          { text: 'Milk', done: false },
        ]);
        // With showDone, the ticked item comes back, marked.
        expect(boxes['w-done']).toEqual([
          { text: 'Milk', done: false },
          { text: 'Milk', done: false },
          { text: 'Bread', done: true },
        ]);
        // The typed checklist on the same canvas is exactly the typed lines.
        expect(boxes['w-typed']).toEqual([
          { text: 'Call the plumber', done: false },
          { text: 'Return the library books', done: false },
        ]);
        // And the calendar drew beside them, so this is a wall and not a fixture.
        expect(await drawnIds(page)).toEqual(expect.arrayContaining(['w-list', 'w-done', 'w-typed', 'w-cal']));
        // The manifest the wall drew from carries no entity id.
        const manifestText = await page.evaluate(async () => (await fetch('d/manifest')).text());
        expect(manifestText).not.toContain('todo.shopping');

        // Home Assistant goes. The list-backed boxes are left out; the typed one stays.
        const disconnected = await wall.post('/admin/home-assistant/disconnect', {});
        expect(disconnected.status).toBe(302);
        await page.reload({ waitUntil: 'load' });
        await settleWall(page);
        await page.waitForFunction(
          () => !document.querySelector('#wall .canvas > .fw[data-widget-id="w-list"]'),
          undefined,
          { timeout: 20_000 },
        );
        const after = await drawnIds(page);
        expect(after).toEqual(expect.arrayContaining(['w-typed', 'w-cal']));
        expect(after).not.toContain('w-list');
        expect(after).not.toContain('w-done');
        expect((await todoBoxes(page))['w-typed']?.map((row) => row.text)).toEqual([
          'Call the plumber',
          'Return the library books',
        ]);
      } finally {
        await opened.close();
      }

      // And the editor says why, per box: the two naming the list are flagged
      // and the typed one is not — which a type-keyed flag could not express.
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        const flags = await page.evaluate(() => {
          const out: Record<string, { flagged: boolean; aria: string }> = {};
          for (const box of document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')) {
            out[box.dataset['id'] ?? ''] = {
              flagged: box.classList.contains('is-not-drawn'),
              aria: box.getAttribute('aria-label') ?? '',
            };
          }
          return out;
        });
        expect(flags['w-list']?.flagged).toBe(true);
        expect(flags['w-done']?.flagged).toBe(true);
        expect(flags['w-typed']?.flagged).toBe(false);
        expect(flags['w-cal']?.flagged).toBe(false);
        expect(flags['w-list']?.aria).toMatch(/not on the wall\. .*Home Assistant/);
        // A one-view type carries no view suffix in its name.
        expect(flags['w-typed']?.aria).toBe('To-do widget');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
