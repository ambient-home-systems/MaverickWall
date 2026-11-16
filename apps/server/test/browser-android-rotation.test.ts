/**
 * The display's answer to the Android app's one question: which way up is this
 * wall hung?
 *
 * The app draws a few screens of its own — "connecting…" when the server is
 * gone, setup when the household changes server — and on a television hung on
 * its end they are sideways unless the app knows the wall's Wall mounting. The
 * server is the only source of that fact, so the app asks the page through the
 * `window.maverickWall` bridge it already drives (`poll`, `acknowledge`), and
 * copies the answer for the moments it cannot ask.
 *
 * What matters is the cases where the honest answer is "I do not know", and
 * those are asserted beside the one where it is a number: a page that has never
 * had a manifest (the pairing form), and a page whose only manifest is the
 * server's stand-in for a database it cannot read. Answering `0` in either would
 * stand a sideways wall's own screens back up — which is the bug the app is
 * being taught to fix.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 120_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Exactly what the app evaluates: `evaluateJavascript` hands back this value. */
const ask = (page: Page): Promise<unknown> =>
  page.evaluate(() => {
    const bridge = (window as unknown as { maverickWall?: { rotation?: () => unknown } }).maverickWall;
    return bridge !== undefined && typeof bridge.rotation === 'function' ? bridge.rotation() : 'no bridge';
  });

const setRotation = (app: Installation, name: string, rotation: number): void => {
  app.db.prepare('UPDATE screens SET rotation = ?, updated_at = ? WHERE name = ?').run(rotation, Date.now(), name);
};

describe("the bridge's rotation, for the Android app", () => {
  it(
    "answers the wall's own mounting, and follows it when the household changes it",
    async () => {
      const app = await install();
      installations.push(app);
      const link = await app.pairLink('Hall');
      setRotation(app, 'Hall', 90);
      const opened = await loadWallSettled(link, { width: 1920, height: 1080 });
      try {
        const page = opened.page;
        expect(await ask(page)).toBe(90);
        // The page is drawing it, too: the answer is the turn on the glass.
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-rotation'))).toBe('90');

        // Changed on the wall's settings page; the next poll carries it.
        setRotation(app, 'Hall', 270);
        await page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());
        await page.waitForFunction(
          () => (window as unknown as { maverickWall: { rotation(): unknown } }).maverickWall.rotation() === 270,
          undefined,
          { timeout: 15_000 },
        );
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'says nothing on a page that has never had a manifest',
    async () => {
      const app = await install();
      installations.push(app);
      const context = await (await browser()).newContext({ viewport: { width: 1920, height: 1080 } });
      try {
        const page = await context.newPage();
        await page.goto(`${app.base}/`, { waitUntil: 'load' });
        await page.waitForSelector('.pair-form', { timeout: 20_000 });
        expect(await ask(page)).toBeNull();
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    "says nothing when all it holds is the server's stand-in",
    async () => {
      const app = await install();
      installations.push(app);
      const link = await app.pairLink('Landing');
      setRotation(app, 'Landing', 90);
      const context = await (await browser()).newContext({ viewport: { width: 1920, height: 1080 } });
      try {
        const page = await context.newPage();
        /*
         * Every answer marked as the stand-in, with the wall's real rotation
         * left in it. A fresh context has nothing stored, so this is a wall
         * booted during the outage: it draws what it is given, and the rotation
         * in that document must not be read as this wall's, because the real
         * stand-in carries no wall at all.
         */
        let received: unknown;
        await page.route('**/d/manifest**', async (route) => {
          const response = await route.fetch();
          if (response.status() !== 200) return route.fulfill({ response });
          const body = (await response.json()) as { notices?: unknown[]; screen?: { rotation?: number } };
          received = body.screen?.rotation;
          body.notices = [...(body.notices ?? []), { code: 'schema-degraded', level: 'error', message: 'stand-in' }];
          return route.fulfill({ response, json: body });
        });
        await page.goto(link, { waitUntil: 'load' });
        await page.waitForFunction(
          () => !/Waiting for the first update/.test(document.querySelector('#wall')?.textContent ?? ''),
          undefined,
          { timeout: 20_000 },
        );
        // The premise: the document the page drew did state a turn.
        expect(received).toBe(90);
        expect(await ask(page)).toBeNull();
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
