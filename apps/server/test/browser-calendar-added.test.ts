/**
 * Adding a calendar, driven in a real browser.
 *
 * The reported fault is a *sequence*, not a document: type an address, press
 * Add, and the row you land on reads "0 events · synced never" — which is
 * character for character what a dead feed says — and then, with no user
 * action, becomes "12 events · synced 1 minute ago". Nothing on the page ever
 * said the first sync was still running.
 *
 * `app.fetch` can assert the two renderings, and `admin-status-claims.test.ts`
 * does. What it cannot assert is the thing the household experiences: that the
 * sentence on screen *at the moment the form is submitted* is not a failure
 * state. That needs the real form, the real button and the real navigation, so
 * this fills the fields somebody would fill and reads back the row's own text.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 60_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

describe('adding a calendar from the Calendars screen', () => {
  it(
    'says Syncing… on the row it lands on, and the real count once the sync has run',
    async () => {
      // `feed: true` for the loopback address only — the wizard's own calendar
      // is already synced, which is what makes the two rows on this page a
      // contrast rather than a single state repeated.
      const home = await install({ feed: true });
      installations.push(home);
      const url = home.feedUrl;
      expect(url).toBeDefined();

      const context = await (await browser()).newContext();
      const page = await context.newPage();
      await home.signIn(page);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });

      // The add form at the foot of the page. A row's own settings form posts
      // to `.../:id/settings`, so this action is the add form's alone.
      const form = page.locator('form[action="admin/calendars"]');
      await form.locator('input[name="name"]').fill('Just added');
      await form.locator('input[name="url"]').fill(url ?? '');
      // The switches live in a collapsed <details>; a household opens it,
      // because the refusal names them. Loopback and plain http are both
      // needed to reach a test feed on 127.0.0.1.
      await form.locator('summary').click();
      await form.locator('input[name="allow_loopback"]').check();
      await form.locator('input[name="allow_http"]').check();

      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        form.locator('button[value="save"]').click(),
      ]);

      /**
       * The card for one calendar, as a person reads it — its own text and not
       * the page's, so "no other row says this" is a thing the assertions can
       * actually distinguish.
       */
      const rowText = async (name: string): Promise<string> =>
        (
          await page
            .locator('article.card', { has: page.locator('h2', { hasText: name }) })
            .first()
            .innerText()
        ).replace(/\s+/g, ' ');

      const justAdded = await rowText('Just added');
      expect(justAdded).toContain('Syncing…');
      expect(justAdded).not.toContain('synced never');
      // Word-boundaried: this feed carries ten events, and a bare substring
      // match would find "0 events" inside "10 events" and pass over the bug.
      expect(justAdded).not.toMatch(/\b0 events/);

      // The strip the redirect carries, which is the other half of saying so.
      const strip = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      expect(strip).toContain('Calendar added — fetching events now.');

      // The wizard's calendar, on the same page at the same moment, is not
      // caught by the new branch.
      expect(await rowText('Family')).toMatch(/events · synced/);

      // And then the sync the scheduler would have run, three seconds after the
      // row was written. This harness has no scheduler, which is what makes the
      // state above observable at all.
      await home.sync();
      await page.reload({ waitUntil: 'load' });

      const settled = await rowText('Just added');
      expect(settled).not.toContain('Syncing…');
      expect(settled).toMatch(/\d+ events · synced/);
      expect(settled).not.toMatch(/\b0 events/);
    },
    SLOW,
  );
});
