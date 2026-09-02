/**
 * Tabular figures, on the wall and on the panel — a reflow requirement, not a
 * preference.
 *
 * `display.css` sets `font-variant-numeric: tabular-nums` on `body`, and every
 * other rule inherits it — nothing on this wall may override it back to
 * proportional figures. That matters because a time going from "9:00" to
 * "11:00" is a row whose *width* changes the moment a digit does, and this
 * project measures partial-refresh regions on e-ink and reflow everywhere
 * else: a figure that changes width changes what a browser lays out, which is
 * exactly the class of fault `reflow-stability.test.ts` exists to catch one
 * layer up. Oldstyle figures are the same fault from the other direction —
 * they sit at x-height, so at the type floor a lowercase-height digit falls
 * under the acuity limit this wall's whole arc-minute scale is built on — and
 * `font-variant-numeric: tabular-nums` also rules those out, since a proper
 * numeral face's tabular figures are lining, never oldstyle.
 *
 * So this walks the *rendered* wall rather than the stylesheet: every element
 * carrying its own visible text is asked what `font-variant-numeric` actually
 * computed to, the same way `browser-contrast.test.ts` asks every run what its
 * ink actually resolved to rather than trusting a rule's declared colour. A
 * static sweep of the CSS could miss an inherited value an inline style or a
 * later cascade layer quietly overrides; the computed value cannot lie about
 * what the browser will actually lay out.
 *
 * The panel gets the equivalent question asked the way its medium answers it.
 * `epaper/font.ts` draws a fixed 8×8 bitmap glyph per character — there is no
 * `font-variant-numeric` because there is no proportional figure to begin
 * with, so the panel's assertion is that every glyph, digits included, shares
 * one advance width.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEARDOWN,
  HOUSEHOLD_CALENDARS,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { measureText, TYPE_RUNGS, type TypeRung } from '../src/epaper/font.js';

process.env['TZ'] = 'UTC';

const SLOW = 60_000;

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  link = await wall.pairLink('Kitchen');
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Offender {
  readonly where: string;
  readonly text: string;
  readonly value: string;
}

describe('the wall', () => {
  it(
    'draws every visible run of text with tabular figures',
    async () => {
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const offenders: Offender[] = await page.evaluate(() => {
          const out: { where: string; text: string; value: string }[] = [];
          const where = (el: Element): string => {
            const cls =
              typeof el.className === 'string' && el.className !== ''
                ? '.' + el.className.trim().split(/\s+/).join('.')
                : '';
            return `${el.tagName.toLowerCase()}${cls}`;
          };
          for (const el of Array.from(document.querySelectorAll('*'))) {
            // Only elements that themselves carry a direct, visible run of
            // text — an ancestor's inherited value is exactly what is under
            // test, not a reason to skip it, but a `<div>` with no text of
            // its own has nothing to report that its children will not.
            const own = Array.from(el.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent ?? '')
              .join('');
            if (own.trim() === '') continue;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const value = style.fontVariantNumeric;
            if (!value.split(/\s+/).includes('tabular-nums')) {
              out.push({ where: where(el), text: own.trim().slice(0, 48), value: value || '(normal)' });
            }
          }
          return out;
        });
        expect(
          offenders,
          `elements drawing proportional figures (a reflow hazard):\n` +
            offenders.map((o) => `  ${o.where} "${o.text}" -> ${o.value}`).join('\n'),
        ).toEqual([]);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the panel', () => {
  it('has no proportional figure to begin with — every glyph shares one advance width', () => {
    /*
     * Every bitmap face here is a fixed grid: `measureText` multiplies the
     * glyph count by one constant advance, so any two equal-length strings
     * measure identical whatever digits (or letters) they carry — a stronger
     * property than "tabular", since it holds for every character, not only
     * 0-9. Asserted on **every rung**, because the panel ships three faces now
     * and a proportional one added later would be caught by whichever rung
     * drew it rather than only by the 8x8.
     */
    for (const rung of TYPE_RUNGS as readonly TypeRung[]) {
      const digitsOnly = ['0000', '1111', '9090', '3.14'];
      const widths = digitsOnly.map((s) => measureText(s, { rung }));
      expect(
        new Set(widths).size,
        `${rung.face}@${rung.scale}: expected one width for equal-length strings: ${widths.join(', ')}`,
      ).toBe(1);

      // And a genuinely proportional face would fail this the other way:
      // digits and letters of the same *count* still match, because the width
      // is a function of character count alone, never of which glyph.
      expect(measureText('12:34', { rung })).toBe(measureText('ABCDE', { rung }));
    }
  });
});
