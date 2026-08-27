/**
 * The three SSRF opt-ins, driven in a real browser.
 *
 * Two faults, measured on a real install and both about a control nobody can
 * see:
 *
 *   - The wizard's third step drew all three as flat checkboxes at equal
 *     weight with the two fields that matter, so a household pasting a Google
 *     address in their third minute of ownership was asked three security
 *     questions whose answer, for every hosted feed, is no.
 *   - Adding `http://127.0.0.1:…/cal.ics` took **three** submissions. Each
 *     round refused at the first rule and named a remedy — "plain http has to
 *     be turned on for this feed deliberately" — with the `<details>` holding
 *     that switch folded shut underneath it.
 *
 * Both are geometry, which is why they are here rather than in a route test.
 * `details.open` is a property a served attribute sets, and "the household can
 * reach the control" is a box with a size at a point that hits it — a route
 * test reading the HTML for `allow_http` passes just as happily on a checkbox
 * rendered 0px tall inside a closed disclosure, which is exactly the shipped
 * bug. Every assertion below was checked by reverting its own fix.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(options: Parameters<typeof install>[0] = {}): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

async function pageFor(home: Installation): Promise<Page> {
  const ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await home.signIn(page);
  return page;
}

/** The three switches as the household meets them: are they there, and reachable? */
interface Controls {
  /** How many of the three inputs exist inside the form at all. */
  readonly present: number;
  /** `details.open`, the property — undefined when there is no disclosure. */
  readonly disclosureOpen: boolean | undefined;
  /**
   * Per input: whether a click at the middle of its box lands on it.
   *
   * The question a household asks, and the only one worth asserting. A closed
   * `<details>` in current Chromium leaves its contents with a *box* — the
   * switch measures 52x32 shut exactly as it does open — and hides them from
   * painting and hit-testing instead, so "has a size" answers neither
   * direction. `elementFromPoint` answers both: the input itself when the
   * disclosure is open, the row behind it when it is not.
   */
  readonly reachable: Readonly<Record<string, boolean>>;
}

async function controls(page: Page, formAction: string): Promise<Controls> {
  return await page.evaluate((action) => {
    // Scoped to one form. A household with a calendar already added has a
    // second, third and fourth copy of these three controls on the same page —
    // one per settings row — and the row for a self-hosted feed is legitimately
    // open, which is a green assertion about the wrong element.
    const form = document.querySelector(`form[action="${action}"]`);
    if (form === null) throw new Error(`no form with action ${action} on ${location.pathname}`);
    const names = ['allow_lan', 'allow_loopback', 'allow_http'];
    const inputs = names
      .map((name) => [name, form.querySelector(`input[name="${name}"]`)] as const)
      .filter((pair): pair is readonly [string, HTMLInputElement] => pair[1] !== null);
    const details = form.querySelector('details') as HTMLDetailsElement | null;
    const reachable: Record<string, boolean> = {};
    for (const [name, input] of inputs) {
      const rect = input.getBoundingClientRect();
      input.scrollIntoView({ block: 'center' });
      const after = input.getBoundingClientRect();
      const at = document.elementFromPoint(
        after.left + after.width / 2,
        after.top + after.height / 2,
      );
      reachable[name] =
        rect.width > 0 &&
        rect.height > 0 &&
        (at === input || input.closest('label')?.contains(at as Node) === true);
    }
    return {
      present: inputs.length,
      disclosureOpen: details === null ? undefined : details.open,
      reachable,
    };
  }, formAction);
}

/** Every word of the error the household is shown, message and remedy together. */
async function errorText(page: Page): Promise<string> {
  return await page.evaluate(
    () => (document.querySelector('.error') as HTMLElement | null)?.innerText ?? '',
  );
}

describe('the wizard asks for no network access until something needs it', () => {
  it(
    'draws not one of the three on a form nothing has been refused on',
    async () => {
      const home = await fresh();
      const page = await pageFor(home);
      await page.goto(`${home.base}/setup/calendar`, { waitUntil: 'load' });

      const shown = await controls(page, 'setup/calendar');
      expect(
        shown.present,
        'the wizard is still asking a household to make security decisions before ' +
          'anything has gone wrong',
      ).toBe(0);
      expect(await errorText(page)).toBe('');

      // And the two fields that matter are still there — "no controls" must not
      // be a page that failed to render.
      const fields = await page.evaluate(() =>
        Array.from(document.querySelectorAll('form[action="setup/calendar"] input')).map(
          (input) => (input as HTMLInputElement).name,
        ),
      );
      expect(fields).toEqual(['name', 'url']);
    },
    SLOW,
  );

  it(
    'names both refusals in one round, with both switches open and reachable',
    async () => {
      // A real loopback feed on plain http: two of the three rules refuse it,
      // and the guard used to reveal them one submission at a time.
      const home = await fresh({ feed: true });
      const page = await pageFor(home);
      await page.goto(`${home.base}/setup/calendar`, { waitUntil: 'load' });

      await page.fill('form[action="setup/calendar"] input[name="name"]', 'Second calendar');
      await page.fill('form[action="setup/calendar"] input[name="url"]', home.feedUrl!);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.click('form[action="setup/calendar"] button[type="submit"]'),
      ]);

      // One round, and it says both things.
      const said = await errorText(page);
      expect(said, `the refusal does not name the plain-http switch: “${said}”`)
        .toContain('Allow plain http');
      expect(said, `the refusal does not name the loopback switch: “${said}”`)
        .toContain('Allow this machine itself');

      const shown = await controls(page, 'setup/calendar');
      expect(shown.present, 'the controls the error names are not on the page').toBe(3);
      expect(
        shown.disclosureOpen,
        'the disclosure holding the named remedy is shut, which is the whole bug',
      ).toBe(true);
      expect(
        shown.reachable,
        'a switch the error names cannot be clicked',
      ).toEqual({ allow_lan: true, allow_loopback: true, allow_http: true });

      // The proof that it was *one* round: tick what the error named, and the
      // wizard moves on. A third rule waiting behind these two would land back
      // on this step.
      await page.check('input[name="allow_loopback"]', { timeout: 5_000 });
      await page.check('input[name="allow_http"]', { timeout: 5_000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.click('form[action="setup/calendar"] button[type="submit"]'),
      ]);
      expect(
        new URL(page.url()).pathname,
        `still on ${page.url()} — something else was refused that the first round did not name`,
      ).toBe('/setup/place');
      expect(
        home.db.prepare(`SELECT COUNT(*) AS n FROM calendar_sources`).get(),
      ).toEqual({ n: 2 });
    },
    SLOW,
  );

  it(
    'keeps a switch the household has already ticked on screen after a later refusal',
    async () => {
      // A disclosure that appears only on a network refusal must not vanish on
      // the next one: the boxes go with it, and a switch that disappears is a
      // switch silently turned back off.
      const home = await fresh();
      const page = await pageFor(home);
      await page.goto(`${home.base}/setup/calendar`, { waitUntil: 'load' });

      await page.fill('form[action="setup/calendar"] input[name="name"]', 'Nowhere');
      await page.fill('form[action="setup/calendar"] input[name="url"]', 'http://127.0.0.1:9/cal.ics');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.click('form[action="setup/calendar"] button[type="submit"]'),
      ]);
      await page.check('input[name="allow_loopback"]', { timeout: 5_000 });
      await page.check('input[name="allow_http"]', { timeout: 5_000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.click('form[action="setup/calendar"] button[type="submit"]'),
      ]);

      // Port 9 answers nothing, so this round fails on the connection rather
      // than on policy — and both ticks have to survive it.
      const after = await controls(page, 'setup/calendar');
      expect(after.present, 'the switches vanished on a failure that was not about them').toBe(3);
      expect(
        await page.evaluate(() => ({
          loopback: (document.querySelector('input[name="allow_loopback"]') as HTMLInputElement).checked,
          http: (document.querySelector('input[name="allow_http"]') as HTMLInputElement).checked,
        })),
      ).toEqual({ loopback: true, http: true });
    },
    SLOW,
  );
});

describe('the admin add form opens the disclosure it points at', () => {
  it(
    'leaves it shut when nothing has been refused',
    async () => {
      const home = await fresh();
      const page = await pageFor(home);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });

      const shown = await controls(page, 'admin/calendars');
      expect(shown.present).toBe(3);
      expect(
        shown.disclosureOpen,
        'the add form opens Network access with nothing to say, which is three ' +
          'switches in front of every household adding an ordinary feed',
      ).toBe(false);
      // Shut means out of reach: a household adding a hosted feed never meets them.
      expect(shown.reachable).toEqual({
        allow_lan: false,
        allow_loopback: false,
        allow_http: false,
      });
    },
    SLOW,
  );

  it(
    'opens it, and names both switches, on a loopback http address',
    async () => {
      const home = await fresh({ feed: true });
      const page = await pageFor(home);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });

      await page.fill('form[action="admin/calendars"] input[name="name"]', 'Second calendar');
      await page.fill('form[action="admin/calendars"] input[name="url"]', home.feedUrl!);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.click('button[value="save"]'),
      ]);

      const said = await errorText(page);
      expect(said).toContain('Allow plain http');
      expect(said).toContain('Allow this machine itself');

      const shown = await controls(page, 'admin/calendars');
      expect(
        shown.disclosureOpen,
        'the admin form names a remedy inside a disclosure it left shut',
      ).toBe(true);
      expect(shown.reachable).toEqual({
        allow_lan: true,
        allow_loopback: true,
        allow_http: true,
      });
    },
    SLOW,
  );
});
