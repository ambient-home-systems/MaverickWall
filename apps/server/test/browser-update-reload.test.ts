/**
 * A wall reloading itself after the server is updated (plan item M1.5), on a
 * real paired wall in a real Chromium.
 *
 * The update is made by rewriting the `x-app-version` the server's real answers
 * carry, which is exactly what a wall sees when the container under it has been
 * replaced: the same document, from a release its page did not come from. The
 * wall must reload once, and — because the disagreement goes on, as it would
 * behind a proxy caching the old page — not again.
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

const pollNow = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
const marker = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as unknown as { marker?: string }).marker);
const mark = (page: Page, value: string): Promise<void> =>
  page.evaluate((v) => {
    (window as unknown as { marker?: string }).marker = v;
  }, value);

describe('a wall after the server is updated', () => {
  it(
    'reloads once when the release answering is not the one that served its page, and not again',
    async () => {
      const app = await install();
      installations.push(app);
      const link = await app.pairLink('Kitchen');
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const own = await page.evaluate(() => document.querySelector('meta[name="mw-version"]')?.getAttribute('content'));
        expect(own).toBe('0.0.0-browser-test');

        // The same release answering: nothing happens.
        await mark(page, 'before');
        await pollNow(page);
        await page.waitForTimeout(1_500);
        expect(await marker(page)).toBe('before');

        // The container is replaced: every answer now comes from another release.
        await page.route('**/d/manifest**', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, headers: { ...response.headers(), 'x-app-version': '9.9.9' } });
        });
        // No stagger in a test — on this page and on the one the reload brings,
        // or a second reload would be spread past this test's window and the
        // "not again" below would pass whether or not the gap held. The
        // half-minute spread is `update.ts`'s and is unit-tested there.
        const noStagger = (): void => {
          Math.random = (): number => 0;
        };
        await page.addInitScript(noStagger);
        await page.evaluate(noStagger);
        await pollNow(page);
        await page.waitForFunction(() => (window as unknown as { marker?: string }).marker === undefined, undefined, {
          timeout: 15_000,
        });
        await page.waitForSelector('#wall .fw', { timeout: 25_000 });
        expect(await page.evaluate(() => localStorage.getItem('mw-update-reload-at'))).not.toBeNull();

        // Still disagreeing, as it would behind a proxy caching the old page:
        // inside ten minutes of the last reload, the wall stays put.
        await mark(page, 'after');
        await pollNow(page);
        await page.waitForTimeout(2_000);
        await pollNow(page);
        await page.waitForTimeout(2_000);
        expect(await marker(page)).toBe('after');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});
