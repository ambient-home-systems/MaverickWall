/**
 * Two people on a rota today, and the shipped Classic box: both are on the glass.
 *
 * Reported by a household as "a Shift widget set to two people shows one", and
 * true on every Classic wall with two rota workers. The manifest, the editor's
 * picker and `shiftWidgetView` all kept both people; the second was lost in the
 * wall's tier pass. `tierShift` chose the tier from the **whole** box as if it
 * held one badge, then drew a full badge per person, stacked — and `beltItems`,
 * which hides every item ending below the box except the first, hid the second
 * badge, because Classic's shift box is one badge tall. The stamp said two.
 *
 * The fix is the panel's rule, which `epaper/widgets.ts` has always kept for
 * more than one person: a tier is chosen **per badge** (the box's inner height,
 * less the gaps between badges, over the number of badges), and when a card
 * does not fit per person every person is drawn on one line, at the list's
 * size rather than the headline's.
 *
 * Every assertion reads the pixels, never a class: a badge counts when its
 * computed `display` is not `none`, its computed `visibility` is not `hidden`,
 * it has a real height, and its rectangle is inside the widget's own box. The
 * stamp is read back and held to that same count, because the stamp is what
 * the editor believes and it said two while the glass showed one.
 *
 * Four mutations, each on a rebuilt bundle, and which size each one reddens is
 * the useful part:
 *
 *  - **The tier from the whole box again** reddens 1080x1920 — a two-rung card,
 *    "AmyDays", and Ben hidden — and leaves 1920x1080 green, honestly: that box
 *    is already below a card for one person, so the whole box and one badge's
 *    share of it resolve to the same floor and the same lines.
 *  - **The lines at the headline's size** reddens both: a headline line is 76px
 *    a person at 1920x1080, where the box has 41 each.
 *  - **The lines in the card's own chrome** reddens 1920x1080 and not
 *    1080x1920, whose box has room for the padding.
 *  - **The stamp taken before the belt** reddens only the short box at the foot
 *    of this file, which is the one place the belt hides anybody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  HOUSEHOLD_CALENDARS,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';
import { applyTemplate } from '../src/api/templates.js';
import { classicFor } from '../src/templates/classic.js';

process.env['TZ'] = 'UTC';

const SLOW = 180_000;

let wall: Installation;
let link: string;
let screenId: string;

/**
 * A second person on a rota, working today.
 *
 * `equipHousehold` gives Amy a six-day pattern anchored thirty days back, which
 * lands on a day shift today. Ben's is the same pattern turned by two, so today
 * is a night — a different shift, so the two badges carry different words and
 * different colours and cannot be mistaken for one badge drawn twice. Anchored
 * off the harness's own `at`, the way Amy's is, rather than the runner's clock.
 */
function addSecondRotaPerson(at: number): void {
  const iso = (offset: number): string => new Date(at + offset * 86_400_000).toISOString().slice(0, 10);
  wall.db
    .prepare(
      `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run('p-ben', 'Ben', '#4F8CC9', 1, at, at);
  wall.db
    .prepare(
      `INSERT INTO shift_plans
         (id, person_id, name, kind, effective_from, priority, anchor_date, cycle, consumes_events, created_at, updated_at)
       VALUES (?, ?, ?, 'pattern', ?, 0, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      'plan-ben', 'p-ben', 'Ben rota', iso(-30), iso(-30),
      JSON.stringify(['night', 'night', null, null, 'day', 'day']), at, at,
    );
}

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  addSecondRotaPerson(wall.now());
  link = await wall.pairLink('Kitchen');
  screenId = (
    wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
  // The shipped seed, through the same `applyTemplate` a fresh pairing uses:
  // the box under test is Classic's own, not one this file dragged.
  applyTemplate(wall.db, screenId, classicFor({ modules: ['weather'], shift: true, todoLists: [] }));
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface ShiftReading {
  /** How many rota widgets the wall drew — exactly one on Classic. */
  readonly boxes: number;
  /** Every badge in the document, visible or not. */
  readonly drawn: number;
  /** The names a household can read, one per visible badge, in draw order. */
  readonly visible: readonly string[];
  /** How far any visible badge reaches outside the box's own content edges. */
  readonly outside: number;
  /** What the renderer stamped as the count it drew. */
  readonly stamped: string;
  readonly banner: string;
}

async function readShift(page: Page): Promise<ShiftReading> {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#wall .canvas .fw.fw-shift')];
    const box = boxes[0];
    const banner = document.querySelector('#wall .banners');
    const bannerText = banner === null ? '' : (banner.textContent ?? '').trim();
    if (!(box instanceof HTMLElement)) {
      return { boxes: 0, drawn: 0, visible: [], outside: 0, stamped: '', banner: bannerText };
    }
    const style = getComputedStyle(box);
    const outer = box.getBoundingClientRect();
    const inner = {
      left: outer.left + parseFloat(style.paddingLeft || '0'),
      right: outer.right - parseFloat(style.paddingRight || '0'),
      top: outer.top + parseFloat(style.paddingTop || '0'),
      bottom: outer.bottom - parseFloat(style.paddingBottom || '0'),
    };
    const badges = [...box.querySelectorAll('.shift-badge')];
    const shown = badges.filter((badge) => {
      const computed = getComputedStyle(badge);
      if (computed.display === 'none' || computed.visibility === 'hidden') return false;
      return badge.getBoundingClientRect().height > 0;
    });
    let outside = 0;
    for (const badge of shown) {
      const rect = badge.getBoundingClientRect();
      outside = Math.max(
        outside,
        inner.left - rect.left,
        rect.right - inner.right,
        inner.top - rect.top,
        rect.bottom - inner.bottom,
      );
    }
    return {
      boxes: boxes.length,
      drawn: badges.length,
      visible: shown.map((badge) => (badge.textContent ?? '').replace(/\s+/g, ' ').trim()),
      outside: Math.round(outside * 100) / 100,
      stamped: box.getAttribute('data-tier-items') ?? '',
      banner: bannerText,
    };
  });
}

describe('a Classic wall with two people on a rota today', () => {
  for (const size of [
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
  ] as const) {
    it(
      `draws both badges inside the shift box at ${size.width}x${size.height}`,
      async () => {
        const { page, close } = await loadWallSettled(link, size);
        try {
          const shift = await readShift(page);
          expect(shift.banner, 'the wall drew a banner, which shortens the canvas').toBe('');
          expect(shift.boxes, 'Classic places exactly one rota widget').toBe(1);
          expect(shift.drawn, 'the renderer drew a badge per person').toBe(2);
          expect(shift.visible, `visible badges: ${JSON.stringify(shift.visible)}`).toHaveLength(2);
          expect(shift.visible.some((text) => /amy/i.test(text)), 'Amy is on the glass').toBe(true);
          expect(shift.visible.some((text) => /ben/i.test(text)), 'Ben is on the glass').toBe(true);
          expect(
            shift.outside,
            'a visible badge reaches outside its box, where the box clips it',
          ).toBeLessThanOrEqual(0.5);
          expect(shift.stamped, 'the stamp is the count on the glass').toBe(String(shift.visible.length));
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }
});

describe('a rota box too short for two people', () => {
  it(
    'stamps the one badge on the glass, not the two on the rota',
    async () => {
      /*
       * The stamp's own case, which the Classic box above cannot make: there
       * both people fit, so a stamp taken from the rota and one taken from the
       * glass agree. A box 4% of a 1080x1920 canvas tall holds one line and
       * not two, so the belt hides the second person and the stamp has to say
       * so — taken before the belt it said two.
       *
       * Runs after the Classic cases because it replaces both canvases.
       */
      for (const orientation of ['portrait', 'landscape'] as const) {
        replaceLayout(wall.db, screenId, orientation, {
          mode: 'freeform',
          aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
          widgets: [{ id: `${orientation}-shift`, type: 'shift', x: 0.5, y: 0, w: 0.5, h: 0.04, z: 0 }],
          background: null,
        });
      }
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const shift = await readShift(page);
        expect(shift.boxes).toBe(1);
        expect(shift.drawn, 'both people are drawn, and one is given up').toBe(2);
        expect(shift.visible, `visible badges: ${JSON.stringify(shift.visible)}`).toHaveLength(1);
        expect(shift.stamped, 'the stamp is the count on the glass').toBe('1');
      } finally {
        await close();
      }
    },
    SLOW,
  );
});
