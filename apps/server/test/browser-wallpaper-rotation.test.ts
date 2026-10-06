/**
 * Rotating wallpapers and Next picture on a real wall (plan items M4.10, M1.4).
 *
 * `wallpaper-rotation.test.ts` holds the arithmetic, the schema and the route.
 * What only a browser can say: that the editor's picker offers a rotation and
 * saves it for both orientations; that a wall draws the picture its own clock
 * says is due — read off the canvas's own background, not off a class — and
 * that pressing Next picture moves the glass on to the one after it.
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
import { rotationIndex, rotationSteps } from '../src/api/picture-rotation.js';
import { rotationPictures } from '../src/wallpapers.js';

const SLOW = 180_000;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

function setBackground(json: string | null): void {
  wall.db
    .prepare('UPDATE screens SET layout_background = ?, layout_landscape_background = ?, picture_pressed_at = NULL, picture_step = NULL WHERE id = ?')
    .run(json, json, screenId);
}

/** Which wallpaper the wall's canvas is drawing, by the id its file name starts with. */
const drawn = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('#wall .canvas');
    return /wallpapers\/([a-z0-9-]+)-\d{3,4}\./.exec(canvas?.style.backgroundImage ?? '')?.[1];
  });

describe('rotating wallpapers', () => {
  it(
    'are offered by the picker as a collection and an interval, and saved for both orientations',
    async () => {
      setBackground(null);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await page.click('.le-background-btn');
        await page.selectOption('.le-bg select', 'rotation');
        // Only collections with something to rotate between: paper and
        // textures has no dark picture at all, so it is not offered here.
        const offered = await page.$$eval('[data-rotation-collection] option', (options) =>
          options.map((o) => (o as HTMLOptionElement).value),
        );
        expect(offered).toEqual(['dark:all', 'dark:gradient', 'dark:contour', 'dark:geometric', 'dark:landscape', 'dark:seasonal', 'dark:fun']);
        await page.selectOption('[data-rotation-collection]', 'dark:gradient');
        await page.selectOption('[data-rotation-every]', '15');
        const strip = await page.$$eval('.le-rotation [role="listitem"] .le-wp-name', (names) => names.map((n) => n.textContent));
        expect(strip).toEqual(rotationPictures('gradient', 'dark').map((one) => one.name));
        // The preview draws one of them: the one due now.
        const previewed = await page.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot?.querySelector<HTMLElement>('.canvas');
          return /wallpapers\/([a-z0-9-]+)-\d{3,4}\./.exec(canvas?.style.backgroundImage ?? '')?.[1];
        });
        expect(rotationPictures('gradient', 'dark').map((one) => one.id)).toContain(previewed);

        await Promise.all([page.waitForNavigation({ timeout: 20_000 }), page.click('[data-action="save"]')]);
        const stored = wall.db
          .prepare('SELECT layout_background AS p, layout_landscape_background AS l FROM screens WHERE id = ?')
          .get(screenId) as { p: string; l: string };
        const expected = { type: 'rotation', collection: 'gradient', tone: 'dark', every: 15 };
        expect(JSON.parse(stored.p)).toEqual(expected);
        expect(JSON.parse(stored.l)).toEqual(expected);

        // On a light theme, the light collections — and not the two that hold
        // one light picture each (contour lines and geometric), which would be
        // a rotation that never changes. Only a light wall can show that: every
        // dark collection holds none or at least two.
        setBackground(null);
        wall.db.prepare(`UPDATE screens SET theme = 'household' WHERE id = ?`).run(screenId);
        try {
          await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
          await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
          await page.click('.le-background-btn');
          await page.selectOption('.le-bg select', 'rotation');
          const light = await page.$$eval('[data-rotation-collection] option', (options) =>
            options.map((o) => (o as HTMLOptionElement).value),
          );
          expect(light).toEqual(['light:all', 'light:gradient', 'light:texture', 'light:landscape', 'light:seasonal']);
        } finally {
          wall.db.prepare(`UPDATE screens SET theme = 'panels' WHERE id = ?`).run(screenId);
        }
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'draw the picture due by the wall’s clock, and move on to the next one when Next picture is pressed',
    async () => {
      setBackground(JSON.stringify({ type: 'rotation', collection: 'all', tone: 'dark', every: 5 }));
      const pictures = rotationPictures('all', 'dark').map((one) => one.id);
      const due = (at: number): string =>
        pictures[rotationIndex(pictures.length, rotationSteps(5, at, 'Europe/London', undefined, 0))]!;
      const before = due(wall.now());
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await expect.poll(() => drawn(page), { timeout: 15_000 }).not.toBeUndefined();
        // Either side of a five-minute boundary the load might have straddled.
        expect([before, due(wall.now())]).toContain(await drawn(page));

        expect((await wall.post(`/admin/screens/${screenId}/next-picture`, {})).status).toBe(302);
        const step = (wall.db.prepare('SELECT picture_step AS s FROM screens WHERE id = ?').get(screenId) as { s: number }).s;
        const next = pictures[rotationIndex(pictures.length, step)]!;
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await expect.poll(() => drawn(page), { timeout: 15_000 }).toBe(next);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
