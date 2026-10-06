/**
 * Timers and messages on a real paired wall (plan items M5.1–M5.2, MQ4, MD7).
 *
 * `companion-timers.test.ts` holds the routes, the store and the manifest.
 * What only a browser can say is what the wall draws from an end instant and
 * its own clock: minutes while there are minutes, the last minute in seconds
 * through a reel locked to the timer's end — read off the computed transform,
 * not off a class — still in step after the wall rebuilds itself; the words
 * and no reel where motion is not allowed; and a Clear that reaches the server
 * only on a wall allowed to, and only for a timer that has finished.
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

const SLOW = 180_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function wallWithTimers(options: { allowClear: boolean }): Promise<{ app: Installation; link: string }> {
  const app = await install({ feed: true, calendars: HOUSEHOLD_CALENDARS });
  installations.push(app);
  const now = app.now();
  const insert = app.db.prepare('INSERT INTO timers (id, label, started_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('tm-000000000001', 'Pasta', now, now + 10 * 60_000, now);
  // Forty seconds into its last minute when the page loads, give or take.
  insert.run('tm-000000000002', 'Tea', now - 60_000, now + 40_000, now);
  insert.run('tm-000000000003', 'Eggs', now - 5 * 60_000, now - 60_000, now);
  app.db
    .prepare('INSERT INTO messages (id, body, posted_at, expires_at) VALUES (?, ?, ?, ?)')
    .run('ms-000000000001', 'Back at 6', now, now + 60 * 60_000);

  const link = await app.pairLink('Kitchen');
  const screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db
    .prepare('UPDATE screens SET allow_clear = ?, layout_mode = ? WHERE id = ?')
    .run(options.allowClear ? 1 : 0, 'freeform', screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const place = (id: string, type: string, box: readonly [number, number, number, number]): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, '{}', ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], now, now);
  };
  place('w-timers', 'timers', [0.05, 0.03, 0.9, 0.3]);
  place('w-messages', 'messages', [0.05, 0.36, 0.9, 0.2]);
  place('w-cal', 'calendar', [0.05, 0.6, 0.9, 0.37]);
  return { app, link };
}

/** Which second the reel is showing, read off its computed transform and its line height. */
const shownSecond = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('#wall [data-timer="tm-000000000002"] .tm-strip');
    const line = strip?.querySelector<HTMLElement>('.tm-sec');
    if (strip === null || strip === undefined || line === null || line === undefined) return null;
    if (getComputedStyle(strip).opacity !== '1') return null;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
    return 60 - Math.round(-matrix.m42 / line.getBoundingClientRect().height);
  });

const rowText = (page: Page, key: string, part: string): Promise<string | null> =>
  page.evaluate(
    ([k, p]) => document.querySelector(`#wall [data-timer="${k}"] ${p}`)?.textContent?.trim() ?? null,
    [key, part] as const,
  );

describe('a Timers widget on a paired wall', () => {
  it(
    'says minutes, counts the last one in seconds in step with the clock, and says Done',
    async () => {
      const { link } = await wallWithTimers({ allowClear: false });
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-timer="tm-000000000002"] .tm-strip', { timeout: 25_000 });
        expect(await rowText(page, 'tm-000000000001', '.tm-left')).toBe('10 min left');
        expect(await rowText(page, 'tm-000000000003', '.tm-left')).toBe('Done');
        // Not allowed to clear, so there is nothing to press.
        expect(await page.locator('#wall [data-timer-clear]').count()).toBe(0);

        // The last minute: the reel shows and the words under it do not.
        const first = await shownSecond(page);
        const firstAt = Date.now();
        expect(first).not.toBeNull();
        expect(first!).toBeGreaterThan(15);
        expect(first!).toBeLessThanOrEqual(40);
        expect(
          await page.evaluate(
            () => getComputedStyle(document.querySelector('#wall [data-timer="tm-000000000002"] .tm-still')!).opacity,
          ),
        ).toBe('0');

        // Across a rebuild: the wall redraws every fifteen seconds, and the
        // reel must carry on from the right second rather than start again.
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 16_000)));
        const second = await shownSecond(page);
        const elapsed = Math.round((Date.now() - firstAt) / 1000);
        expect(second).not.toBeNull();
        expect(Math.abs(first! - second! - elapsed)).toBeLessThanOrEqual(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'shows the words and no number where motion is not allowed',
    async () => {
      const { link } = await wallWithTimers({ allowClear: false });
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForSelector('#wall [data-timer="tm-000000000002"] .tm-still', { timeout: 25_000 });
        const seen = await page.evaluate(() => {
          const row = document.querySelector('#wall [data-timer="tm-000000000002"]')!;
          return {
            still: getComputedStyle(row.querySelector('.tm-still')!).opacity,
            reel: getComputedStyle(row.querySelector('.tm-strip')!).opacity,
            words: row.querySelector('.tm-still')!.textContent,
          };
        });
        expect(seen).toEqual({ still: '1', reel: '0', words: 'Under a minute' });
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'clears a finished timer and a message on a wall allowed to, and never offers a running one',
    async () => {
      const { app, link } = await wallWithTimers({ allowClear: true });
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-timer-clear]', { timeout: 25_000 });
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll('#wall [data-timer-clear]')].map((node) => node.getAttribute('data-timer-clear')),
          ),
        ).toEqual(['tm-000000000003']);
        expect(await page.locator('#wall .ms-text').textContent()).toBe('Back at 6');

        await page.locator('#wall [data-timer-clear="tm-000000000003"]').click();
        await expect
          .poll(() => page.locator('#wall [data-timer="tm-000000000003"]').count(), { timeout: 10_000 })
          .toBe(0);
        expect(app.db.prepare(`SELECT id FROM timers WHERE id = 'tm-000000000003'`).get()).toBeUndefined();

        await page.locator('#wall [data-message-clear="ms-000000000001"]').click();
        await expect.poll(() => page.locator('#wall .ms-row').count(), { timeout: 10_000 }).toBe(0);
        expect(app.db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
        // The running timers are untouched.
        expect(app.db.prepare('SELECT count(*) AS n FROM timers').get()).toEqual({ n: 2 });
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
