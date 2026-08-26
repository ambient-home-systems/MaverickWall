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
import { seedDefaultRules } from '../src/api/rules.js';

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
       * And it is never disabled, which is the point rather than an oversight.
       * The spec says implicit submission does nothing when the first submit
       * is disabled; engines have not always agreed, and one that walks on to
       * the first *enabled* submit would reach "Use my Home Assistant home
       * location" and overwrite the coordinates being typed. Enter must mean
       * Save on every engine, so the ghost stays live even while the visible
       * Save is greyed.
       */
      expect(await ghost.isDisabled(), 'a disabled default makes Enter engine-dependent').toBe(
        false,
      );
    },
    SLOW,
  );

  /**
   * And Enter on a *clean* form saves rather than filling.
   *
   * The case the ghost's enabled state is about: with nothing edited, the
   * visible Save is greyed, so an engine that resolves implicit submission to
   * the first *enabled* submit would reach the Home Assistant button and
   * replace a stored location with `zone.home`. Chromium follows the spec and
   * does nothing for a disabled default, which is why this has to be asserted
   * on what was *stored* rather than on which button fired.
   */
  it(
    'saves rather than fills when Enter is pressed on an untouched form',
    async () => {
      const { page, home } = await signedIn();
      await home.post('/admin/weather', {
        weather_form: '1', weather_enabled: '1', latitude: '51.5074', longitude: '-0.1278',
        weather_provider: 'nws', weather_units: 'imperial',
      });
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });
      expect(await page.locator('.saverow [data-dirty-save]').isDisabled()).toBe(true);

      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('input[name="latitude"]').press('Enter'),
      ]);

      const stored = readWeatherSettings(home.db);
      expect(
        { latitude: stored.latitude, longitude: stored.longitude },
        'Enter reached a button that fills the location instead of saving it',
      ).toEqual({ latitude: 51.5074, longitude: -0.1278 });
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
      // Settled: nothing is transitioning on a page that has just loaded.
      const off = await save.evaluate((node) => getComputedStyle(node).backgroundColor);

      await page.selectOption('select[name="timezone"]', 'Europe/Paris');

      await expect.poll(() => save.isEnabled(), { timeout: 10_000 }).toBe(true);
      expect(await cancel.isVisible()).toBe(true);
      expect(await flag.isVisible()).toBe(true);

      /*
       * Polled, not sampled once: `button` carries a background transition, so
       * reading the instant the state flips catches an interpolated colour
       * partway between the two and can equal the one it started from. That
       * failed about one run in three.
       */
      await expect
        .poll(() => save.evaluate((node) => getComputedStyle(node).backgroundColor), {
          timeout: 10_000,
        })
        .not.toBe(off);
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
   * Saving a form is not leaving it, and the guard asks about *work*, not
   * about which button was pressed.
   *
   * This went round twice. Armed by a form's own submit only, pressing "Turn
   * off" on a rule card beside a dirty Weather form raised that form's prompt —
   * read as a question about the button just pressed, which it is not. Armed by
   * any submit, it never asked and the edits went silently, which is the loss
   * this phase exists to remove. What matters is neither: it is whose unsaved
   * work the navigation takes with it.
   */
  it(
    'says nothing when the form being saved is the only one with anything to lose',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      await page.check('input[name="update_check_enabled"]');

      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('form[action="admin/system/updates"] [data-dirty-save]').click(),
      ]);

      expect(prompts, 'a deliberate Save was second-guessed').toBe(0);
      expect(new URL(page.url()).search).toBe('?saved=update-check');
    },
    SLOW,
  );

  it(
    'asks when a button beside the form would throw the form’s work away',
    async () => {
      const { page, home } = await signedIn();
      seedDefaultRules(home.db);
      await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

      await page.selectOption('select[name="weather_units"]', 'metric');
      await expect
        .poll(() => page.locator('.saverow [data-dirty-save]').isEnabled(), { timeout: 10_000 })
        .toBe(true);

      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });

      const off = (): number =>
        (home.db
          .prepare(`SELECT COUNT(*) AS n FROM interrupt_rules WHERE trigger = 'nws' AND enabled = 0`)
          .get() as { n: number }).n;
      const before = off();

      // A rule row's action is a form behind its overflow menu: submitting it
      // navigates, and the unsaved units change goes with it.
      await page.locator('.rules-table .ovf-btn').first().click();
      await page.locator('form[action*="/alerts/rules/"] button').first().click();
      await page.waitForTimeout(1500);

      expect(prompts, 'the units change was about to go, and nothing said so').toBe(1);
      expect(off(), 'and "Stay" means stay').toBe(before);
      expect(await page.inputValue('select[name="weather_units"]'), 'the edit is still here').toBe(
        'metric',
      );
    },
    SLOW,
  );

  /**
   * And saving one settings form warns about the other, which is right.
   *
   * The System screen carries two. Saving one navigates, so the other's unsaved
   * edit goes with it — the household can Stay, save that one first, and lose
   * nothing. The prompt is the whole reason the guard exists.
   */
  it(
    'asks when saving one settings form would take the other’s edit with it',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      await page.selectOption('select[name="timezone"]', 'Europe/Paris');
      await page.check('input[name="update_check_enabled"]');

      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });
      await page.locator('form[action="admin/system/updates"] [data-dirty-save]').click();
      await page.waitForTimeout(1500);

      expect(prompts).toBe(1);
      expect(new URL(page.url()).pathname, '"Stay" means stay').toBe('/admin/system');
      expect(await page.locator('select[name="timezone"]').inputValue()).toBe('Europe/Paris');
    },
    SLOW,
  );

  /**
   * An edit taken back is not an edit.
   *
   * The flag was one-way: type "Paris", type "London" again, and Save stayed
   * live, "Not saved yet" stayed showing, and leaving still prompted about
   * changes that no longer existed. `looksEdited` answers this the same way it
   * answers a browser-restored value — by measuring, both ways.
   */
  it(
    'goes clean again when the household undoes the edit',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      const save = page.locator('form[action="admin/system/timezone"] [data-dirty-save]');

      await page.selectOption('select[name="timezone"]', 'Europe/Paris');
      await expect.poll(() => save.isEnabled(), { timeout: 10_000 }).toBe(true);

      await page.selectOption('select[name="timezone"]', 'Europe/London');
      await expect.poll(() => save.isDisabled(), { timeout: 10_000 }).toBe(true);
      expect(
        await page.locator('form[action="admin/system/timezone"] [data-dirty-flag]').isVisible(),
      ).toBe(false);

      // And leaving says nothing, because there is nothing to say.
      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.click('a[href*="admin/calendars"]'),
      ]);
      expect(prompts, 'prompted about a change that no longer exists').toBe(0);
    },
    SLOW,
  );

  /**
   * The dirty flag cannot come from the server alone.
   *
   * A browser may put edits back on screen without telling anyone: form-state
   * restoration on a reload, and on a back/forward that does not come out of
   * the back-forward cache (where the script's own state would have survived
   * with it). The control then reads "on" over a database that says off, with
   * Save disabled, no Cancel, no "Not saved yet" and the leave guard down —
   * which is the exact "the fields show the new value" ambiguity this phase
   * exists to remove, reintroduced by the fix for it. `looksEdited` measures
   * every control against what the markup declared instead.
   *
   * Restoration is *simulated* here, and honestly: Chromium under Playwright
   * restores nothing on a reload (measured — a first version of this test
   * mistook the server's own value for a restored one, and its guard clause is
   * what caught that), while Firefox does and the spec permits it. So the
   * switch is flipped from an init script the moment the element parses, which
   * is where a restoring browser writes it: before the deferred module boots,
   * with the markup still saying otherwise. That is the state `looksEdited`
   * has to notice, whoever produced it.
   */
  it(
    'notices an edit the browser put back before the script booted',
    async () => {
      const home = await fresh();
      home.db
        .prepare(`UPDATE household_settings SET alerts_enabled = 0 WHERE id = 'singleton'`)
        .run();
      const context = await (await browser()).newContext();
      try {
        const page = await context.newPage();
        await home.signIn(page);
        /*
         * At document-start, `document.documentElement` may not exist yet, so
         * the observer is attached to the document itself — which is always
         * there — and watches the tree as the parser builds it.
         */
        await page.addInitScript(() => {
          const watch = new MutationObserver(() => {
            const box = document.querySelector<HTMLInputElement>('input[name="alerts_enabled"]');
            if (box === null) return;
            box.checked = true;
            watch.disconnect();
          });
          watch.observe(document, { childList: true, subtree: true });
        });
        await page.goto(`${home.base}/admin/alerts`, { waitUntil: 'load' });

        expect(
          await page.isChecked('input[name="alerts_enabled"]'),
          'the simulation has to have taken, or this proves nothing',
        ).toBe(true);
        expect(
          await page.locator('input[name="alerts_enabled"]').evaluate((box) =>
            (box as HTMLInputElement).defaultChecked,
          ),
          'while the markup — the server\'s copy — still says off',
        ).toBe(false);

        const form = 'form[action="admin/weather"]';
        await expect
          .poll(() => page.locator(`${form} .saverow [data-dirty-save]`).isEnabled(), { timeout: 10_000 })
          .toBe(true);
        expect(await page.locator(`${form} [data-dirty-cancel]`).isVisible()).toBe(true);
        expect(await page.locator(`${form} [data-dirty-flag]`).isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * And a plain load is not "edited".
   *
   * The hazard of measuring the DOM against the markup is the false positive:
   * a control the server rendered normally must not read as an unsaved change,
   * or every settings page arrives claiming edits nobody made and the flag
   * means nothing.
   */
  it(
    'reads a freshly served form as clean',
    async () => {
      /*
       * A real feed, so Calendars has a row to draw — and Calendars is in this
       * list deliberately. Its rows carry an `<input type="color">`, which
       * *lowercases* the value it is given while `defaultValue` hands back the
       * attribute as written; the rows ship `#4C7FD1`, so a plain string
       * compare made every unowned row boot dirty, with Save live and "Not
       * saved yet" showing on a page nobody had touched.
       */
      const home = await fresh({ feed: true });
      const context = await (await browser()).newContext();
      try {
        const page = await context.newPage();
        await home.signIn(page);
        for (const path of ['/admin/system', '/admin/alerts', '/admin/calendars']) {
          await page.goto(`${home.base}${path}`, { waitUntil: 'load' });
          expect(
            await page.locator('form[data-dirty]').count(),
            `${path} has to carry a dirty-aware form for this to mean anything`,
          ).toBeGreaterThan(0);
          await expect
            .poll(() => page.locator('.saverow [data-dirty-save]').first().isDisabled(), {
              timeout: 10_000,
            })
            .toBe(true);
          expect(await page.locator('[data-dirty-flag]').first().isVisible(), path).toBe(false);
        }
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * A download asks nothing, and does not spend the guard on the way past.
   *
   * `beforeunload` fires when the navigation *starts* — the browser cannot know
   * a response is an attachment until its headers arrive — so at the moment the
   * guard has to decide, a download looks exactly like leaving. Unmarked, it
   * asks whether you mean to abandon an unsaved timezone, about a navigation
   * that abandons nothing; System carries three of them beside two settings
   * forms. `data-download` is what tells the two apart.
   *
   * Both halves are measured here, and the counting order is the measurement:
   * the dialog listener goes on *before* the download, because a first version
   * of this test attached it afterwards and could not see the spurious prompt
   * at all.
   */
  it(
    'still guards an unsaved edit after a download',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      await page.selectOption('select[name="timezone"]', 'Europe/Paris');

      /*
       * Counting from before the download, not after: `beforeunload` fires when
       * the navigation *starts*, so an unmarked download form asks whether you
       * mean to abandon the edit — about a navigation that abandons nothing.
       * The first version of this test attached the listener afterwards and
       * could not see that at all.
       */
      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });

      const download = page.waitForEvent('download', { timeout: 20_000 });
      await page.locator('form[action="admin/system/diagnostics"] button').click();
      await (await download).cancel().catch(() => undefined);
      expect(prompts, 'a download takes nothing with it, so it asks nothing').toBe(0);

      // And the guard is still armed for a departure that does take it.
      await page.click('a[href*="admin/calendars"]');
      await page.waitForTimeout(1500);

      expect(prompts, 'the download left the guard disarmed').toBe(1);
      expect(new URL(page.url()).pathname).toBe('/admin/system');
    },
    SLOW,
  );

  /**
   * And the guard is disarmed for one navigation, not for good.
   *
   * `navigating` was set by a submit and cleared by nothing, so any navigation
   * that did not go ahead left the guard dead for the rest of the page's life.
   * Answering "Stay" to a link must leave it armed for the next one.
   */
  it(
    'asks again after a leave that was refused',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      await page.selectOption('select[name="timezone"]', 'Europe/Paris');

      let prompts = 0;
      page.on('dialog', (dialog) => {
        prompts++;
        void dialog.dismiss();
      });

      await page.click('a[href*="admin/calendars"]');
      await page.waitForTimeout(1500);
      expect(prompts).toBe(1);

      await page.click('a[href*="admin/calendars"]');
      await page.waitForTimeout(1500);
      expect(prompts, 'the guard was disarmed for good by a refused leave').toBe(2);
      expect(new URL(page.url()).pathname).toBe('/admin/system');
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

// ===========================================================================
// Conditional fields (RFC 009 Phase 7)
// ===========================================================================

describe('the Chores screen', () => {
  /**
   * The add form's five mutually-exclusive schedule field groups, shown or
   * hidden as "Repeats" changes — and shown all at once is the fault this
   * is for: four chores made a page whose real content was three lines each.
   */
  it(
    'shows only the schedule fields that belong to the chosen repeat',
    async () => {
      const { page, home } = await signedIn();
      await page.goto(`${home.base}/admin/chores#add`, { waitUntil: 'load' });

      const weekdays = page.locator('form[action="admin/chores"] fieldset.checks');
      const everyN = page.locator('form[action="admin/chores"] [data-cond-show="everyNDays"]');
      const monthDay = page.locator('form[action="admin/chores"] [data-cond-show="monthlyDate"]');
      const once = page.locator('form[action="admin/chores"] [data-cond-show="once"]');

      const visible = async (): Promise<Record<string, boolean>> => ({
        weekdays: await weekdays.isVisible(),
        everyN: await everyN.isVisible(),
        monthDay: await monthDay.isVisible(),
        once: await once.isVisible(),
      });

      // "weekdays" is the add form's default.
      expect(await visible()).toEqual({ weekdays: true, everyN: false, monthDay: false, once: false });

      await page.selectOption('form[action="admin/chores"] select[name="kind"]', 'everyNDays');
      expect(await visible()).toEqual({ weekdays: false, everyN: true, monthDay: false, once: false });

      await page.selectOption('form[action="admin/chores"] select[name="kind"]', 'once');
      expect(await visible()).toEqual({ weekdays: false, everyN: false, monthDay: false, once: true });

      // "daily" belongs to none of the five groups.
      await page.selectOption('form[action="admin/chores"] select[name="kind"]', 'daily');
      expect(await visible()).toEqual({ weekdays: false, everyN: false, monthDay: false, once: false });
    },
    SLOW,
  );

  /**
   * The degradation promise: a household who blocks script gets every field
   * visible, exactly as before this phase — the form's own hint already says
   * which boxes to use, and this script only ever adds `hidden`.
   */
  it(
    'shows every schedule field with script off',
    async () => {
      const home = await fresh();
      const context = await (await browser()).newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.goto(`${home.base}/admin/sign-in`, { waitUntil: 'load' });
        await page.fill('input[name="email"]', home.account?.email ?? '');
        await page.fill('input[name="password"]', home.account?.password ?? '');
        await Promise.all([
          page.waitForURL((url) => !url.pathname.endsWith('/sign-in'), { timeout: 20_000 }),
          page.click('button[type="submit"]'),
        ]);

        await page.goto(`${home.base}/admin/chores#add`, { waitUntil: 'load' });
        for (const group of ['everyNDays', 'monthlyDate', 'once']) {
          expect(
            await page
              .locator(`form[action="admin/chores"] [data-cond-show="${group}"]`)
              .isVisible(),
          ).toBe(true);
        }
        expect(
          await page.locator('form[action="admin/chores"] fieldset.checks').isVisible(),
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
