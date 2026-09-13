/**
 * The starting-layout picker on both add pages shows a picture of each layout.
 *
 * The report, of a control offering fourteen names on the one screen where a
 * household has never seen any of them: "it's impossible to know what Classic
 * is, or Meeting Room, from just text."
 *
 * Both pages used to argue in a comment that a card could not be previewed
 * there — a wall's because "a card previews by rendering the canvas a screen
 * owns and this screen does not exist yet", a panel's because it posts to
 * `…/:id/preview.png` and there is no `:id` before the form is submitted. Both
 * were about the *route* rather than the renderer: a wall card is drawn from
 * the **template's** canvas and the screen supplies only the manifest, and a
 * panel frame needs a manifest and a shape, which the form holds. So neither
 * page grew a second renderer — the wall cards are `renderFreeform` through
 * the gallery's own script, and the panel cards are `renderScreenFrame`.
 *
 * Everything here is measured in a real browser rather than read out of the
 * markup, because the markup was never the question: the picker is a radio
 * grid whether or not one pixel of a preview ever lands.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

process.env['TZ'] = 'UTC';

/** Long: each case boots a server, a browser context and renders previews. */
const SLOW = 60_000;

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

/** How many template thumbs have actually been drawn into, and how many exist. */
const drawn = (page: Page): Promise<{ total: number; wall: number; ink: number }> =>
  page.evaluate(() => {
    const thumbs = Array.from(document.querySelectorAll<HTMLElement>('.tpl-thumb[data-tpl]'));
    return {
      total: thumbs.length,
      // A wall card is a shadow root with the wall's own markup inside it.
      wall: thumbs.filter(
        (thumb) => (thumb.shadowRoot?.querySelectorAll('*').length ?? 0) > 3,
      ).length,
      // A panel card is a real PNG that decoded.
      ink: thumbs.filter((thumb) => {
        const image = thumb.querySelector('img.tpl-ink');
        return image instanceof HTMLImageElement && image.naturalWidth > 0;
      }).length,
    };
  });

/**
 * Bring every card into view, so every one of them is asked to draw.
 *
 * The gallery renders lazily on `IntersectionObserver` — deliberately, so a
 * dozen live walls do not all render at once — and an observer reports the
 * state it samples, not the ground a jump scrolled over. Going straight to the
 * foot of the page therefore covers the first row (visible at load) and the
 * last, and whether anything between them is ever observed is a fact about how
 * many columns this viewport happens to give the grid. It held at 1280px with
 * three rows and would not at a narrower one.
 *
 * Stepping a viewport at a time also spreads the work, which is the other half:
 * the first version asked for fourteen shadow-root wall renders at once and
 * failed about one full-suite run in three on a loaded machine.
 */
async function revealEveryCard(page: Page): Promise<void> {
  const step = await page.evaluate(() => window.innerHeight);
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }
}

describe('adding a browser wall', () => {
  it(
    'draws every template rather than naming it',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({
        viewport: { width: 1280, height: 900 },
      });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/new`, { waitUntil: 'load' });
        await page.waitForSelector('.tpl-thumb[data-tpl]');
        await revealEveryCard(page);
        await page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll('.tpl-thumb[data-tpl]')).every(
              (thumb) => (thumb.shadowRoot?.querySelectorAll('*').length ?? 0) > 3,
            ),
          undefined,
          { timeout: 20_000 },
        );
        const seen = await drawn(page);
        expect(seen.total, 'no template cards on the page at all').toBeGreaterThan(5);
        expect(seen.wall, 'a card is a name in a box shaped like a preview').toBe(seen.total);

        /*
         * And the picker is still a picker. The cards carry the same field name
         * and the same values the select did, so the handler cannot tell the
         * difference — but only a real click proves the label wraps its radio.
         */
        const before = await page.evaluate(
          () => document.querySelector<HTMLInputElement>('input[name="template"]:checked')?.value,
        );
        expect(before, 'nothing is chosen when the form opens').toBe('classic');
        await page.locator('.tplpick', { hasText: 'Sky Week' }).first().click();
        const after = await page.evaluate(
          () => document.querySelector<HTMLInputElement>('input[name="template"]:checked')?.value,
        );
        expect(after, 'clicking a card did not choose it').toBe('sky-week');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

describe('adding an e-paper panel', () => {
  it(
    'draws a real frame per layout, at the panel the form is holding',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({
        viewport: { width: 1280, height: 900 },
      });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/epaper`, { waitUntil: 'load' });
        await page.waitForSelector('.tpl-thumb[data-tpl]');
        await revealEveryCard(page);
        const allInk = (): Promise<void> =>
          page
            .waitForFunction(
              () =>
                Array.from(document.querySelectorAll('.tpl-thumb[data-tpl]')).every((thumb) => {
                  const image = thumb.querySelector('img.tpl-ink');
                  return image instanceof HTMLImageElement && image.naturalWidth > 0;
                }),
              undefined,
              { timeout: 30_000 },
            )
            .then(() => undefined);
        await allInk();
        const seen = await drawn(page);
        expect(seen.total, 'no layout cards on the page at all').toBeGreaterThan(3);
        expect(seen.ink, 'a card never got its frame').toBe(seen.total);

        /*
         * The frame is the panel's, not a nominal one — which is the whole
         * reason the geometry travels in the request rather than being
         * defaulted on the server. The default preset is 800x480; picking the
         * 2.9" panel must redraw every card at 296x128, and this is the
         * assertion a card rendered at a fixed size passes over.
         */
        const width = (): Promise<number> =>
          page.evaluate(
            () =>
              (document.querySelector('.tpl-thumb[data-tpl] img.tpl-ink') as HTMLImageElement)
                .naturalWidth,
          );
        expect(await width(), 'the default panel is 800x480').toBe(800);

        await page.selectOption('select[name="preset"]', 'waveshare-2in9');
        /*
         * Every card, not the first one to come back.
         *
         * The redraws run one at a time and the old frame stays on a card until
         * its own replacement lands, so "some card is 296 now" is true a long
         * way before the strip agrees with itself — which is what the first
         * draft of this waited for, and it read `{296, 800}` a moment later.
         * The wait is allowed to give up rather than throw, so the assertion
         * under it is what reports, with the widths it actually found.
         */
        const allAt = (px: number): Promise<unknown> =>
          page
            .waitForFunction(
              (want) =>
                Array.from(document.querySelectorAll('.tpl-thumb[data-tpl] img.tpl-ink')).every(
                  (image) => (image as HTMLImageElement).naturalWidth === want,
                ),
              px,
              { timeout: 30_000 },
            )
            .catch(() => undefined);
        await allAt(296);
        const widths = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.tpl-thumb[data-tpl] img.tpl-ink')).map(
            (image) => (image as HTMLImageElement).naturalWidth,
          ),
        );
        expect(widths.length, 'a card lost its frame in the redraw').toBe(seen.total);
        expect(new Set(widths), 'the cards kept the old panel’s shape').toEqual(new Set([296]));

        /*
         * The built-in card is the built-in *renderer*, not the template that
         * approximates it.
         *
         * A panel with no canvas draws `renderEpaper`, whose measurements are
         * arithmetic on the panel; `panel-built-in` is stored fractions
         * approximating that, and it sits two cards along under its own name.
         * The one card whose whole claim is "this is what it draws out of the
         * box" is the one that must not be drawn from the approximation — so
         * the assertion is that the two frames differ, which is the only thing
         * that can tell them apart from outside.
         */
        const frameOf = (value: string): Promise<string> =>
          page.evaluate(
            (id) =>
              (
                document.querySelector(
                  `input[name="layout"][value="${id}"]`,
                ) as HTMLInputElement | null
              )
                ?.closest('.tplpick')
                ?.querySelector<HTMLImageElement>('img.tpl-ink')?.src ?? '',
            value,
          );
        const bytes = async (value: string): Promise<number[]> => {
          const src = await frameOf(value);
          expect(src, `${value} drew no frame at all`).not.toBe('');
          return page.evaluate(
            async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
            src,
          );
        };
        const builtin = await bytes('builtin');
        expect(
          builtin,
          'the built-in card is drawing the template that approximates it',
        ).not.toEqual(await bytes('panel-built-in'));
        /*
         * And not an empty canvas either, which is the mistake with nothing to
         * see: the card asks for the built-in view with a `builtin` flag beside
         * an empty `widgets`, so a server that reads the widgets and ignores the
         * flag draws Blank — a real frame, different from `panel-built-in`, and
         * wrong. Only Blank's own card can tell.
         */
        expect(builtin, 'the built-in card drew an empty canvas').not.toEqual(
          await bytes('panel-blank'),
        );
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

describe('the submit on a phone', () => {
  /**
   * Reachable at any depth, and nothing painting over it.
   *
   * Measured at 390x844: giving every starting layout a picture made the
   * add-a-wall page **3,804px** — four and a half screens — and left "Add wall"
   * at the bottom of it. The only field a household must fill in is the name at
   * the top and the picker already arrives on Classic, so the shortest real
   * journey is "type Kitchen, press Add wall" and it ended in a scroll past
   * fourteen previews of decisions already taken.
   *
   * The desktop half is asserted too, and it is what makes this a breakpoint
   * rather than a habit: above 900px the button is an ordinary submit at the
   * end of an ordinary form, so on a document taller than the viewport it is
   * *below the fold* at the top of the page. A sticky bar leaking to the
   * desktop turns that green→red.
   */
  it(
    'rides the foot of a phone at every scroll depth, and does not on a desktop',
    async () => {
      const wall = await fresh();
      for (const [width, height, sticky] of [
        [390, 844, true],
        [1280, 900, false],
      ] as const) {
        const context = await (await browser()).newContext({
          viewport: { width, height },
          ...(sticky ? { isMobile: true, hasTouch: true } : {}),
        });
        try {
          const page = await context.newPage();
          await wall.signIn(page);
          for (const path of ['/admin/walls/new', '/admin/epaper']) {
            await page.goto(`${wall.base}${path}`, { waitUntil: 'load' });
            await page.waitForSelector('.addbar button');
            const doc = await page.evaluate(() => document.body.scrollHeight);
            expect(
              doc,
              `${path} at ${width}px is shorter than the viewport, so nothing here is being tested`,
            ).toBeGreaterThan(height);

            const at = async (
              y: number,
            ): Promise<{ inView: boolean; h: number; onTop: boolean; covered: string[] }> => {
              await page.evaluate((to) => window.scrollTo(0, to), y);
              await page.evaluate(
                () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
              );
              return page.evaluate(() => {
                const button = document.querySelector('.addbar button') as HTMLElement;
                const r = button.getBoundingClientRect();
                /*
                 * What is actually painted along the button, not what the
                 * stylesheet says about stacking, and not one point of it.
                 *
                 * At z-index 2 a card's thumb drew over this bar and every
                 * rectangle here still measured correct — the words on the
                 * glass were a card's. The first version of this probed the
                 * button's *centre*, which the card did not reach, so the
                 * assertion was green against the exact bug a screenshot had
                 * already shown. It walks the width now.
                 */
                const y = Math.round(r.top + r.height / 2);
                const xs = [0.08, 0.25, 0.5, 0.75, 0.92].map((f) =>
                  Math.round(r.left + r.width * f),
                );
                const covered = xs
                  .map((x) => {
                    const top = document.elementFromPoint(x, y);
                    if (top === null || top === button || button.contains(top)) return '';
                    return `${x}px: ${top.tagName.toLowerCase()}.${top.className || '(none)'}`;
                  })
                  .filter((one) => one !== '');
                return {
                  inView: r.top < window.innerHeight && r.bottom > 0,
                  h: Math.round(r.height),
                  onTop: covered.length === 0,
                  covered,
                };
              });
            };

            if (sticky) {
              for (const fraction of [0, 0.3, 0.6, 1]) {
                const seen = await at(Math.round(doc * fraction));
                expect(
                  seen.inView,
                  `${path}: the submit is off screen ${Math.round(fraction * 100)}% down a ${doc}px page`,
                ).toBe(true);
                expect(
                  seen.covered,
                  `${path}: something is painted over the submit ${Math.round(fraction * 100)}% down`,
                ).toEqual([]);
                // A finger, not a pointer: the admin's own token for it is 44px.
                expect(seen.h, `${path}: the submit is ${seen.h}px tall on a phone`).toBeGreaterThanOrEqual(44);
              }
            } else {
              expect(
                (await at(0)).inView,
                `${path}: the submit is pinned to the viewport on a desktop, where the page is two screens`,
              ).toBe(false);
              expect(
                (await at(doc)).inView,
                `${path}: the submit cannot be reached at the foot of the page`,
              ).toBe(true);
            }
          }
        } finally {
          await context.close();
        }
      }
    },
    SLOW,
  );
});
