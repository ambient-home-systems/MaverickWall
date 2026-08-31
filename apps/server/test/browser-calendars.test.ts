/**
 * The Calendars page's action hierarchy, measured in a real browser.
 *
 * The page inverted its own hierarchy three ways: "Test feed" — an optional
 * diagnostic — was the filled primary while "Add", the one thing the screen
 * exists to do, was the outlined secondary; "Sync now" and "Remove" sat
 * adjacent at identical weight, a destructive action one mis-tap from a safe
 * one; and a second filled "Add a calendar" rode the app bar while the form it
 * would scroll to was already on screen.
 *
 * Every assertion here is on a **computed** colour or a measured rectangle,
 * never on a class name. This codebase has shipped a bug where the class was
 * applied and the pixels were wrong (`.ch-tick` clearing the background it was
 * meant to fill) and the measurement that counted the class passed over it.
 *
 * `:hover` and `:active` are measured with a real pointer rather than forced
 * through the debugger, because the fault they guard against is exactly a
 * state rule winning by specificity: `button,.btn` is the filled variant and
 * its state rules are (0,1,1), so a control that clears its background at rest
 * fills with **primary** the moment a finger touches it and draws its label in
 * a colour picked for a different ground. Gold on gold.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(): Promise<Installation> {
  const made = await install({ feed: true });
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

// ---------------------------------------------------------------------------
// Colour, read off the glass
// ---------------------------------------------------------------------------

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Only ever this test's own `rgb(r, g, b)` output — see `resolve` in `paint`. */
function parseRgb(value: string): Rgb {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  expect(match, `${value} is not a colour this test can read`).not.toBeNull();
  const [, r, g, b] = match as RegExpExecArray;
  return { r: Number(r), g: Number(g), b: Number(b) };
}

function luminance(c: Rgb): number {
  const channel = (raw: number): number => {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

const near = (a: Rgb, b: Rgb): boolean =>
  Math.abs(a.r - b.r) < 6 && Math.abs(a.g - b.g) < 6 && Math.abs(a.b - b.b) < 6;

const show = (c: Rgb): string => `rgb(${c.r}, ${c.g}, ${c.b})`;

/**
 * What a control is actually painted with, and what its label is painted in.
 *
 * The background is **composited**, not read: a control that clears its ground
 * reports `rgba(0,0,0,0)`, which says nothing about the pixels — the answer is
 * whatever ancestor is actually opaque behind it, with any translucent layer
 * over the top mixed in. Reading the declaration instead is how "the class was
 * applied and the pixels were wrong" survives a measurement.
 */
async function paint(page: Page, selector: string): Promise<{ bg: Rgb; ink: Rgb }> {
  const read = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const mix = (over: number[], under: number[]): number[] => {
      const a = over[3] ?? 1;
      return [0, 1, 2].map((i) => (over[i] as number) * a + (under[i] as number) * (1 - a));
    };
    /*
     * Resolve whatever the browser says into real channels, by painting it.
     *
     * Chromium serialises `color-mix()` as `oklab(0.514848 0.0319083 …)` —
     * not `rgb()`, not `color(srgb …)` — and every interaction wash in this
     * stylesheet is a color-mix. Parsing the string is how a measurement ends
     * up wrong about the pixels: this project has already recorded three
     * failed attempts at exactly that, one of which read srgb's 0–1 floats as
     * 0–255. A 2D context accepts any CSS colour and hands back the bytes it
     * would paint, which is the thing under test.
     */
    const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    const numbers = (value: string): number[] => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = 'rgba(0, 0, 0, 0)';
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      // ImageData is un-premultiplied by definition, so the channels are the
      // colour and the fourth is its alpha.
      return [d[0] as number, d[1] as number, d[2] as number, (d[3] as number) / 255];
    };
    // Walk up collecting layers, stopping at the first fully opaque one.
    const layers: number[][] = [];
    let node: Element | null = el;
    while (node !== null) {
      const layer = numbers(getComputedStyle(node).backgroundColor);
      if ((layer[3] as number) > 0) layers.push(layer);
      if ((layer[3] as number) >= 1) break;
      node = node.parentElement;
    }
    if (layers.length === 0) layers.push([255, 255, 255, 1]);
    let out = layers[layers.length - 1] as number[];
    for (let i = layers.length - 2; i >= 0; i--) out = mix(layers[i] as number[], out);
    const ink = numbers(getComputedStyle(el).color);
    return {
      bg: `rgb(${Math.round(out[0] as number)}, ${Math.round(out[1] as number)}, ${Math.round(out[2] as number)})`,
      ink: `rgb(${Math.round(ink[0] as number)}, ${Math.round(ink[1] as number)}, ${Math.round(ink[2] as number)})`,
    };
  }, selector);
  expect(read, `${selector} is on the page`).not.toBeNull();
  const found = read as { bg: string; ink: string };
  return { bg: parseRgb(found.bg), ink: parseRgb(found.ink) };
}

/**
 * Whether a control declares a ground of its own — the filled variant's one
 * distinguishing fact, and the thing the hierarchy is made of.
 *
 * Read off the element's *own* background rather than by comparing composites,
 * because the two controls under test sit on different grounds: the add form's
 * buttons are on the page, and Sync now is inside a `.card`, which is a step
 * lighter. "Differs from the page" would call the card's own ground a fill.
 */
async function hasOwnGround(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return false;
    const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = 'rgba(0, 0, 0, 0)';
    probe.fillStyle = getComputedStyle(el).backgroundColor;
    probe.fillRect(0, 0, 1, 1);
    return (probe.getImageData(0, 0, 1, 1).data[3] as number) / 255 >= 0.99;
  }, selector);
}

/** Rest, hover and pressed — with a real pointer, on a real element. */
async function threeStates(
  page: Page,
  selector: string,
): Promise<{ rest: { bg: Rgb; ink: Rgb }; hover: { bg: Rgb; ink: Rgb }; press: { bg: Rgb; ink: Rgb } }> {
  await page.mouse.move(0, 0);
  const rest = await paint(page, selector);
  await page.hover(selector);
  const hover = await paint(page, selector);
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} has a box`).not.toBeNull();
  const at = box as { x: number; y: number; width: number; height: number };
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  const press = await paint(page, selector);
  /*
   * Release somewhere else, deliberately. A down-then-up over the same point
   * is a click, and two of the controls measured here navigate — the pressed
   * state would activate the very thing it is measuring and destroy the
   * execution context mid-test.
   */
  await page.mouse.move(0, 0);
  await page.mouse.up();
  return { rest, hover, press };
}

async function signedInCalendars(): Promise<{ page: Page; home: Installation }> {
  const home = await fresh();
  const context = await (await browser()).newContext();
  const page = await context.newPage();
  await home.signIn(page);
  await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });
  return { page, home };
}

const ADD = 'form[action="admin/calendars"] button[value="save"]';
const TEST = 'form[action="admin/calendars"] button[value="test"]';
const SYNC = '.card form[action$="/sync"] button';
/** By its words, not its treatment — the treatment is what is under test. */
const REMOVE = /^Remove/;

// ===========================================================================

describe('the Calendars page action hierarchy', () => {
  it(
    'draws Add as the filled primary and Test feed as a secondary, in every state',
    async () => {
      const { page } = await signedInCalendars();

      const add = await threeStates(page, ADD);
      const test = await threeStates(page, TEST);
      const sync = await threeStates(page, SYNC);
      /*
       * The claim is absolute, not relational: **Add** is the control with a
       * ground of its own, and the other two are not. Asserting only "these
       * two differ" would pass just as happily with them swapped, which is the
       * inversion being fixed.
       */
      expect(
        await hasOwnGround(page, ADD),
        'Add is the filled primary, not an outline',
      ).toBe(true);
      expect(
        await hasOwnGround(page, TEST),
        'Test feed is the optional diagnostic and carries no ground of its own',
      ).toBe(false);
      expect(await hasOwnGround(page, SYNC), 'Sync now carries no ground either').toBe(false);

      // The primary carries a ground of its own and reads on it.
      expect(contrast(add.rest.bg, add.rest.ink)).toBeGreaterThanOrEqual(4.5);

      /*
       * And the secondaries never take the primary's ground under a pointer.
       * `button,.btn`'s state rules are (0,1,1) and beat any single-class rule,
       * so a control that clears its background at rest can still fill with
       * primary on hover or press and draw its label in a colour picked for a
       * different ground. `:active` is the half that matters on a phone.
       */
      for (const [name, states] of [
        ['Test feed', test],
        ['Sync now', sync],
      ] as const) {
        for (const [state, one] of [
          ['rest', states.rest],
          ['hover', states.hover],
          ['pressed', states.press],
        ] as const) {
          expect(
            near(add.rest.bg, one.bg),
            `${name} takes the primary's ground at ${state}: ${show(one.bg)}`,
          ).toBe(false);
          expect(
            contrast(one.bg, one.ink),
            `${name} at ${state}: ${show(one.ink)} on ${show(one.bg)}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
    SLOW,
  );

  it(
    'has one primary on the screen: no app-bar Add competing with the form',
    async () => {
      const { page } = await signedInCalendars();

      const addBox = await page.locator(ADD).boundingBox();
      expect(addBox, 'the add form is on screen').not.toBeNull();

      /*
       * Every *filled* control on the page, by its pixels: a background of its
       * own that is opaque and is not the page's ground. There must be one,
       * and it must be the thing this screen exists to do.
       */
      const filled = await page.evaluate(() => {
        // Painted, not parsed — Chromium serialises color-mix() as oklab().
        const probe = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
        const bytes = (value: string): number[] => {
          probe.clearRect(0, 0, 1, 1);
          probe.fillStyle = 'rgba(0, 0, 0, 0)';
          probe.fillStyle = value;
          probe.fillRect(0, 0, 1, 1);
          const d = probe.getImageData(0, 0, 1, 1).data;
          return [d[0] as number, d[1] as number, d[2] as number, (d[3] as number) / 255];
        };
        const ground = bytes(getComputedStyle(document.body).backgroundColor);
        const out: string[] = [];
        /*
         * The page's own content, not the shell. The sidebar's theme picker
         * paints its selected segment with a tint — a *selection state*, not an
         * action — and it is set by script after load, so counting it would
         * make this assertion depend on whether the script beat the
         * measurement. "One primary per screen" is a claim about the screen.
         */
        const main = document.getElementById('mw-main') as HTMLElement;
        for (const el of main.querySelectorAll('button, a.btn, .btn')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          const own = bytes(getComputedStyle(el).backgroundColor);
          if ((own[3] as number) < 0.99) continue;
          const same = [0, 1, 2].every(
            (i) => Math.abs((own[i] as number) - (ground[i] as number)) < 6,
          );
          if (!same) out.push((el.textContent ?? '').trim());
        }
        return out;
      });
      expect(filled, 'exactly one filled button on the screen, and it is Add').toEqual(['Add']);
    },
    SLOW,
  );

  it(
    'keeps the ⋮ and its menu inside the card and the viewport on a phone',
    async () => {
      const { page } = await signedInCalendars();
      await page.setViewportSize({ width: 390, height: 844 });

      const button = page.locator('.card .ovf-btn').first();
      const card = page.locator('.card').first();
      const buttonBox = await button.boundingBox();
      const cardBox = await card.boundingBox();
      expect(buttonBox, 'the ⋮ is on screen').not.toBeNull();
      const at = buttonBox as { x: number; y: number; width: number; height: number };
      const on = cardBox as { x: number; y: number; width: number; height: number };

      // The touch minimum, on the device this is read on.
      expect(at.width).toBeGreaterThanOrEqual(44);
      expect(at.height).toBeGreaterThanOrEqual(44);
      // Inside the card it belongs to, not hanging off it.
      expect(at.x + at.width).toBeLessThanOrEqual(on.x + on.width + 1);
      expect(at.y).toBeGreaterThanOrEqual(on.y - 1);

      // And the menu it opens fits the screen. It is right-anchored and
      // min(280px, 88vw) wide, which is only true if the anchor is near the
      // right edge — a menu that opens off the side of a 390px phone is a
      // menu nobody can read the far half of.
      await button.click();
      const menu = await page.locator('.card .ovf-menu').first().boundingBox();
      expect(menu, 'the menu opens').not.toBeNull();
      const box = menu as { x: number; y: number; width: number; height: number };
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    },
    SLOW,
  );

  it(
    'keeps Remove off the glass until the overflow is opened, and still confirms',
    async () => {
      const { page, home } = await signedInCalendars();

      const card = page.locator('.card').first();
      const remove = card.locator('button', { hasText: REMOVE }).first();

      /*
       * Nothing on the glass at rest, which is the geometric form of "not one
       * mis-tap from Sync now". A closed <details> reports a real origin and a
       * zero area rather than no box at all, so the assertion is on the area.
       */
      const shut = await remove.boundingBox();
      expect((shut?.width ?? 0) * (shut?.height ?? 0), 'Remove is not drawn at rest').toBe(0);

      const sync = await page.locator(SYNC).boundingBox();
      expect(sync, 'Sync now is on screen').not.toBeNull();

      await page.locator('.card .ovf-btn').first().click();
      const openBox = await remove.boundingBox();
      expect((openBox?.width ?? 0) * (openBox?.height ?? 0), 'the menu opens').toBeGreaterThan(0);

      // Painted as destructive, on a ground that is not the primary's, in
      // every state — the menu row clears its background, which is exactly
      // the class of control that fills with primary on press.
      const removeStates = await threeStates(page, '.card .ovf-menu button');
      const primaryBg = (await paint(page, ADD)).bg;
      for (const [state, one] of [
        ['rest', removeStates.rest],
        ['hover', removeStates.hover],
        ['pressed', removeStates.press],
      ] as const) {
        expect(near(one.bg, primaryBg), `Remove takes the primary ground at ${state}`).toBe(false);
        expect(contrast(one.bg, one.ink), `Remove at ${state}`).toBeGreaterThanOrEqual(4.5);
      }
      // And it is not painted the same ink as the safe action beside it.
      const syncInk = (await paint(page, SYNC)).ink;
      expect(near(removeStates.rest.ink, syncInk), 'Remove reads as destructive').toBe(false);

      // Reachable, and it still asks. (The menu is a <details> and this page
      // ships no script, so it is still open — clicking the ⋮ again would shut
      // it, which is how the first version of this test timed out.)
      await remove.click();
      // A GET form with no fields still submits with a trailing "?", which is
      // pre-existing and not what is under test here.
      await page.waitForURL(/\/delete(\?|$)/);
      expect(await page.textContent('body')).toContain('Family');
      expect(home.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 1 });
    },
    SLOW,
  );
});
