/**
 * The other six widgets, measured on a real wall: a bigger box says more.
 *
 * `browser-density-tiers.test.ts` asks this of the calendar. This asks it of
 * everything else — the forecast, the rota badge, the house readings, a note, a
 * checklist and a chore board — because until this phase not one of them could
 * answer it. Every one was laid out at one size and given a uniform
 * `transform: scale()` to fill its box, which is photographic enlargement: it
 * changes how big a widget looks and can never change what it says. Measured on
 * the shipped Classic wall before this, the forecast drew five days and the
 * rota badge three rows at 480x800 and at 2560x1440, and the agenda six events
 * over two days at every size in a 3.7-megapixel range.
 *
 * Three questions, and each is asked of the pixels rather than of a class name.
 * This project has shipped a month cell that said "+6" and drew none of its six
 * events with every structural check passing, and a tick control whose class
 * was right and whose pixels were an empty outline.
 *
 *  1. **A box with four times the area draws more things.** Not "the tier
 *     stamped a higher rung" — more items a household can actually see.
 *  2. **A box too small clips between rows and never through one.** The fault
 *     `density.ts` recorded for the chore board once a floor stopped it
 *     shrinking, and the fault the month grid shipped before that: a row sliced
 *     across the middle reads as a broken renderer rather than as a list that
 *     ran out of room.
 *  3. **The shipped wall on a 43" television draws fourteen events over six
 *     days**, where it drew six over two. That is the headline this phase is
 *     named for and it is asserted here as a number rather than left to the
 *     ratchet, which only ever says "no worse than".
 *
 * Every assertion was checked by breaking its own fix. Capping `itemsAt` at the
 * tier's own number turns the three same-rung comparisons red and — this is the
 * useful part — leaves the four-times-the-area ones **green**, because a bigger
 * box reaches a higher rung and a higher rung's own number is larger. A
 * comparison across rungs cannot see the rule that makes the ordinary
 * in-between box right, which is why both blocks exist. Removing the belt turns
 * one of the six clip assertions red, which is the honest answer for a belt: on
 * five of them the tier already lands inside the box and the belt is the
 * promise rather than the mechanism. Restoring Classic's `count: 6` turns the
 * 43" assertion red at once.
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
import { createChore } from '../src/api/chores.js';
import { mountedSize, wallSizePreset } from '../src/wall-sizes.js';

process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and a dozen walls. */
const SLOW = 300_000;

let wall: Installation;
let link: string;
let screenId: string;

/**
 * Eight readings and sixteen chores, because a tier is about *how many*.
 *
 * A widget with two things in it answers "more" with "two" whatever its box,
 * and this file would pass on a renderer that had learned nothing. Sixteen
 * rather than eight for the chores, because eight of them fit in the *shorter*
 * of the two boxes the same-rung comparison uses, so the content was the cap
 * and the box was not being asked anything. Seeded
 * straight into the tables the manifest reads — the sync path for either is a
 * different feature and `chores-wall.test.ts` and the Home Assistant suite own
 * it — but through `createChore`, which is the one place a schedule is
 * validated, rather than by writing rows behind it.
 */
function equipHouse(): void {
  wall.db
    .prepare(`UPDATE ha_settings SET enabled = 1, base_url = ?, updated_at = ? WHERE id = 'singleton'`)
    .run('http://127.0.0.1:1/api', wall.now());
  const rows = [
    ['sensor.kitchen', '19.4', 'Kitchen', '°C', 'label_value'],
    ['sensor.hall', '18.1', 'Hall', '°C', 'label_value'],
    ['sensor.garage', '11.8', 'Garage', '°C', 'label_value'],
    ['sensor.loft', '9.2', 'Loft', '°C', 'label_value'],
    ['sensor.study', '20.6', 'Study', '°C', 'label_value'],
    ['sensor.porch', '7.5', 'Porch', '°C', 'label_value'],
    ['sensor.shed', '6.1', 'Shed', '°C', 'label_value'],
    ['sensor.attic', '14.3', 'Attic', '°C', 'label_value'],
  ] as const;
  let order = 0;
  for (const [id, state, name, unit, mode] of rows) {
    wall.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
         ON CONFLICT(entity_id) DO UPDATE SET state = excluded.state, watched = 1`,
      )
      .run(id, state, '{}', name, unit, wall.now(), wall.now(), mode, order++);
  }
  for (const name of [
    'Empty the dishwasher', 'Feed the cat', 'Put the bins out', 'Hoover downstairs',
    'Water the plants', 'Wipe the worktops', 'Sort the recycling', 'Fold the washing',
    'Clean the bath', 'Change the beds', 'Sweep the porch', 'Wash the car',
    'Top up the salt', 'Descale the kettle', 'Refill the bird feeder', 'Check the post',
  ]) {
    createChore(wall.db, { name, personId: null, schedule: { kind: 'daily' }, dueTime: null });
  }
}

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  equipHouse();
  link = await wall.pairLink('Kitchen');
  screenId = (
    wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** What the household said about the hardware, or nothing. */
function measureScreen(preset: string | undefined, rotation: 0 | 90 = 0): void {
  const found = preset === undefined ? undefined : wallSizePreset(preset);
  if (found === undefined) {
    wall.db
      .prepare(
        'UPDATE screens SET panel_width_mm = NULL, panel_height_mm = NULL, read_distance_mm = NULL WHERE id = ?',
      )
      .run(screenId);
    return;
  }
  const mounted = mountedSize(found, rotation);
  wall.db
    .prepare(
      'UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?',
    )
    .run(mounted.widthMm, mounted.heightMm, found.readAtMm, screenId);
}

interface Placed {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly config?: Record<string, unknown>;
}

/** Put an arrangement of this file's own on both canvases. */
function canvasOf(widgets: readonly Placed[]): void {
  for (const orientation of ['portrait', 'landscape'] as const) {
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: widgets.map((widget, index) => ({
        id: `${orientation}-${index}`,
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: index,
        ...(widget.config === undefined ? {} : { config: widget.config }),
      })),
      background: null,
    });
  }
}

/**
 * What one placed widget draws, and whether any of it is sliced.
 *
 * `items` is the selector for the thing this widget is a list *of* — a
 * forecast's rungs, a badge's rows, a reading, a line, a checklist row, a chore.
 * Counted only when a household could see it: not `display: none`, not
 * `visibility: hidden`, and a rect with real height, which is the same
 * visibility test every other measurement in this suite applies.
 *
 * `overhang` is how far the lowest visible item's bottom falls past the box's
 * own content edge. Zero or less is the promise; anything above half a pixel is
 * a row drawn half, which is the whole of question two.
 */
async function drawn(
  page: Page,
  selector: string,
): Promise<{ readonly items: number; readonly overhang: number; readonly tier: string }> {
  return page.evaluate((sel) => {
    const box = document.querySelector('#wall .canvas .fw');
    if (!(box instanceof HTMLElement)) return { items: 0, overhang: 0, tier: '' };
    const visible = (node: Element): boolean => {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return node.getBoundingClientRect().height > 0;
    };
    const nodes = [...box.querySelectorAll(sel)].filter(visible);
    const foot =
      box.getBoundingClientRect().bottom - parseFloat(getComputedStyle(box).paddingBottom || '0');
    /*
     * Measured over every item **but the first**, which is rule nine rather
     * than a loophole: a household who dragged a box smaller than one row
     * should see the thing at the top of it, clipped if it comes to that,
     * rather than an empty rectangle. The month cell's own belt makes the same
     * exception at the same index. What the promise is about is every item
     * after that: those are drawn whole or not at all.
     */
    let overhang = 0;
    for (let at = 1; at < nodes.length; at++) {
      overhang = Math.max(overhang, (nodes[at] as HTMLElement).getBoundingClientRect().bottom - foot);
    }
    return {
      items: nodes.length,
      overhang: Math.round(overhang * 100) / 100,
      tier: box.getAttribute('data-tier') ?? '',
    };
  }, selector);
}

const VIEWPORT = { width: 1080, height: 1920 } as const;

async function place(
  widget: Placed,
  selector: string,
): Promise<{ readonly items: number; readonly overhang: number; readonly tier: string }> {
  canvasOf([widget]);
  const { page, close } = await loadWallSettled(link, VIEWPORT);
  try {
    return await drawn(page, selector);
  } finally {
    await close();
  }
}

/**
 * The six, with the selector for the thing each is a list of and the config
 * each needs to have anything to say.
 *
 * The small box is deliberately *not* the smallest a household could drag: at
 * the floor every one of these draws exactly one thing (rule nine — a widget
 * that resolves to nothing is the one outcome forbidden), so a comparison
 * starting there would be measuring the floor rather than the ladder.
 */
const WIDGETS: readonly {
  readonly type: string;
  readonly items: string;
  readonly config?: Record<string, unknown>;
}[] = [
  // A forecast is a strip: its width buys days and its height buys rungs, so
  // the count here is every rung on the glass across every column.
  { type: 'weather', items: '.wx-day > *' },
  { type: 'shift', items: '.shift-badge > *' },
  { type: 'homeassistant', items: '.hs-item' },
  {
    type: 'notes',
    items: '.nt-line',
    config: {
      text: [
        'Piano Tuesday', 'Passport renewal', 'Call the plumber', 'Book the car in',
        'Pay the window man', 'School forms', 'Ring Mum', 'Order the turkey',
        'Chase the plasterer', 'Renew the parking', 'Book the dentist', 'Send the forms',
        'Ring the vet', 'Cancel the paper',
      ].join('\n'),
    },
  },
  {
    type: 'todo',
    items: '.td-row',
    config: {
      items: [
        'Milk', 'Bread', 'Washing powder', 'Light bulbs', 'Stamps', 'Batteries', 'Cat food',
        'Kitchen roll', 'Tin foil', 'Coffee', 'Rice', 'Olive oil', 'Bin bags', 'Tea',
      ],
    },
  },
  { type: 'chores', items: '.ch-row' },
];

describe('a box with four times the area says more', () => {
  for (const widget of WIDGETS) {
    it(
      `${widget.type}: draws more when its box doubles in both directions`,
      async () => {
        const config = widget.config;
        const small = await place(
          { type: widget.type, x: 0.04, y: 0.04, w: 0.24, h: 0.11, ...(config === undefined ? {} : { config }) },
          widget.items,
        );
        const large = await place(
          { type: widget.type, x: 0.04, y: 0.04, w: 0.48, h: 0.22, ...(config === undefined ? {} : { config }) },
          widget.items,
        );

        /*
         * There is something to count. Without this the comparison below is two
         * zeroes and passes on a widget that draws nothing at all, which is the
         * shape of assertion this project keeps finding it cannot turn red.
         */
        expect(small.items, `${widget.type} drew nothing in the small box`).toBeGreaterThan(0);

        expect(
          large.items,
          `${widget.type} drew ${large.items} things in a box of four times the area, ` +
            `against ${small.items} in the small one (tiers ${small.tier} → ${large.tier})`,
        ).toBeGreaterThan(small.items);

        // And neither box drew anything half. The tier says what to draw and
        // this is the geometric belt that says none of it is sliced.
        expect(small.overhang, `${widget.type} overhangs its small box`).toBeLessThanOrEqual(0.5);
        expect(large.overhang, `${widget.type} overhangs its large box`).toBeLessThanOrEqual(0.5);
      },
      SLOW,
    );
  }
});

describe('a taller box at the same rung still says more', () => {
  /*
   * The half the comparison above cannot see, and it is worth its own block.
   *
   * A bigger box reaches a higher rung, and a higher rung's own number is
   * larger — so "four times the area draws more" passes on a renderer that
   * reads nothing but the table. What that renderer gets wrong is the ordinary
   * case: a box clears one threshold and not the next far more often than it
   * lands on both, and a table capped at its own rung would draw four things in
   * a box with room for thirteen. `itemsAt` is where the tier's number is a
   * *floor* and the measured capacity is what a box with more room buys, and
   * this is the assertion that fails when it is not.
   *
   * Both boxes are the same width and resolve to the same rung — asserted, not
   * assumed, because a test that thought it was measuring height and had moved
   * a tier would pass for the wrong reason.
   *
   * The three list widgets only. A forecast column's rungs and a badge's rows
   * come from the tier itself rather than from a measured capacity, which is
   * the shape of those widgets: three readings in a card cannot become four
   * because the card got taller.
   */
  for (const widget of WIDGETS.filter((one) => ['notes', 'todo', 'chores'].includes(one.type))) {
    it(
      `${widget.type}: draws more rows in a taller box at the same rung`,
      async () => {
        const config = widget.config;
        const shorter = await place(
          { type: widget.type, x: 0.04, y: 0.04, w: 0.5, h: 0.26, ...(config === undefined ? {} : { config }) },
          widget.items,
        );
        const taller = await place(
          { type: widget.type, x: 0.04, y: 0.04, w: 0.5, h: 0.48, ...(config === undefined ? {} : { config }) },
          widget.items,
        );
        expect(taller.tier, `${widget.type} changed rung between the two boxes`).toBe(shorter.tier);
        expect(
          taller.items,
          `${widget.type} drew ${taller.items} rows in a box nearly twice as tall, against ` +
            `${shorter.items} in the short one, both at rung ${shorter.tier}`,
        ).toBeGreaterThan(shorter.items);
        expect(taller.overhang, `${widget.type} overhangs its box`).toBeLessThanOrEqual(0.5);
      },
      SLOW,
    );
  }
});

describe('a box too small clips between rows, never through one', () => {
  /*
   * The measurement `density.ts` recorded for the chore board and could not fix
   * with a scale floor: raising the floor stopped the names becoming grey
   * texture and made the box clip *through* a row instead, which reads as a
   * broken renderer rather than as a list that ran out of room.
   *
   * A box below every tier's threshold is where that shows. Rule nine says the
   * first item survives whatever the arithmetic says — a household who dragged
   * a box too small should see the thing at the top of it rather than an empty
   * rectangle — so the assertion is not "nothing is drawn", it is "nothing is
   * drawn half".
   */
  for (const widget of WIDGETS) {
    it(
      `${widget.type}: draws no row past the foot of a box too small for it`,
      async () => {
        const config = widget.config;
        const tiny = await place(
          { type: widget.type, x: 0.04, y: 0.04, w: 0.16, h: 0.045, ...(config === undefined ? {} : { config }) },
          widget.items,
        );
        expect(tiny.items, `${widget.type} drew nothing at all in a box too small`).toBeGreaterThan(0);
        expect(
          tiny.overhang,
          `${widget.type} draws a row ${tiny.overhang}px past the foot of its box, which is a ` +
            'row cut through the middle rather than a list that ran out of room',
        ).toBeLessThanOrEqual(0.5);
      },
      SLOW,
    );
  }
});

describe('the shipped wall on a 43 inch television', () => {
  it(
    'draws fourteen events over six days where it drew six over two',
    async () => {
      /*
       * The Classic seed, re-applied through the same `applyTemplate` a fresh
       * pairing uses, on the panel the wall-size catalogue calls a 43"
       * television at its own read distance — a household who picked their
       * screen off the list and touched nothing else.
       *
       * Restored rather than arranged, and re-applied rather than measured on a
       * second installation: this file has already replaced both canvases with
       * its own single-widget arrangements, and a second `install()` in the same
       * process drew an offline banner, which takes 76px off the canvas and one
       * whole day off the agenda. That is a fact about running two servers in
       * one test file rather than about the wall, and a measurement that cannot
       * tell the two apart is not a measurement.
       */
      applyTemplate(wall.db, screenId, classicFor({ modules: ['weather'], shift: true }));
      measureScreen('tv-43');
      const { page, close } = await loadWallSettled(link, { width: 2560, height: 1440 });
      try {
        const agenda = await page.evaluate(() => {
          const visible = (node: Element): boolean => {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return node.getBoundingClientRect().height > 0;
          };
          const banner = document.querySelector('#wall .banners');
          const days = [...document.querySelectorAll('#wall .canvas section.next .day-row')].filter(visible);
          return {
            banner: banner === null ? '' : (banner.textContent ?? '').trim(),
            days: days.length,
            events: days.reduce(
              (total, day) => total + [...day.querySelectorAll(':scope .dr-ev')].filter(visible).length,
              0,
            ),
          };
        });
        /*
         * And no banner, because a banner is 76px of canvas and this file has
         * already been fooled by one. A wall that is telling the household it
         * cannot reach its server is not the wall this measurement is about.
         */
        expect(agenda.banner, 'the wall drew a banner, which shortens the canvas').toBe('');
        expect(agenda.events, `the agenda drew ${agenda.events} events`).toBeGreaterThanOrEqual(14);
        expect(agenda.days, `the agenda drew ${agenda.days} days`).toBeGreaterThanOrEqual(6);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});
