/**
 * A household's own CSS, on a real wall, and never on the chrome (RFC 014 §7,
 * precondition 3 — safe mode by construction).
 *
 * The block a household is most likely to get wrong is the one that hides
 * something, so that is the one this file saves: `display: none` on the wall's
 * own calendar boxes, and `display: none` on the clock inside its widget. Then
 * it asks the four questions the precondition names, in a real Chromium:
 *
 *  1. the wall wears it — both blocks reach the glass through the CSSOM, and
 *     a box neither names is untouched;
 *  2. the pairing form still renders, on a screen that holds no token;
 *  3. the boot message still renders, on a screen whose server never answers;
 *  4. the offline banner still renders — the server is *killed*, which is the
 *     only way to get one — and the stored copy the wall draws on its reload
 *     carries the block, so a wall coming back from a power cut draws the
 *     styled wall it had.
 *
 * None of those three surfaces is inside `.canvas`, and every rule is scoped
 * under it or under a box inside it; the wall also clears its household rules
 * on every path that draws chrome. Asserted by measurement rather than by
 * reasoning — the computed `display` and a rectangle with height — because a
 * `display: none` that leaked would be a black screen nobody can explain from
 * a kitchen, which is rule nine's whole subject.
 *
 * And the refusal path, driven through the real form: the text typed comes
 * back in the textarea with the sanitiser's sentence beside it, and Save was
 * live because the form was handed back dirty.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  loadWallSettled,
  settleWall,
  shellCache,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

process.env['TZ'] = 'UTC';
const SLOW = 180_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** A paired wall wearing the two blocks, and what a test needs to reach it. */
async function styledWall(): Promise<{ home: Installation; link: string; screenId: string; clockId: string }> {
  const home = await install({ feed: true });
  installations.push(home);
  const link = await home.pairLink('Kitchen');
  const screenId = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  const clockId = (
    home.db
      .prepare(`SELECT id FROM layout_widgets WHERE screen_id = ? AND orientation = 'portrait' AND type = 'clock' LIMIT 1`)
      .get(screenId) as { id: string }
  ).id;
  const saved = await home.post(`/admin/walls/${screenId}/css`, {
    css_form: '1',
    css_wall: '.fw-calendar { display: none }',
    [`css_w_${clockId}`]: '.clock { display: none }',
  });
  expect(saved.status, 'the CSS this file needs was refused').toBe(302);
  return { home, link, screenId, clockId };
}

/** The computed `display` and the drawn height of the first match, or nothing. */
async function drawn(page: Page, selector: string): Promise<{ display: string; height: number; count: number } | undefined> {
  return page.evaluate((sel: string) => {
    const all = document.querySelectorAll(sel);
    const first = all[0];
    if (!(first instanceof HTMLElement)) return undefined;
    return {
      display: getComputedStyle(first).display,
      height: first.getBoundingClientRect().height,
      count: all.length,
    };
  }, selector);
}

describe('a household’s CSS on a real wall', () => {
  it(
    'hides what it names, on the wall and inside one widget, and nothing else',
    async () => {
      const { link, clockId } = await styledWall();
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const calendars = await drawn(page, '#wall .canvas .fw-calendar');
        expect(calendars?.count, 'the Classic wall has calendar boxes').toBeGreaterThan(0);
        expect(calendars?.display, 'the wall’s block did not reach the calendar boxes').toBe('none');

        const clockBox = await drawn(page, `#wall .canvas .fw[data-widget-id="${clockId}"]`);
        expect(clockBox?.display, 'the widget’s block hid its own box, which it never named').not.toBe('none');
        const clock = await drawn(page, `#wall .canvas .fw[data-widget-id="${clockId}"] .clock`);
        expect(clock?.display, 'the widget’s block did not reach the clock inside its box').toBe('none');

        // Through the CSSOM, on the wall's own sheet, after every rule of it —
        // and through nothing else: no `<style>` was written into the document.
        const how = await page.evaluate(() => {
          const sheet = [...document.styleSheets].find((s) => (s.href ?? '').includes('display.css'));
          const rules = sheet === undefined ? [] : [...sheet.cssRules].map((r) => r.cssText);
          return {
            last: rules.slice(-4).join('\n'),
            styleElements: document.querySelectorAll('style').length,
          };
        });
        expect(how.last).toContain('.canvas .fw-calendar');
        expect(how.last).toContain(`[data-widget-id="${clockId}"] .clock`);
        expect(how.styleElements).toBe(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'leaves the pairing form drawn on a screen with no token',
    async () => {
      const { home } = await styledWall();
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      try {
        const page = await context.newPage();
        await page.goto(`${home.base}/`, { waitUntil: 'load' });
        await page.waitForSelector('.pair-form', { timeout: 20_000 });
        const form = await drawn(page, '#wall .pair-form');
        expect(form?.display).not.toBe('none');
        expect(form?.height ?? 0).toBeGreaterThan(0);
        const input = await drawn(page, '#wall .pair-input');
        expect(input?.height ?? 0).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'leaves the boot message drawn on a screen whose server never answers',
    async () => {
      const { link } = await styledWall();
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      try {
        const page = await context.newPage();
        // The pairing link still sets the cookie; every poll after it dies.
        await page.route('**/d/manifest*', (route) => route.abort());
        await page.goto(link, { waitUntil: 'load' });
        await page.waitForSelector('#wall .screen-message .message', { timeout: 20_000 });
        // The first failed poll replaces "Waiting…" with the reason; either is
        // the boot message, and both are drawn by `renderMessage`.
        await page.waitForFunction(
          () => /Not reaching|Waiting for the first update/.test(document.querySelector('#wall .message')?.textContent ?? ''),
          null,
          { timeout: 20_000 },
        );
        const message = await drawn(page, '#wall .screen-message .message');
        expect(message?.display).not.toBe('none');
        expect(message?.height ?? 0).toBeGreaterThan(0);
        expect(await drawn(page, '#wall .canvas')).toBeUndefined();
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'leaves the offline banner drawn after a power cut, and draws the styled wall from its stored copy',
    async () => {
      const { home, link, clockId } = await styledWall();
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        // The shell has to be cached before the server goes, or the reload
        // below is a browser error page rather than a wall — the same steps
        // `display-csp.test.ts`'s offline surface takes.
        const controlled = await page
          .waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        expect(controlled, 'the service worker never took control, so there is no offline reload to measure').toBe(true);
        await page.reload({ waitUntil: 'load' });
        await settleWall(page);
        expect(await shellCache(page), 'the shell cache holds no document').toContain('/');

        await home.kill();
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#wall .banners .banner', { timeout: 30_000 });

        const banner = await drawn(page, '#wall .banners .banner');
        expect(banner?.display).not.toBe('none');
        expect(banner?.height ?? 0).toBeGreaterThan(0);
        const text = await page.evaluate(() => document.querySelector('#wall .banners')?.textContent ?? '');
        expect(text).toMatch(/Not reaching|Last updated/);

        // The stored copy carries the blocks: the styled wall, drawn offline.
        const calendars = await drawn(page, '#wall .canvas .fw-calendar');
        expect(calendars?.count ?? 0).toBeGreaterThan(0);
        expect(calendars?.display, 'the stored copy drew without the wall’s block').toBe('none');
        const clock = await drawn(page, `#wall .canvas .fw[data-widget-id="${clockId}"] .clock`);
        expect(clock?.display, 'the stored copy drew without the widget’s block').toBe('none');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'hands a refused block back into the textarea, with the sentence beside it, through the real form',
    async () => {
      const { home, screenId } = await styledWall();
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await home.signIn(page);
        await page.goto(`${home.base}/admin/walls/${encodeURIComponent(screenId)}/css`, { waitUntil: 'load' });
        const field = page.locator('textarea[name="css_wall"]');
        await field.fill('.fw-calendar { display: none }\n.fw { position: fixed }');
        // Typing is what arms Save: it is disabled until the form is dirty.
        await page.waitForFunction(
          () => !(document.querySelector('[data-dirty-save]') as HTMLButtonElement | null)?.disabled,
          null,
          { timeout: 10_000 },
        );
        // The live check says so first, beside the field, before anything is saved.
        await page.waitForFunction(
          () => /Line 2: position: fixed/.test(document.querySelector('[data-css-live="css_wall"]')?.textContent ?? ''),
          null,
          { timeout: 10_000 },
        );
        await Promise.all([
          page.waitForResponse((r) => r.url().endsWith('/css') && r.request().method() === 'POST', { timeout: 20_000 }),
          page.click('[data-dirty-save]'),
        ]);
        await page.waitForSelector('.error', { timeout: 20_000 });
        expect(await field.inputValue()).toBe('.fw-calendar { display: none }\n.fw { position: fixed }');
        const beside = await page.evaluate(
          () => document.querySelector('.field.field-error + .field-hint.is-error')?.textContent ?? '',
        );
        expect(beside).toMatch(/^Line 2: position: fixed/);
        const stored = home.db
          .prepare('SELECT custom_css AS source FROM screens WHERE id = ?')
          .get(screenId) as { source: string | null };
        expect(stored.source).toBe('.fw-calendar { display: none }');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
