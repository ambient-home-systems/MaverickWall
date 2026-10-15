import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, shutDownBrowser, TEARDOWN, type Installation } from './browser-harness.js';
import { INGRESS_HEADER } from '../src/http/ingress.js';

/**
 * The admin inside Home Assistant's own sidebar: tabs across the top, not a
 * second sidebar.
 *
 * Opened from the add-on's sidebar entry, the admin's 264px sidebar stood
 * beside Home Assistant's 256px one — two dark columns of icons and words, two
 * brands, two "Overview"s, about 520px of a 1440px screen before any content.
 * Under ingress the page keeps its tab bar instead (`chooseNavigation`), and
 * everywhere else it keeps the sidebar it always had.
 *
 * Ingress is played the way the supervisor plays it, rather than by setting a
 * header on a request to the root: the browser asks for
 * `/api/hassio_ingress/<token>/…`, and the route strips the prefix and says
 * what it stripped in `X-Ingress-Path`. So every link the page draws has to
 * resolve through the injected `<base>` to land anywhere at all, and a tab that
 * escaped the prefix would be a request this route never sees and a 404.
 *
 * Everything is read off the laid-out page — what is in the document, where
 * the main column starts, what a click lands on — never off a class alone.
 */

const SLOW = 60_000;
const PREFIX = '/api/hassio_ingress/TABS-SESSION';

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function insideHomeAssistant(width: number): Promise<{ home: Installation; page: Page }> {
  const home = await install();
  installations.push(home);
  const ctx = await (await browser()).newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await home.signIn(page);
  const origin = new URL(home.base).origin;
  await page.route(`${origin}${PREFIX}/**`, async (route) => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.slice(PREFIX.length);
    await route.continue({
      url: url.toString(),
      headers: { ...route.request().headers(), [INGRESS_HEADER]: PREFIX },
    });
  });
  return { home, page };
}

describe('the admin inside Home Assistant', () => {
  it(
    'draws the sections as tabs and the screens of the current one under them, with no sidebar',
    async () => {
      const { home, page } = await insideHomeAssistant(1184);
      await page.goto(`${home.base}${PREFIX}/admin/calendars`, { waitUntil: 'load' });

      const shape = await page.evaluate(() => ({
        sidebar: document.querySelector('aside.side') !== null,
        toggle: document.querySelector('#mw-nav') !== null,
        menuButton: document.querySelector('.navbtn') !== null,
        mainLeft: document.querySelector('main')!.getBoundingClientRect().left,
        sections: [...document.querySelectorAll('.tabs .tab')].map((a) => a.textContent),
        current: [...document.querySelectorAll('.tabs .tab.on')].map((a) => a.textContent),
        screens: [...document.querySelectorAll('.subtabs .subtab')].map((a) => a.textContent),
        here: [...document.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent),
        mark: (() => {
          const after = getComputedStyle(document.querySelector('.tabs .tab.on')!, '::after');
          return { content: after.content, height: after.height, colour: after.backgroundColor };
        })(),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));

      expect(shape.sidebar, 'the sidebar is still drawn beside Home Assistant’s').toBe(false);
      expect(shape.toggle, 'the drawer’s checkbox is left behind').toBe(false);
      expect(shape.menuButton, 'a menu button for a drawer that is not there').toBe(false);
      expect(shape.mainLeft, 'the main column does not start at the left edge').toBe(0);
      expect(shape.sections).toEqual(['Overview', 'Household', 'Integrations', 'Walls', 'System']);
      expect(shape.current).toEqual(['Household']);
      expect(shape.screens).toEqual([
        'Calendars', 'People', 'Photos', 'Work Schedule', 'Chores', 'Timers and messages',
      ]);
      expect(shape.here, 'one thing on the page says where you are').toEqual(['Calendars']);
      // A pseudo-element with no content is not drawn, whatever colour it says.
      expect(shape.mark.content, 'the current section carries no accent bar').not.toMatch(/^(none|normal)$/);
      expect(shape.mark.height).toBe('2px');
      expect(shape.mark.colour).not.toBe('rgba(0, 0, 0, 0)');
      expect(shape.overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);

      // A tab is a real link through the prefix: following one lands on the
      // section's first screen, still inside Home Assistant.
      await Promise.all([page.waitForURL(`**${PREFIX}/admin/alerts`), page.click('.tabs .tab >> text=Integrations')]);
      const after = await page.evaluate(() => ({
        current: [...document.querySelectorAll('.tabs .tab.on')].map((a) => a.textContent),
        here: [...document.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent),
        heading: document.querySelector('h1')?.textContent,
      }));
      expect(after.current).toEqual(['Integrations']);
      expect(after.here).toEqual(['Weather']);
      expect(after.heading).toBe('Weather');

      // A one-screen section draws no second row, and its tab is the page.
      await Promise.all([page.waitForURL(`**${PREFIX}/admin/system`), page.click('.tabs .tab >> text=System')]);
      const system = await page.evaluate(() => ({
        rows: document.querySelectorAll('.subtabs').length,
        here: [...document.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent),
      }));
      expect(system.rows).toBe(0);
      expect(system.here).toEqual(['System']);
    },
    SLOW,
  );

  it(
    'keeps who is signed in and the theme in a menu that opens without script',
    async () => {
      const { home, page } = await insideHomeAssistant(1184);
      await page.goto(`${home.base}${PREFIX}/admin`, { waitUntil: 'load' });
      const closed = await page.locator('.tabs-menu').isVisible();
      expect(closed).toBe(false);
      await page.click('.tabs-more summary');
      const menu = await page.evaluate(() => {
        const box = document.querySelector('.tabs-menu') as HTMLElement;
        const r = box.getBoundingClientRect();
        return {
          who: box.querySelector('.who')?.textContent,
          themes: [...box.querySelectorAll('[data-theme-set]')].map((b) => b.textContent),
          inside: r.left >= 0 && r.right <= window.innerWidth,
        };
      });
      expect(menu.who, 'the account line was left unfilled').not.toContain('Signed in');
      expect(menu.themes).toEqual(['Auto', 'Light', 'Dark']);
      expect(menu.inside, 'the menu runs off the screen').toBe(true);

      await page.click('.tabs-menu [data-theme-set="light"]');
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
    },
    SLOW,
  );

  it(
    'scrolls the rows sideways on a phone rather than the page',
    async () => {
      const { home, page } = await insideHomeAssistant(390);
      // Integrations is the third section and the longest name, so it is the
      // tab a phone is likeliest to cut off.
      await page.goto(`${home.base}${PREFIX}/admin/alerts`, { waitUntil: 'load' });
      const phone = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tabsScroll: (document.querySelector('.tabs') as HTMLElement).scrollWidth >
          (document.querySelector('.tabs') as HTMLElement).clientWidth,
        sidebar: document.querySelector('aside.side') !== null,
        current: (() => {
          // Against the row's own visible edge, not the window's: the row is
          // clipped before the menu button, so a tab can end inside the window
          // and still be cut off.
          const r = document.querySelector('.tabs .tab.on')!.getBoundingClientRect();
          return r.right <= document.querySelector('.tabs')!.getBoundingClientRect().right + 0.5;
        })(),
      }));
      expect(phone.current, 'the current section’s tab is off the screen').toBe(true);
      expect(phone.overflow, 'the page scrolls sideways at 390px').toBeLessThanOrEqual(0);
      expect(phone.tabsScroll, 'five sections do not fit 390px, so the row must scroll').toBe(true);
      expect(phone.sidebar).toBe(false);

      // System is the last section, past the row's edge at 390px; the row
      // brings it in, and the page itself does not move.
      await page.goto(`${home.base}${PREFIX}/admin/system`, { waitUntil: 'load' });
      const last = await page.evaluate(() => {
        const r = document.querySelector('.tabs .tab.on')!.getBoundingClientRect();
        const row = document.querySelector('.tabs')!.getBoundingClientRect();
        return { shown: r.left >= row.left - 0.5 && r.right <= row.right + 0.5, pageX: window.scrollX };
      });
      expect(last.shown, 'the System tab is out of sight on its own page').toBe(true);
      expect(last.pageX).toBe(0);
    },
    SLOW,
  );
});

describe('the admin anywhere else', () => {
  it(
    'keeps its sidebar and draws no tab bar',
    async () => {
      const home = await install();
      installations.push(home);
      const ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await home.signIn(page);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });
      const shape = await page.evaluate(() => ({
        sidebar: document.querySelector('aside.side') !== null,
        tabs: document.querySelector('.tabsbar') !== null,
        here: [...document.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent),
        inHa: document.body.classList.contains('in-ha'),
      }));
      expect(shape).toEqual({ sidebar: true, tabs: false, here: ['Calendars'], inHa: false });
    },
    SLOW,
  );
});
