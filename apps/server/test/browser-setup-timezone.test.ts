/**
 * The wizard's timezone step, in a real browser.
 *
 * The served-HTML test beside this one (`timezone-default.test.ts`) can say
 * which `<option>` carries the `selected` attribute. It cannot say what the
 * browser will *post*, and those are two different facts: a `<select>` resolves
 * a value of its own, and this project already has a comment explaining that a
 * select with nothing marked quietly resolves to whatever sorts first. That
 * fallback is browser behaviour, so the assertion about it belongs in a
 * browser — read off `select.value`, never off the markup.
 *
 * The wall's own rule, one screen earlier: assert on the computed thing.
 *
 * The step is also where this bug was reported from. On a plain `docker run`
 * the line read "Detected: UTC" with `Etc/UTC` preselected, which is the
 * container's own zone presented as a finding about the household — on the one
 * setting whose own copy says getting it wrong puts birthdays on the wrong day.
 * Nothing about that ever looks broken on the wall, so the check is the words
 * the household actually reads, taken out of the rendered page.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { DEFAULT_TIMEZONE } from '../src/timezone.js';

/** Long, because this boots a server and a browser context. */
const SLOW = 60_000;

const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

/**
 * `process.env.TZ = undefined` stores the *string* `'undefined'`. Restore by
 * deleting when it was absent, or every later test in this worker runs in an
 * environment this one invented.
 */
const originalTz = process.env['TZ'];
function setTz(value: string | undefined): void {
  if (value === undefined) delete process.env['TZ'];
  else process.env['TZ'] = value;
}
afterEach(() => setTz(originalTz));

/** A server with setup unfinished, and a page standing on the timezone step. */
async function atTimezoneStep(): Promise<{ install: Installation; page: Page }> {
  const made = await install({ wizard: false });
  installations.push(made);

  const context = await (await browser()).newContext();
  const page = await context.newPage();

  // Step 1, typed the way a household types it.
  await page.goto(`${made.base}/setup?token=${made.setupToken}`);
  await page.fill('input[name="name"]', 'Household');
  await page.fill('input[name="email"]', 'family@home.local');
  await page.fill('input[name="password"]', 'correct-horse-battery');
  await page.fill('input[name="confirm"]', 'correct-horse-battery');
  await page.click('button[type="submit"]');
  await page.waitForSelector('select[name="timezone"]');

  return { install: made, page };
}

/** The value the browser would submit, not the attribute the server wrote. */
async function selectValue(page: Page): Promise<string> {
  return page.$eval('select[name="timezone"]', (el) => (el as HTMLSelectElement).value);
}

/** The hint the household reads, as text, from the live document. */
async function hintText(page: Page): Promise<string> {
  return page.$eval('select[name="timezone"]', (el) => {
    const label = el.closest('label');
    const hint = label?.nextElementSibling;
    return hint === null || hint === undefined ? '' : (hint.textContent ?? '');
  });
}

describe('the wizard timezone step, in a browser', () => {
  it(
    'resolves to a real zone, says it could not detect one, and stores what it showed',
    async () => {
      // A container with nothing setting a zone: exactly the reported install.
      setTz('');
      const { install: made, page } = await atTimezoneStep();

      /*
       * The value the browser holds, which is what a submit posts. A `<select>`
       * with nothing effectively selected resolves to its first option — here
       * `Africa/Abidjan` — and would silently anchor the household's whole
       * calendar to it.
       */
      const value = await selectValue(page);
      expect(value).toBe(DEFAULT_TIMEZONE);

      const options = await page.$eval('select[name="timezone"]', (el) =>
        [...(el as HTMLSelectElement).options].map((o) => o.value),
      );
      expect(options).toContain(value);
      expect(options[0]).not.toBe(value); // the fallback would look identical

      // And the words. "Detected: UTC" is the bug: a claim, not a finding.
      const hint = await hintText(page);
      expect(hint).not.toContain('Detected');
      expect(hint).toContain('Could not work out where this wall is');

      // Visible, not merely present — a hint nobody can read is not a hint.
      const box = await page.$eval('select[name="timezone"]', (el) => {
        const rect = (el.closest('label')?.nextElementSibling as HTMLElement).getBoundingClientRect();
        return { w: rect.width, h: rect.height };
      });
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);

      // Submitting posts exactly the value that was on screen.
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/setup\/calendar$/);
      const row = made.db
        .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
        .get() as { timezone: string };
      expect(row.timezone).toBe(value);
    },
    SLOW,
  );

  it(
    'preselects and names the zone when the container has one',
    async () => {
      // A host `/etc/localtime` mounted through, or the supervisor's own `TZ`.
      setTz('Europe/London');
      const { install: made, page } = await atTimezoneStep();

      expect(await selectValue(page)).toBe('Europe/London');
      expect(await hintText(page)).toContain('Detected: Europe/London');

      await page.click('button[type="submit"]');
      await page.waitForURL(/\/setup\/calendar$/);
      const row = made.db
        .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
        .get() as { timezone: string };
      expect(row.timezone).toBe('Europe/London');
    },
    SLOW,
  );
});
