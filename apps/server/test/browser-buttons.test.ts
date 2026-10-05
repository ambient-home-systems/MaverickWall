/**
 * A Buttons widget on a real paired wall (RFC 018 phase 5).
 *
 * `webhook-buttons.test.ts` holds the route and the admin. This is the press a
 * household meets: a button marked pressable is a real `<button>` that runs
 * on a hold of 600 ms, a tap sends nothing and says to hold, a button nobody
 * marked is a name on a card — and the address it calls is nowhere on the
 * wall. Measured against what a real HTTP server on loopback received.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

const SLOW = 180_000;
const installations: Installation[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await shutDownBrowser();
}, TEARDOWN);

async function receiver(): Promise<{ base: string; readonly received: { method: string; path: string }[] }> {
  const state = { base: '', received: [] as { method: string; path: string }[] };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      state.received.push({ method: request.method ?? '', path: request.url ?? '' });
      response.writeHead(204);
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return state;
}

async function wallWithButtons(): Promise<{ link: string; at: Awaited<ReturnType<typeof receiver>> }> {
  const app = await install({ feed: true, calendars: HOUSEHOLD_CALENDARS });
  installations.push(app);
  const at = await receiver();
  for (const [name, path] of [['Chime', '/hooks/chime'], ['Garden lights', '/hooks/garden']] as const) {
    expect(
      (await app.post('/admin/buttons', {
        name, url: `${at.base}${path}`, allow_lan: '1', allow_http: '1',
      })).status,
    ).toBe(302);
  }
  const chime = (app.db.prepare(`SELECT id FROM webhook_targets WHERE name = 'Chime'`).get() as { id: string }).id;
  expect((await app.post(`/admin/buttons/${chime}/pressable`, { pressable: '1' })).status).toBe(302);

  const link = await app.pairLink('Hall');
  const screen = (
    app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }
  ).id;
  const stamp = app.now();
  app.db.prepare('UPDATE screens SET allow_control = 1, layout_mode = ? WHERE id = ?').run('freeform', screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), stamp, stamp);
  };
  place('w-buttons', 'buttons', [0.06, 0.03, 0.88, 0.2], { tapAction: 'act' });
  place('w-cal', 'calendar', [0.06, 0.26, 0.88, 0.7], { mode: 'list', count: 4 });
  return { link, at };
}

const centreOf = async (page: Page, name: string): Promise<{ x: number; y: number }> => {
  const centre = await page.evaluate((wanted) => {
    const node = [...document.querySelectorAll<HTMLElement>('#wall [data-widget-id="w-buttons"] .bt-button')].find(
      (one) => (one.textContent ?? '').trim() === wanted,
    );
    if (node === undefined) return undefined;
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  expect(centre, name).toBeDefined();
  return centre!;
};

const wait = (page: Page, ms: number): Promise<unknown> =>
  page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);

describe('a Buttons widget on a paired wall', () => {
  it(
    'draws a button nobody marked as a name, runs the marked one on a hold, and never shows an address',
    async () => {
      const { link, at } = await wallWithButtons();
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-buttons"] .bt-button', { timeout: 25_000 });
        const drawn = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('#wall [data-widget-id="w-buttons"] .bt-button')].map((node) => ({
            name: (node.textContent ?? '').trim(),
            tag: node.tagName,
            hold: node.hasAttribute('data-ha-hold'),
          })),
        );
        expect(drawn).toEqual([
          { name: 'Chime', tag: 'BUTTON', hold: true },
          { name: 'Garden lights', tag: 'DIV', hold: false },
        ]);
        // The address is the server's alone.
        expect(await page.evaluate(() => document.documentElement.outerHTML.includes('/hooks/'))).toBe(false);

        // A tap sends nothing and says to hold.
        const chime = await centreOf(page, 'Chime');
        await page.mouse.click(chime.x, chime.y);
        await page.locator('#wall [data-widget-id="w-buttons"] [role="alert"]').waitFor({ timeout: 5_000 });
        await wait(page, 800);
        expect(at.received).toEqual([]);

        // A hold calls it, once.
        const again = await centreOf(page, 'Chime');
        await page.mouse.move(again.x, again.y);
        await page.mouse.down();
        await wait(page, 800);
        await page.mouse.up();
        await expect.poll(() => at.received, { timeout: 10_000 }).toEqual([{ method: 'POST', path: '/hooks/chime' }]);
        await wait(page, 800);
        expect(at.received).toHaveLength(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
