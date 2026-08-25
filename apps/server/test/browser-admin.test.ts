/**
 * The admin, driven in a real browser (RFC 009 Phase 3).
 *
 * Two of the three things this phase adds cannot be checked any other way.
 *
 * The Weather screen's data loss is a *browser* fault, not a handler fault:
 * every handler here does exactly what it is asked. What loses the
 * coordinates is that a browser sends the fields of the form whose button was
 * pressed and no others, and the page offered two forms with two buttons both
 * labelled "Save" 350px apart. `app.fetch` with a hand-built body cannot see
 * that, because the body is the thing under test — so the reproduction fills
 * the real inputs and clicks the real button.
 *
 * The dirty state is script, on pages that had none. Whether Save is disabled
 * at rest, enables on the first keystroke, and whether the leave-guard fires
 * are all questions about a live document.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { readWeatherSettings } from '../src/api/queries.js';

/** Long, because each of these boots a server and a browser context. */
const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(options?: Parameters<typeof install>[0]): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

/** A signed-in page on a fresh installation, the way a household arrives. */
async function signedIn(): Promise<{ page: Page; home: Installation }> {
  const home = await fresh();
  const context = await (await browser()).newContext();
  const page = await context.newPage();
  await home.signIn(page);
  return { page, home };
}

// ===========================================================================
// The Weather screen: one form, one Save
// ===========================================================================

describe('the Weather screen', () => {
  /**
   * The fault, reproduced: type a location, press the Save you can see.
   *
   * Before this phase the page carried two forms. The forecast's fields sat in
   * the first; the second held only the alerts switch — and its button, also
   * labelled "Save", sat directly beneath the hint telling you to fill in the
   * location above. Pressing it posted the alerts switch and nothing else, and
   * the page came back with the coordinate fields empty and no word about it.
   *
   * So this asserts what a household would check: that the numbers they typed
   * are stored after they pressed a button called Save.
   */
  it(
    'keeps a typed location when the Save below the alerts switch is the one pressed',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

      await page.fill('input[name="latitude"]', '51.5074');
      await page.fill('input[name="longitude"]', '-0.1278');

      // The last button labelled Save on the page — the lower of the two, which
      // is the one the hint above it points at.
      const saves = page.locator('button[type="submit"]', { hasText: /^Save$/ });
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        saves.last().click(),
      ]);

      const stored = readWeatherSettings(home.db);
      expect(
        { latitude: stored.latitude, longitude: stored.longitude },
        'the coordinates were typed and a button labelled Save was pressed',
      ).toEqual({ latitude: 51.5074, longitude: -0.1278 });
    },
    SLOW,
  );

  it(
    'offers exactly one Save, and it saves the alerts switch too',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

      const saves = page.locator('button[type="submit"]', { hasText: /^Save$/ });
      expect(await saves.count(), 'two Saves on one screen is the fault itself').toBe(1);

      await page.fill('input[name="latitude"]', '51.5074');
      await page.fill('input[name="longitude"]', '-0.1278');
      await page.check('input[name="alerts_enabled"]');
      await Promise.all([page.waitForNavigation({ timeout: 20_000 }), saves.click()]);

      const stored = readWeatherSettings(home.db);
      expect(stored.latitude).toBe(51.5074);
      const household = home.db
        .prepare(`SELECT alerts_enabled AS enabled FROM household_settings WHERE id = 'singleton'`)
        .get() as { enabled: number };
      expect(household.enabled, 'one Save, both settings').toBe(1);
    },
    SLOW,
  );

  /**
   * Enter in Latitude must save, not fill.
   *
   * The Home Assistant button is a submit inside this form, and a browser's
   * implicit submission activates the *first* submit button in tree order —
   * so with the visible Save at the bottom, Enter after typing a latitude
   * posted to `use-ha-location`, which overwrites the coordinates with
   * `zone.home` and reports it as saved. That is the screen's own bug back in
   * a new place. `defaultSubmit()` is a clipped submit rendered first, and
   * this is the only thing that proves it works.
   */
  it(
    'saves when Enter is pressed in a coordinate field, even beside a second submit',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

      await page.fill('input[name="latitude"]', '51.5074');
      await page.fill('input[name="longitude"]', '-0.1278');
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('input[name="longitude"]').press('Enter'),
      ]);

      const stored = readWeatherSettings(home.db);
      expect(
        { latitude: stored.latitude, longitude: stored.longitude },
        'Enter went somewhere other than Save',
      ).toEqual({ latitude: 51.5074, longitude: -0.1278 });
      // And the clipped default is not a control anybody can find: no tab stop,
      // and nothing in the accessibility tree.
      const ghost = page.locator('.formdefault');
      expect(await ghost.getAttribute('tabindex')).toBe('-1');
      expect(await ghost.getAttribute('aria-hidden')).toBe('true');
      expect(await ghost.boundingBox()).toMatchObject({ width: 1, height: 1 });
      /*
       * And it is disabled with the visible Save, not instead of it. Enter on
       * an untouched form otherwise saved and announced "Weather settings
       * saved." while the Save button sat greyed out beside it — two controls
       * meaning the same thing, disagreeing about whether there is anything to
       * do.
       */
      expect(await ghost.isDisabled(), 'nothing has been edited since the reload').toBe(true);
      expect(await page.locator('.saverow [data-dirty-save]').isDisabled()).toBe(true);
    },
    SLOW,
  );

  /**
   * A refused number must not cost everything else on the form.
   *
   * The screen re-rendered from the stored row on a 400, so a mistyped latitude
   * came back as an empty field — and now that the alerts switch is in the same
   * form, it would have taken that with it. Same loss, one error message along.
   */
  it(
    'hands the whole form back when it refuses a number',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

      await page.fill('input[name="latitude"]', '999');
      await page.fill('input[name="longitude"]', '-0.1278');
      await page.check('input[name="alerts_enabled"]');
      await page.selectOption('select[name="weather_provider"]', 'openmeteo');
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('.saverow [data-dirty-save]').click(),
      ]);

      expect(await page.locator('.error strong').first().textContent()).toContain(
        'A location is both numbers together',
      );
      expect(await page.inputValue('input[name="latitude"]'), 'the number to correct').toBe('999');
      expect(await page.inputValue('input[name="longitude"]')).toBe('-0.1278');
      expect(await page.isChecked('input[name="alerts_enabled"]')).toBe(true);
      expect(await page.inputValue('select[name="weather_provider"]')).toBe('openmeteo');
      /*
       * And the hints under the form read the *form*, not the database. Asking
       * the stored row would put "Fill in the latitude and longitude above"
       * under two boxes that visibly have numbers in them.
       */
      expect(
        await page.locator('form[action="admin/weather"]').textContent(),
        'the coordinates are on screen, so nothing should ask for them',
      ).not.toContain('Fill in the latitude and longitude above');

      // And nothing was written: a refused form changes nothing.
      expect(readWeatherSettings(home.db).provider).toBe('nws');

      /*
       * The re-rendered form is *already* dirty, and only the server knows it.
       * A script that booted clean would disable Save on the one page where
       * pressing it again is the whole point, hide Cancel, and disarm the
       * leave guard over the household's unsaved edits.
       */
      const save = page.locator('.saverow [data-dirty-save]');
      await expect.poll(() => save.isEnabled(), { timeout: 10_000 }).toBe(true);
      expect(await page.locator('[data-dirty-cancel]').isVisible()).toBe(true);
      expect(await page.locator('[data-dirty-flag]').isVisible()).toBe(true);
    },
    SLOW,
  );

  /**
   * The deadlock the merge introduced, and it was on the default install.
   *
   * `weather_enabled` defaults to 1 and a fresh household has no coordinates,
   * so the first version's "the forecast is on, so demand a location" refused
   * *every* submission with a 400 — and the alerts switch now shares the form,
   * so it could not be turned off, or on, from this screen at all. Blank is
   * "not set yet"; only a typed coordinate that is not one is an error.
   */
  it(
    'lets a fresh household change the alerts switch before it has a location',
    async () => {
      const { page, home } = await signedIn();
      const alertsOf = (): number =>
        (home.db
          .prepare(`SELECT alerts_enabled AS enabled FROM household_settings WHERE id = 'singleton'`)
          .get() as { enabled: number }).enabled;
      expect(alertsOf(), 'alerts ship on, which is what made this a deadlock').toBe(1);

      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });
      expect(await page.inputValue('input[name="latitude"]'), 'and no location').toBe('');

      await page.uncheck('input[name="alerts_enabled"]');
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('.saverow [data-dirty-save]').click(),
      ]);

      expect(await page.locator('.saved-text').textContent()).toBe('Weather settings saved.');
      expect(alertsOf(), 'the switch could not be moved at all before this').toBe(0);
    },
    SLOW,
  );

  /**
   * The old alerts endpoint answers rather than 404s.
   *
   * A page cached from before the merge posts its own alerts Save to
   * `/admin/alerts`. Deleting that route left it answering with a bare 404
   * while the *other* Save on that same page got a considered "out of date,
   * reload" — one stale page, two different answers.
   */
  it(
    'tells a page cached from before the merge to reload, rather than 404ing',
    async () => {
      const home = await fresh();
      const stale = await home.post('/admin/alerts', { alerts_enabled: '1' });
      expect(stale.status).toBe(400);
      expect(await stale.text()).toContain('out of date');
    },
    SLOW,
  );
});

// ===========================================================================
// The confirmation strip (3.1)
// ===========================================================================

describe('the confirmation strip', () => {
  it(
    'says what was saved, and goes when it is dismissed',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

      expect(
        await page.locator('.saved').count(),
        'nothing was saved, so nothing should claim it was',
      ).toBe(0);

      await page.fill('input[name="latitude"]', '51.5074');
      await page.fill('input[name="longitude"]', '-0.1278');
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('.saverow [data-dirty-save]').click(),
      ]);

      const strip = page.locator('.saved');
      await strip.waitFor({ timeout: 10_000 });
      expect(await strip.getAttribute('role')).toBe('status');
      expect(await strip.getAttribute('aria-live')).toBe('polite');
      expect(await strip.locator('.saved-text').textContent()).toBe('Weather settings saved.');

      // And it is legible: an .error-shaped box drawn in the ok pair, not an
      // invisible word on a tinted ground. Asserted on the *computed* colours,
      // never on the class — a chore box was once fully classed and fully wrong.
      const painted = await strip.evaluate((node) => {
        const own = getComputedStyle(node);
        const text = node.querySelector('.saved-text');
        return {
          background: own.backgroundColor,
          ink: text === null ? '' : getComputedStyle(text).color,
        };
      });
      expect(painted.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(painted.ink).not.toBe(painted.background);

      // Dismissing is a link back to the same page without the parameter, so a
      // refresh cannot re-announce a save from ten minutes ago.
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('.saved-x').click(),
      ]);
      expect(new URL(page.url()).search).toBe('');
      expect(await page.locator('.saved').count()).toBe(0);
    },
    SLOW,
  );

  it(
    'says nothing for a token nobody minted',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system?saved=nonsense`, { waitUntil: 'load' });
      expect(
        await page.locator('.saved').count(),
        'an unrecognised token is somebody’s bookmark, not a save',
      ).toBe(0);
    },
    SLOW,
  );
});

// ===========================================================================
// Dirty state (3.2)
// ===========================================================================

describe('a settings form', () => {
  it(
    'holds Save disabled until there is something to save, then offers Cancel',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });

      const save = page.locator('form[action="admin/system/timezone"] [data-dirty-save]');
      const cancel = page.locator('form[action="admin/system/timezone"] [data-dirty-cancel]');
      const flag = page.locator('form[action="admin/system/timezone"] [data-dirty-flag]');

      await expect.poll(() => save.isDisabled(), { timeout: 10_000 }).toBe(true);
      expect(await cancel.isVisible(), 'nothing to discard reads as no Cancel at all').toBe(false);
      expect(await flag.isVisible()).toBe(false);

      /*
       * And it *looks* disabled. Asserted on the computed background rather
       * than on the `disabled` property, because the first version of this
       * shipped with no disabled treatment at all: the two states were
       * pixel-identical, so "Save is off until you change something" read as a
       * Save that silently did nothing when pressed — strictly worse than the
       * always-enabled button it replaced. Found by rendering the page and
       * looking at it, and invisible to any assertion about state.
       */
      const off = await save.evaluate((node) => getComputedStyle(node).backgroundColor);

      await page.selectOption('select[name="timezone"]', 'Europe/Paris');

      await expect.poll(() => save.isEnabled(), { timeout: 10_000 }).toBe(true);
      expect(await cancel.isVisible()).toBe(true);
      expect(await flag.isVisible()).toBe(true);

      const on = await save.evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(off, 'a disabled Save that looks enabled is a button that does nothing').not.toBe(on);
    },
    SLOW,
  );

  it(
    'throws the edit away on Cancel, and does not ask on the way out',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      await page.selectOption('select[name="timezone"]', 'Europe/Paris');

      let asked = false;
      page.on('dialog', (dialog) => {
        asked = true;
        void dialog.dismiss();
      });

      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('form[action="admin/system/timezone"] [data-dirty-cancel]').click(),
      ]);

      expect(asked, 'Cancel *is* discarding, so guarding it would be asking twice').toBe(false);
      expect(new URL(page.url()).pathname).toBe('/admin/system');
      expect(await page.locator('select[name="timezone"]').inputValue()).toBe('Europe/London');
      expect(
        (home.db
          .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
          .get() as { timezone: string }).timezone,
      ).toBe('Europe/London');
    },
    SLOW,
  );

  it(
    'asks before a link throws an unsaved edit away',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      const from = page.url();

      // Chromium only raises a beforeunload dialogue after a real user gesture,
      // which the select below supplies.
      await page.selectOption('select[name="timezone"]', 'Europe/Paris');

      let asked = false;
      page.on('dialog', (dialog) => {
        asked = true;
        void dialog.dismiss();
      });
      await page.click('a[href*="admin/calendars"]');
      await page.waitForTimeout(1500);

      expect(
        { asked, url: page.url() },
        'a nav link took an unsaved timezone away without asking',
      ).toEqual({ asked: true, url: from });
    },
    SLOW,
  );

  /**
   * The guard is disarmed for one navigation, not for good.
   *
   * The System screen carries two of these forms. Saving one used to latch its
   * own `navigating` flag; the other's guard then prompted, and answering
   * "Stay" cancelled the navigation — leaving the first form dirty on screen
   * with its guard dead for the rest of the page's life. So: dirty both, save
   * one, stay, then try to leave, and the first form's edit must still be
   * defended.
   */
  it(
    'still guards a form whose save was cancelled by the other form on the page',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });

      await page.selectOption('select[name="timezone"]', 'Europe/Paris');
      await page.check('input[name="update_check_enabled"]');

      // Save the update-check form. The timezone form's guard prompts; stay.
      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });
      await page.locator('form[action="admin/system/updates"] [data-dirty-save]').click();
      await page.waitForTimeout(1500);
      expect(prompts, 'the timezone form had an unsaved edit to defend').toBe(1);
      expect(new URL(page.url()).pathname, 'and we stayed').toBe('/admin/system');

      /*
       * Now save the *other* one. The update-check form is still dirty and was
       * never saved, so it is its turn to object — and it cannot, if its flag
       * latched on the attempt that was cancelled. Asserted on the URL rather
       * than on the count, because a prompt count cannot tell the two forms
       * apart: without the reset the save simply goes through.
       */
      await page.locator('form[action="admin/system/timezone"] [data-dirty-save]').click();
      await page.waitForTimeout(1500);
      expect(prompts, 'the cancelled save left the update-check guard dead').toBe(2);
      expect(
        new URL(page.url()).search,
        'the timezone save went through over an unsaved update-check edit',
      ).toBe('');
    },
    SLOW,
  );

  /**
   * The degradation promise, checked rather than asserted in prose.
   *
   * A settings page may carry script (RFC 009, Decisions taken) — and a
   * household who blocks it must keep today's form, not a Save they cannot
   * press. The server renders Save enabled and the two dirty-only controls
   * `hidden`; this is that markup with nothing to enhance it.
   */
  it(
    'still saves with script off',
    async () => {
      const home = await fresh();
      const context = await (await browser()).newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        // The sign-in form is script-free by design, so it works here.
        await page.goto(`${home.base}/admin/sign-in`, { waitUntil: 'load' });
        await page.fill('input[name="email"]', home.account?.email ?? '');
        await page.fill('input[name="password"]', home.account?.password ?? '');
        await Promise.all([
          page.waitForURL((url) => !url.pathname.endsWith('/sign-in'), { timeout: 20_000 }),
          page.click('button[type="submit"]'),
        ]);

        await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
        const save = page.locator('form[action="admin/system/timezone"] [data-dirty-save]');
        expect(await save.isEnabled(), 'no script, so nothing ever enables it').toBe(true);
        expect(
          await page.locator('form[action="admin/system/timezone"] [data-dirty-cancel]').isVisible(),
          'a Cancel that cannot discard anything would be a control that does nothing',
        ).toBe(false);

        await page.selectOption('select[name="timezone"]', 'Europe/Paris');
        await Promise.all([page.waitForNavigation({ timeout: 20_000 }), save.click()]);

        expect(
          (home.db
            .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
            .get() as { timezone: string }).timezone,
        ).toBe('Europe/Paris');
        // And the strip is script-free too — it is markup, and its dismiss is a link.
        expect(await page.locator('.saved-text').textContent()).toBe('Timezone saved.');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
