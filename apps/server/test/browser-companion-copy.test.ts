/**
 * The companion token's Copy button, in a real Chromium (plan item M2.1).
 *
 * `companion-api.test.ts` holds the markup: the field, the button rendered
 * `hidden`, the script tag. What only a browser can say is whether the script
 * reveals the button and whether pressing it puts the token on the clipboard —
 * through `navigator.clipboard` where the page is a secure context, and through
 * the older `execCommand('copy')` where it is not, which is the commonest
 * install there is: a box reached by its LAN address over plain http.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';

import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 120_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function household(): Promise<{ app: Installation; token: string }> {
  const app = await install();
  installations.push(app);
  expect((await app.post('/admin/companion', {})).status).toBe(302);
  const page = await (await app.call('/admin/companion')).text();
  const token = /value="(mwc_[A-Za-z0-9_-]+)"/.exec(page)?.[1];
  expect(token).toBeDefined();
  return { app, token: token! };
}

async function openToken(app: Installation, context: BrowserContext, insecure = false): Promise<Page> {
  const page = await context.newPage();
  if (insecure) {
    // What a page served over plain http to a LAN address sees: no secure
    // context, so no `navigator.clipboard` to write with.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', { value: false });
    });
  }
  await app.signIn(page);
  await page.goto(`${app.base}/admin/companion`);
  await page.locator('details.token-show > summary').click();
  return page;
}

describe('the Copy button beside the companion token', () => {
  it(
    'is revealed by its script and copies the token through the clipboard',
    async () => {
      const { app, token } = await household();
      const context = await (await browser()).newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      try {
        const page = await openToken(app, context);
        const button = page.locator('button[data-copy="companion-token"]');
        await button.waitFor({ state: 'visible', timeout: 10_000 });
        await button.click();
        await expect.poll(() => button.textContent()).toBe('Copied');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'still copies where there is no secure context, by selecting the field',
    async () => {
      const { app, token } = await household();
      const context = await (await browser()).newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      try {
        const page = await openToken(app, context, true);
        const button = page.locator('button[data-copy="companion-token"]');
        await button.waitFor({ state: 'visible', timeout: 10_000 });
        await button.click();
        await expect.poll(() => button.textContent()).toMatch(/^(Copied|Selected — copy it now)$/);
        // The field is selected end to end, which is what a person copies by hand
        // if the browser refused the copy itself.
        const selected = await page.evaluate(() => {
          const field = document.getElementById('companion-token') as HTMLInputElement;
          return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
        });
        expect(selected).toBe(token);
        if ((await button.textContent()) === 'Copied') {
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
        }
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'stays hidden without script, leaving the field to select by hand',
    async () => {
      const { app, token } = await household();
      const context = await (await browser()).newContext({ javaScriptEnabled: false });
      try {
        const page = await openToken(app, context);
        expect(await page.locator('button[data-copy="companion-token"]').isVisible()).toBe(false);
        expect(await page.locator('#companion-token').inputValue()).toBe(token);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
