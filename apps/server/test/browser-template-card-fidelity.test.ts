/**
 * A gallery card is a *picture of the wall*, and this measures that it is one.
 *
 * `browser-add-display-previews.test.ts` next door asks whether a card is drawn
 * at all — it counts shadow roots with something in them, which is the right
 * question for "the picker names fourteen layouts a household has never seen"
 * and is blind to the one asked here. Reported from the add-a-wall page with a
 * screenshot: "the samples provided to view are not accurate representations".
 * They were not. Measured on the Classic card against the same Classic wall
 * paired at 1080x1920, every rem-sized run on the card came out **5.02x** its
 * proper share of the frame — `.dr-dow`, `.dr-empty`, `.dr-mon` and
 * `.section-label` at five times, `.hz-head` and `.hz-num` at 2.7-3.3x where a
 * `max()` bounded them — while `.clock` and `.today-date`, the two that size
 * from their own box rather than in rem, were exact. Type five times too large
 * then reads back through the density tiers as a box with no room in it, so the
 * card drew *less* as well as larger.
 *
 * Three faults, one place: a shadow root has no `<html>` and no `<body>`, so
 * `html { font-size: var(--root-size) }`, every `:root` block and every `body`
 * declaration in `display.css` were dead inside both admin previews. The fixes
 * are in `apps/display/src/preview-css.ts` and the reasoning is there.
 *
 * ## What is asserted, and why it is a ratio
 *
 * Against the **same installation's** own wall rather than against recorded
 * numbers. A baseline would go stale the first time anybody moved a type role,
 * and worse, it would go stale *silently in the direction of agreeing with
 * itself* — this file's whole subject is a preview that had drifted from the
 * thing it previews, and a constant cannot tell you two pictures disagree.
 *
 * The card is drawn at a reference resolution and transformed down, so every
 * size here is read against each root's own **layout** height (`offsetHeight`,
 * which a transform does not touch) rather than its drawn rectangle. That makes
 * both readings a share of their frame, which is the only form in which a
 * 900x1600 card and a 1080x1920 wall can be compared at all.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

process.env['TZ'] = 'UTC';

/** Long: this boots a server, pairs a wall, and renders it twice. */
const SLOW = 90_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Run {
  readonly cls: string;
  readonly px: number;
  readonly fam: string;
  readonly lh: string;
  readonly num: string;
}
interface Scan {
  readonly frame: { readonly w: number; readonly h: number };
  readonly cursor: string;
  readonly runs: readonly Run[];
}

/**
 * Every visible run of text under a root, with the sizes that decide how it is
 * laid out — and the frame's own **layout** size, so a transformed card and an
 * untransformed wall both report a share of themselves.
 */
const SCAN = (root: string, host: string | null): string => `
(() => {
  const w = ${host === null ? `document.querySelector('${root}')` : `document.querySelector('${host}').shadowRoot.querySelector('${root}')`};
  const runs = [];
  const walk = document.createTreeWalker(w, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if ((n.textContent || '').trim() === '') continue;
    const el = n.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    runs.push({
      cls: String(el.className).split(' ')[0],
      px: parseFloat(cs.fontSize),
      fam: cs.fontFamily,
      lh: cs.lineHeight,
      num: cs.fontVariantNumeric,
    });
  }
  return { frame: { w: w.offsetWidth, h: w.offsetHeight }, cursor: getComputedStyle(w).cursor, runs };
})()`;

/** Each class's mean size as a percentage of its own frame's height. */
function sharePerClass(scan: Scan): Map<string, number> {
  const seen = new Map<string, number[]>();
  for (const run of scan.runs) {
    const share = (run.px / scan.frame.h) * 100;
    const had = seen.get(run.cls);
    if (had === undefined) seen.set(run.cls, [share]);
    else had.push(share);
  }
  const out = new Map<string, number>();
  for (const [cls, all] of seen) out.set(cls, all.reduce((a, b) => a + b, 0) / all.length);
  return out;
}

describe('a starting-layout card against the wall it is a picture of', () => {
  it(
    'draws every type role at the share of the frame the wall draws it at',
    async () => {
      const wall = await install();
      installations.push(wall);

      // The wall itself: Classic, which is what a new wall is seeded with and
      // what the card the picker opens on offers.
      const link = await wall.pairLink('Kitchen');
      const real = await loadWallSettled(link, { width: 1080, height: 1920 });
      const onWall = (await real.page.evaluate(SCAN('.canvas', null))) as Scan;
      await real.close();

      // The same layout as a card on the add-a-wall page.
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      let onCard: Scan;
      try {
        const page: Page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/new/browser`, { waitUntil: 'load' });
        await page.waitForSelector('.tpl-thumb[data-tpl="classic"]');
        await page.waitForFunction(
          () =>
            (document.querySelector('.tpl-thumb[data-tpl="classic"]')?.shadowRoot?.querySelectorAll('*')
              .length ?? 0) > 3,
          undefined,
          { timeout: 20_000 },
        );
        onCard = (await page.evaluate(SCAN('.canvas', '.tpl-thumb[data-tpl="classic"]'))) as Scan;
      } finally {
        await context.close();
      }

      /*
       * The premise, first. Two walls that draw almost nothing agree about
       * almost nothing, and every assertion below would pass over them — which
       * is the shape this repository keeps recording as "an assertion no edit
       * could turn red".
       */
      expect(onWall.runs.length, 'the paired wall drew almost nothing').toBeGreaterThan(20);
      expect(onCard.runs.length, 'the card drew almost nothing').toBeGreaterThan(20);
      // And they must be pictures of the same shape, or a share of the height
      // is not a comparison.
      expect(onCard.frame.w / onCard.frame.h).toBeCloseTo(onWall.frame.w / onWall.frame.h, 2);

      /*
       * The measurement. Every role the two have in common, as a share of its
       * own frame. 2% of the value absorbs sub-pixel rounding at two
       * resolutions and nothing else: the fault this file exists for read
       * between 1.20x and 5.02x.
       */
      const wallShare = sharePerClass(onWall);
      const cardShare = sharePerClass(onCard);
      const shared = [...wallShare.keys()].filter((cls) => cardShare.has(cls));
      expect(shared.length, 'the card and the wall have no type roles in common').toBeGreaterThan(5);
      const off: string[] = [];
      for (const cls of shared) {
        const onOne = wallShare.get(cls) ?? 0;
        const onOther = cardShare.get(cls) ?? 0;
        if (Math.abs(onOther - onOne) > onOne * 0.02) {
          off.push(`.${cls}: wall ${onOne.toFixed(3)}% of frame, card ${onOther.toFixed(3)}% (${(onOther / onOne).toFixed(2)}x)`);
        }
      }
      expect(off, 'the card draws type at a different size from the wall').toEqual([]);

      /*
       * And the three `body` declarations that decide what the type *is*
       * rather than how big it is. `--f-sans` is the wall's own self-hosted
       * face and the card was falling back to whatever the admin page sets;
       * `tabular-nums` is a reflow requirement here rather than a preference,
       * since a figure that changes width changes a row's geometry; and
       * `line-height: normal` is a property of a font *file* rather than of the
       * type, which is the fault that used to move a day row by a pixel when a
       * webfont landed.
       */
      const faces = new Set(onCard.runs.map((run) => run.fam));
      expect(faces, 'the card is not drawn in the faces the wall uses').toEqual(
        new Set(onWall.runs.map((run) => run.fam)),
      );
      expect(
        onCard.runs.filter((run) => run.num !== 'tabular-nums').map((run) => run.cls),
        'a run on the card draws proportional figures',
      ).toEqual([]);
      expect(
        onCard.runs.filter((run) => run.lh === 'normal').map((run) => run.cls),
        'a run on the card takes its leading from the font file',
      ).toEqual([]);

      /*
       * The one declaration a card must *not* inherit. `cursor: none` is right
       * on a wall nobody points at and wrong on a card somebody is about to
       * click — so the wall's own value is the thing that must differ here.
       */
      expect(onWall.cursor, 'the wall stopped hiding its pointer').toBe('none');
      expect(onCard.cursor, 'the card hides the pointer over a control').not.toBe('none');
    },
    SLOW,
  );
});
