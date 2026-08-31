/**
 * The whole journey, in a real browser: reach for a page, sign in, arrive.
 *
 * `sign-in-next.test.ts` proves each hop with `app.fetch` — the gate's
 * `Location`, the form's hidden field, the handler's redirect. What it cannot
 * prove is that a browser joins them up, and the joins are where this would
 * fail: a form POST does not send its action's query string, so the destination
 * has to survive as a field somebody's browser actually submits, and the page
 * carries `<base href="/">` for ingress, which has already made one anchor on
 * this codebase resolve somewhere its markup did not say.
 *
 * The refusal is driven here too, and deliberately as a *navigation*: the thing
 * that matters about an open redirect is which origin the address bar ends up
 * on, and only a browser can be asked that.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

/** Long, because each of these boots a server and a browser context. */
const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(): Promise<Installation> {
  const made = await install();
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

describe('signing in returns to where you were going', () => {
  it(
    'lands on the page that was asked for, not on the admin index',
    async () => {
      const app = await fresh();
      const page = await (await browser()).newPage();
      try {
        // Signed out, reaching for a specific screen. The browser follows the
        // gate's redirect on its own, which is the whole point of driving it.
        await page.goto(`${app.base}/admin/system`, { waitUntil: 'load' });
        expect(new URL(page.url()).pathname).toBe('/admin/sign-in');
        expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/system');

        // The field the browser will actually post — read off the DOM rather
        // than out of the markup, because that is what gets submitted.
        expect(
          await page.evaluate(
            () => (document.querySelector('input[name="next"]') as HTMLInputElement | null)?.value,
          ),
        ).toBe('/admin/system');

        const account = app.account;
        if (account === undefined) throw new Error('this installation has no account');
        await page.fill('input[name="email"]', account.email);
        await page.fill('input[name="password"]', account.password);
        await Promise.all([
          page.waitForURL((url) => !url.pathname.endsWith('/sign-in'), { timeout: 20_000 }),
          page.click('button[type="submit"]'),
        ]);

        expect(new URL(page.url()).pathname).toBe('/admin/system');
        // And it is really that page rather than the index redirected under a
        // hopeful URL: the heading is what a household would read.
        expect(await page.textContent('main h1')).toMatch(/system/i);
      } finally {
        await page.close();
      }
    },
    SLOW,
  );

  it(
    'refuses to hand the browser to another origin',
    async () => {
      const app = await fresh();
      const page = await (await browser()).newPage();
      try {
        // A link somebody was sent. If this worked, the household would type
        // their password on this box and be delivered to evil.example with
        // their own address bar vouching for the trip.
        await page.goto(
          `${app.base}/admin/sign-in?next=${encodeURIComponent('//evil.example/admin')}`,
          { waitUntil: 'load' },
        );
        // Nothing of the rejected value reaches the page, so there is nothing
        // for the browser to submit.
        expect(await page.content()).not.toContain('evil.example');
        expect(await page.evaluate(() => document.querySelectorAll('input[name="next"]').length)).toBe(0);

        const account = app.account;
        if (account === undefined) throw new Error('this installation has no account');
        await page.fill('input[name="email"]', account.email);
        await page.fill('input[name="password"]', account.password);
        await Promise.all([
          page.waitForURL((url) => !url.pathname.endsWith('/sign-in'), { timeout: 20_000 }),
          page.click('button[type="submit"]'),
        ]);

        // The measurement that matters is the origin, not the path.
        expect(new URL(page.url()).origin).toBe(new URL(app.base).origin);
        expect(new URL(page.url()).pathname).toBe('/admin');
      } finally {
        await page.close();
      }
    },
    SLOW,
  );
});
