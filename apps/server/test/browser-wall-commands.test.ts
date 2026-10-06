/**
 * Telling a real wall what to do from elsewhere (plan items M1.2, M1.3, M2.3).
 *
 * `wall-commands.test.ts` holds the routes and what the manifest carries. What
 * only a browser can say is what the wall does with it: draws another wall's
 * layout while it is lent and goes back to its own at the stated time **with
 * the server unreachable** — the one case the server cannot help with, and the
 * reason the time travels with the layout — and reloads once when asked, and
 * not again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 180_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function twoWalls(): Promise<{ app: Installation; link: string; hall: string; kitchen: string }> {
  const app = await install();
  installations.push(app);
  const kitchen = await app.pairWall('Kitchen');
  const link = await app.pairLink('Hall');
  const hall = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  const stamp = app.now();
  for (const [screen, type, config] of [
    [hall, 'clock', {}],
    [kitchen, 'notes', { text: 'Party time' }],
  ] as const) {
    app.db.prepare('UPDATE screens SET layout_mode = ? WHERE id = ?').run('freeform', screen);
    app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ?`).run(screen);
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, 0.1, 0.1, 0.8, 0.5, 0, ?, ?, ?)`,
      )
      .run(`${screen}-w`, screen, type, JSON.stringify(config), stamp, stamp);
  }
  return { app, link, hall, kitchen };
}

/** The wall polls now, as it does when a screen wakes — rather than waiting up to a minute. */
const pollNow = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

const wallSays = (page: Page, words: string): Promise<boolean> =>
  page.evaluate((w) => (document.querySelector('#wall')?.textContent ?? '').includes(w), words);

describe('a wall told what to do from elsewhere', () => {
  it(
    'draws another wall’s layout while it is lent, and goes back to its own at the time with no server',
    async () => {
      const { app, link, kitchen } = await twoWalls();
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        expect(await wallSays(page, 'Party time')).toBe(false);

        // Lent for twenty seconds of the wall's own clock.
        const until = app.now() + 20_000;
        app.db
          .prepare(`INSERT INTO layout_override (id, screen_id, until, created_at) VALUES ('singleton', ?, ?, ?)`)
          .run(kitchen, until, app.now());
        await pollNow(page);
        await expect.poll(() => wallSays(page, 'Party time'), { timeout: 10_000 }).toBe(true);

        // Now the server is gone: every poll fails, so nothing can tell the wall
        // the time is up but the time it was given.
        let asked = 0;
        await page.route('**/d/manifest**', (route) => {
          asked += 1;
          return route.abort('connectionrefused');
        });
        await expect.poll(() => wallSays(page, 'Party time'), { timeout: 45_000, interval: 1_000 }).toBe(false);
        // And it was its own clock that did it, not an answer it got.
        expect(app.now()).toBeGreaterThanOrEqual(until);
        expect(asked).toBeLessThanOrEqual(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'reloads once when asked, and not again',
    async () => {
      const { app, link, hall } = await twoWalls();
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.evaluate(() => {
          (window as unknown as { marker?: string }).marker = 'before';
        });
        // Nothing asked yet: a poll leaves the page alone.
        await pollNow(page);
        await page.waitForTimeout(1_500);
        expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('before');

        expect((await app.post(`/admin/screens/${hall}/refresh`, {})).status).toBe(302);
        await pollNow(page);
        await page.waitForFunction(() => (window as unknown as { marker?: string }).marker === undefined, undefined, {
          timeout: 15_000,
        });
        await page.waitForSelector('#wall .fw', { timeout: 25_000 });

        // The reloaded page started after the request, so it has nothing to reload for.
        await page.evaluate(() => {
          (window as unknown as { marker?: string }).marker = 'after';
        });
        await pollNow(page);
        await page.waitForTimeout(2_000);
        await pollNow(page);
        await page.waitForTimeout(2_000);
        expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('after');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
