/**
 * The readings picker, on the page of its own P2.1 gave it.
 *
 * The picker used to sit on the Readings list and reload that page after an
 * add, which was the whole of "show what happened": the rows it reloaded into
 * said which walls each reading was on. On an add page a reload shows the
 * form the household has just used and nothing about what it did, so the
 * mount names where to go instead (`data-done`), and this drives that end to
 * end — a real browser, a real session, a real fake house — and reads where
 * the browser ended up and what that page says, rather than trusting the
 * attribute the server wrote.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 90_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

describe('adding readings from the picker', () => {
  it(
    'goes back to the list, which carries the new readings, rather than reloading the form',
    async () => {
      const home = await install();
      installations.push(home);
      const ha = await fakeHomeAssistant();
      expect(
        (await home.post('/admin/home-assistant/connect', {
          base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
        })).status,
      ).toBe(302);

      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await home.signIn(page);

      // Reached the way a household reaches it: the list's app-bar action.
      await page.goto(`${home.base}/admin/home-assistant/readings`, { waitUntil: 'load' });
      await page.click('header.topbar a.btn');
      await page.waitForURL(/\/admin\/home-assistant\/readings\/new$/);

      // Two readings at once, which is the batch the JSON endpoint exists for.
      for (const name of ['Kitchen temperature', 'Freezer door']) {
        await page.locator('.hep-row', { hasText: name }).locator('input[type="checkbox"]').check();
      }
      await page.click('#ha-entity-picker button.btn-primary');

      await page.waitForURL(/\/admin\/home-assistant\/readings$/);
      const on = await page.evaluate(() => ({
        path: location.pathname,
        heading: document.querySelector('h1')?.textContent ?? '',
        cards: [...document.querySelectorAll('main h2')].map((h) => h.textContent ?? ''),
        picker: document.getElementById('ha-entity-picker') !== null,
      }));
      expect(on.path).toBe('/admin/home-assistant/readings');
      expect(on.heading).toBe('Readings');
      expect(on.cards).toEqual(expect.arrayContaining(['Kitchen temperature', 'Freezer door']));
      expect(on.picker, 'the list carries no picker of its own').toBe(false);
      await context.close();
    },
    SLOW,
  );
});
