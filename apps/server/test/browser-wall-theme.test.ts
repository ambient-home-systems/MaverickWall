/**
 * One control, in a real browser, at both ends of the journey (RFC 015 phase 3).
 *
 * A wall's theme is chosen twice in its life — once when it is created and
 * afterwards on its own page — and until now those were two different controls
 * over one stored value. Phase 3 makes them the same card grid, which is a
 * claim about markup that `admin-themes.test.ts` can settle, and three claims
 * about *behaviour* that it cannot:
 *
 *  - **nothing is checked when a wall is being created.** That is the mandate
 *    and it is a property of the `checked` DOM flag rather than of a class:
 *    this codebase has shipped a bug where the class was right and the pixels
 *    were wrong, and a radio is where the same mistake is cheapest to make —
 *    a card can carry the ring's own class and post nothing.
 *  - **picking a starting layout suggests a theme and never chooses one.** The
 *    suggestion is written by `template-gallery.js`, so nothing on the server
 *    can see it and nothing in `apps/display`'s own suite can either — there is
 *    no DOM there.
 *  - **the save bar arms on a card change**, which runs through
 *    `settings-form.ts`'s `looksEdited`. It compares a radio against
 *    `defaultChecked` rather than against a value, and that branch had never
 *    been exercised by a real control: every dirty-aware form in the admin was
 *    text, selects and checkboxes until this one.
 *
 * Both viewports, because the creation form is four screens long on a phone
 * and the theme step is the last thing on it before the submit — where a card
 * grid lands, and whether the page has grown a sideways scroll, are the two
 * things that only a narrow viewport can answer.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

process.env['TZ'] = 'UTC';

/** Long: each case boots a server, a browser context and renders fourteen previews. */
const SLOW = 90_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function fresh(): Promise<Installation> {
  const made = await install();
  installations.push(made);
  return made;
}

/**
 * The cards are on the page.
 *
 * `state: 'attached'` rather than the default `visible`, and that is not a
 * workaround: a theme card hides its own radio (`opacity: 0; pointer-events:
 * none`) so the *card* can carry the ring, which is the whole idiom. Waiting
 * for the input to be visible is waiting for something this design says will
 * never happen.
 */
const themeCardsReady = (page: Page): Promise<unknown> =>
  page.waitForSelector('input[name="theme"]', { state: 'attached' });

/**
 * Open a wall's Wall settings pane.
 *
 * The wall's own page opens on Layout. The theme cards sit in Wall settings,
 * under Look. Use both controls so the test also verifies that a person can
 * reach them through the page's navigation.
 */
async function openWallSettings(page: Page): Promise<void> {
  await page.locator('[data-mode="settings"]').click();
  await page.waitForSelector('[data-mode-panel="settings"]:not([hidden])');
  await page.locator('[data-wset="look"]').click();
  await page.waitForSelector('[data-wset-panel="look"]:not([hidden])');
}

/** The one save bar the wall's page has — the editor's, which saves the canvas
 *  and every settings category together. Not `settings-form.ts`'s: this page
 *  runs `display-editor.ts` instead, which is the bar that says "Save wall". */
const saveDisabled = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      document.querySelector<HTMLButtonElement>('#savebar [data-action="save"]')?.disabled ?? true,
  );

/** Every theme card's value and whether its *radio* is checked — never a class. */
const themeState = (page: Page): Promise<{ value: string; checked: boolean; suggestion: string }[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]')).map((input) => {
      const card = input.closest('.themecard');
      const slot = card?.querySelector('.tm-sugg');
      return {
        value: input.value,
        // The DOM flag, which is what the browser posts. A card's ring is drawn
        // from `:has(input:checked)`, so a class here would be asking the
        // stylesheet what the form is going to send.
        checked: input.checked,
        suggestion:
          slot instanceof HTMLElement && !slot.hidden ? (slot.textContent ?? '').trim() : '',
      };
    }),
  );

/** Which starting layout the form is holding. */
const chosenTemplate = (page: Page): Promise<string | undefined> =>
  page.evaluate(
    () => document.querySelector<HTMLInputElement>('input[name="template"]:checked')?.value,
  );

/** Click a card by the radio it wraps, which is the only thing that is stable. */
async function pickCard(page: Page, name: string, value: string): Promise<void> {
  await page.locator(`label:has(input[name="${name}"][value="${value}"])`).first().click();
}

/**
 * What a wall paired at `link` says its theme is, read off the manifest it
 * actually polls.
 *
 * Through the wall's own origin and cookie rather than through the admin,
 * because the claim is about what reaches the glass: the settings page could
 * show any card it liked over a row the manifest resolves differently, which is
 * the whole class of fault the RFC is about one layer up.
 */
async function manifestTheme(context: BrowserContext, link: string): Promise<string> {
  const wall = await context.newPage();
  try {
    await wall.goto(link, { waitUntil: 'load' });
    const body = await wall.evaluate(async () => (await fetch('d/manifest')).text());
    return (JSON.parse(body) as { theme: { active: string } }).theme.active;
  } finally {
    await wall.close();
  }
}

/** The pairing link off the page a freshly created wall lands on. */
function pairingLinkIn(html: string): string {
  const link = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (link === undefined) throw new Error('the pairing page printed no link');
  return link;
}

const VIEWPORTS = [
  { width: 390, height: 844, label: 'a phone' },
  { width: 1280, height: 800, label: 'a laptop' },
] as const;

describe('creating a wall', () => {
  for (const viewport of VIEWPORTS) {
    it(
      `asks for a theme with nothing preselected, on ${viewport.label}`,
      async () => {
        const home = await fresh();
        const context = await (await browser()).newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          const page = await context.newPage();
          await home.signIn(page);
          await page.goto(`${home.base}/admin/walls/new/browser`, { waitUntil: 'load' });
          await themeCardsReady(page);

          // 1. Nothing is chosen. A preselected card is a default wearing a
          //    different hat, and the household would proceed past it exactly
          //    as they proceeded past the household setting this RFC retired.
          const onLoad = await themeState(page);
          expect(onLoad.length, 'no theme cards on the form').toBeGreaterThan(4);
          expect(onLoad.filter((one) => one.checked)).toEqual([]);
          // And the starting layout *is* chosen, which is what says the absence
          // above is deliberate rather than a picker that cannot preselect.
          expect(await chosenTemplate(page)).toBe('classic');

          // 2. Picking Sky Week suggests Paper Almanac — as a word, in that
          //    card, with nothing checked anywhere. Twelve of the fourteen
          //    templates name a theme and applying one writes it, so without
          //    this the household picks Sky Week, picks Panels beside it, and
          //    gets Almanac.
          await pickCard(page, 'template', 'sky-week');
          const suggested = await themeState(page);
          expect(suggested.filter((one) => one.checked), 'a suggestion checked a card').toEqual([]);
          expect(
            suggested.filter((one) => one.suggestion !== '').map((one) => [one.value, one.suggestion]),
          ).toEqual([['almanac', 'Suggested for Sky Week']]);

          // 3. Submitting with no theme is a 400, and everything typed comes
          //    back. The form is a convenience and the POST is the boundary.
          await page.fill('input[name="name"]', 'Kitchen');
          const refused = await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith('/admin/screens') && response.request().method() === 'POST',
              { timeout: 20_000 },
            ),
            page.locator('.addbar button[type="submit"]').click(),
          ]);
          expect(refused[0].status(), 'a body with no theme was accepted').toBe(400);
          /*
           * The re-rendered page, loaded — not merely a theme radio attached.
           * The server draws the cards, so `themeCardsReady` is satisfied the
           * moment the 400's document parses (or by the outgoing one), before
           * `template-gallery.js` has run and written the suggestion this
           * reads; a module script holds the load event, so waiting for it is
           * waiting for the suggestion. Found as one red in a full run, and
           * reproduced every time by delaying that script's fetch.
           */
          await page.waitForURL('**/admin/screens', { waitUntil: 'load' });
          await themeCardsReady(page);
          expect(await page.inputValue('input[name="name"]'), 'the name was thrown away').toBe(
            'Kitchen',
          );
          expect(await chosenTemplate(page), 'the starting layout was thrown away').toBe('sky-week');
          const echoed = await themeState(page);
          expect(echoed.filter((one) => one.checked), 'the refusal preselected a theme').toEqual([]);
          // The suggestion survives the re-render, because it is derived from
          // the echoed template rather than from the click that set it.
          expect(
            echoed.filter((one) => one.suggestion !== '').map((one) => one.value),
          ).toEqual(['almanac']);
          expect(
            (await home.call('/admin/walls')).status,
            'the admin is still reachable after the refusal',
          ).toBe(200);
          expect(home.db.prepare('SELECT count(*) AS n FROM screens').get()).toEqual({ n: 0 });

          // 4. On a phone: where the first card lands, and that asking for a
          //    theme has not given the page a sideways scroll. Recorded rather
          //    than bounded tightly — the number is what a later change is read
          //    against, and the assertion is that the grid is on the page and
          //    the page is not wider than the screen.
          if (viewport.width === 390) {
            const geometry = await page.evaluate(() => {
              const first = document.querySelector('.themegrid .themecard');
              const box = first?.getBoundingClientRect();
              return {
                top: box === undefined ? -1 : Math.round(box.top + window.scrollY),
                width: box === undefined ? -1 : Math.round(box.width),
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
                // The whole form, so the card's position can be read as a
                // share of it rather than as a bare number.
                scrollHeight: document.documentElement.scrollHeight,
              };
            });
            // eslint-disable-next-line no-console
            console.log(
              `[RFC 015 phase 3] 390px: first theme card at y=${geometry.top} of ` +
                `${geometry.scrollHeight}, w=${geometry.width}; page ${geometry.scrollWidth}px ` +
                `in a ${geometry.clientWidth}px viewport`,
            );
            expect(geometry.top, 'no theme card on the page at all').toBeGreaterThan(0);
            expect(
              geometry.scrollWidth,
              'the theme step gave the form a sideways scroll',
            ).toBeLessThanOrEqual(geometry.clientWidth);
            // One column at this width, so a card is the form's own measure
            // less its gutters rather than half of it.
            expect(geometry.width).toBeGreaterThan(geometry.clientWidth * 0.75);
          }

          // 5. Choosing Panels and submitting makes the wall, and the wall
          //    draws Panels — asserted on the manifest rather than on the row,
          //    because the row is not what reaches the glass.
          await pickCard(page, 'theme', 'panels');
          expect((await themeState(page)).filter((one) => one.checked).map((one) => one.value)).toEqual([
            'panels',
          ]);
          expect(await page.locator('[data-template-effect]').textContent()).toContain(
            'Your chosen theme will be used instead; the design’s background remains.',
          );
          const preview = page.locator('.tpl-thumb[data-tpl="sky-week"]');
          await preview.scrollIntoViewIfNeeded();
          await expect.poll(() => preview.evaluate(
            (thumb) => thumb.shadowRoot?.querySelector('[data-theme]')?.getAttribute('data-theme'),
          )).toBe('panels');
          await Promise.all([
            page.waitForURL(/\/admin\/walls\/[^/]+\/pair/, { timeout: 20_000 }),
            page.locator('.addbar button[type="submit"]').click(),
          ]);
          expect(await manifestTheme(context, pairingLinkIn(await page.content()))).toBe('panels');
        } finally {
          await context.close();
        }
      },
      SLOW,
    );
  }
});

describe('a wall that already exists', () => {
  it(
    'opens on the theme it wears, and changing the card changes the wall',
    async () => {
      const home = await fresh();
      const wallId = await home.pairWall('Kitchen');
      // Not the harness default, so "the checked card is this wall's theme" is
      // a reading and not a coincidence of what pairWall happens to post.
      const dressed = await home.post(`/admin/screens/${wallId}`, {
        name: 'Kitchen',
        orientation: 'auto',
        rotation: '0',
        theme: 'almanac',
      });
      expect(dressed.status).toBe(302);
      const link = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(
        await (await home.call(`/admin/walls/${wallId}/pair`)).text(),
      )?.[1];
      expect(link, 'the wall must have a pairing link to draw from').not.toBeUndefined();

      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await home.signIn(page);
        await page.goto(`${home.base}/admin/walls/${wallId}`, { waitUntil: 'load' });
        await openWallSettings(page);
        await themeCardsReady(page);

        // 1. The card the wall wears is the checked one, and it is the only one.
        expect((await themeState(page)).filter((one) => one.checked).map((one) => one.value)).toEqual([
          'almanac',
        ]);

        /*
         * 2. The save bar is off until something changes, and a *card* is
         *    something changing.
         *
         *    This page's bar is `display-editor.ts`'s rather than
         *    `settings-form.ts`'s, because it saves the canvas and the settings
         *    in one action — and it arms on the settings form's own `change`,
         *    which is exactly the event a radio inside a label fires and a
         *    `<select>` fired before it. So the question a browser has to
         *    settle is whether the *label* still delivers one once the input it
         *    wraps is `opacity: 0; pointer-events: none`, which is how every
         *    card in this admin hides its radio.
         */
        expect(await saveDisabled(page), 'Save was live on a page nobody had touched').toBe(true);
        await pickCard(page, 'theme', 'swiss');
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLButtonElement>('#savebar [data-action="save"]')?.disabled ===
            false,
          undefined,
          { timeout: 5_000 },
        );
        expect(await saveDisabled(page), 'the save bar did not arm on a card change').toBe(false);

        // 3. Saving a card change reaches the wall — read off the manifest the
        //    wall polls rather than off the row, because the row is not what
        //    reaches the glass.
        await Promise.all([
          page.waitForURL(/\/admin\/walls\//, { timeout: 30_000 }),
          page.locator('#savebar [data-action="save"]').click(),
        ]);
        expect(await manifestTheme(context, link as string)).toBe('swiss');
        // And the page comes back opened on what it now wears.
        await page.goto(`${home.base}/admin/walls/${wallId}`, { waitUntil: 'load' });
        await openWallSettings(page);
        await themeCardsReady(page);
        expect((await themeState(page)).filter((one) => one.checked).map((one) => one.value)).toEqual([
          'swiss',
        ]);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'reaches every theme card by keyboard, and rings the one it is on',
    async () => {
      /*
       * The card hides its own radio (`opacity: 0; pointer-events: none`), so
       * everything a keyboard does here depends on the input still being in the
       * tab order and the ring being drawn on the *card* through `:has()`.
       * Measured off the computed value rather than off a class: this codebase
       * has shipped a focus ring that computed to 0px with its class applied,
       * and the chore tick's own lesson is to assert on the computed paint.
       */
      const home = await fresh();
      const wallId = await home.pairWall('Kitchen');
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await home.signIn(page);
        await page.goto(`${home.base}/admin/walls/${wallId}`, { waitUntil: 'load' });
        await openWallSettings(page);
        await themeCardsReady(page);

        // The checked card carries the selection ring — a box-shadow, because a
        // wall's settings sheet has a dozen bordered rows and an outline here
        // would be a second border on one of them.
        const rings = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]')).map(
            (input) => {
              const card = input.closest('.themecard') as HTMLElement;
              const style = window.getComputedStyle(card);
              return {
                value: input.value,
                checked: input.checked,
                shadow: style.boxShadow,
              };
            },
          ),
        );
        const checked = rings.filter((one) => one.checked);
        const rest = rings.filter((one) => !one.checked);
        expect(checked).toHaveLength(1);
        expect(checked[0]?.shadow, 'the checked card is not ringed').not.toBe('none');
        expect(
          rest.map((one) => one.shadow),
          'an unchecked card is ringed too, so the ring says nothing',
        ).toEqual(rest.map(() => 'none'));

        /*
         * Reached by Tab, from the control that opens the pane — not by
         * `element.focus()`.
         *
         * Both halves of this need the keyboard rather than a script. The ring
         * is `:focus-visible`, which Chromium decides from the *modality*: a
         * programmatic focus does not set it, so an assertion written that way
         * reads 0px on a page whose rule is perfectly correct. And "reachable
         * by keyboard" is the claim itself — the card hides its own radio, and
         * a hidden input is one `tabindex="-1"` away from being unreachable
         * while every measurement of it still passes.
         */
        await page.locator('[data-wset="look"]').focus();
        let hops = 0;
        let onCard = false;
        while (hops < 40 && !onCard) {
          await page.keyboard.press('Tab');
          hops += 1;
          onCard = await page.evaluate(
            () =>
              document.activeElement instanceof HTMLInputElement &&
              document.activeElement.name === 'theme',
          );
        }
        expect(onCard, `no theme card reached by Tab in ${hops} presses`).toBe(true);

        const focused = await page.evaluate(() => {
          const input = document.activeElement as HTMLInputElement;
          const card = input.closest('.themecard') as HTMLElement;
          return {
            value: input.value,
            // The card's own ring, drawn through `:has(input:focus-visible)`
            // because the input it wraps is invisible. Read off the computed
            // value: this codebase has shipped a focus ring that computed to
            // 0px with its class applied.
            outline: window.getComputedStyle(card).outlineWidth,
          };
        });
        expect(focused.value, 'Tab landed somewhere other than the first card').toBe('panels');
        expect(
          Number.parseFloat(focused.outline),
          'the focused card draws no ring, on a control whose own input is invisible',
        ).toBeGreaterThan(0);

        // And the arrow keys move between them, which is what a radio group is
        // for and what a grid of labels could silently have broken.
        await page.keyboard.press('ArrowDown');
        const moved = await page.evaluate(
          () => document.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.value,
        );
        expect(moved, 'an arrow key did not move within the group').toBe('household');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
