/**
 * A wall crossing a schedule boundary on its own (RFC 014 §5.2).
 *
 * A wall may hold a named canvas the clock selects — a "morning" arrangement
 * from 06:30 to 08:30 — and the whole reason every slot travels in the
 * manifest is that the swap has to happen *without the server*: on the tick,
 * from the document the wall already holds, and after a reload from the copy
 * in IndexedDB with nothing behind it. So the two measurements here are the
 * two things a poll could otherwise be quietly doing for the wall:
 *
 *  1. the wall is loaded a few seconds before the window, `/d/manifest` is
 *     then **blocked**, and the canvas is read back after the wall's own
 *     clock has crossed 06:30 — the arrangement changed and nothing arrived;
 *  2. the server is **killed**, the device clock is fixed inside the window,
 *     and the reload draws the morning canvas out of the stored copy.
 *
 * The clock is the harness's, not the runner's (`HARNESS_HOUR`): nothing
 * scheduled for 06:30 happens at eleven, so the *app's* clock is moved to
 * 06:29:50 the next morning with `shiftClock`, which the wall picks up
 * through `x-server-time` on the load. The device clock under Playwright is
 * the runner's own and would read a different hour on every machine, so it is
 * never *set* in the first case — only run on, with `page.clock.runFor`, which
 * fires the wall's own fifteen-second tick where the test used to sleep
 * through it (twenty-eight real seconds a crossing). It is fixed only in the
 * reload case, where a wall with no server has nothing else to read — which is
 * what a real tablet has after a power cut.
 *
 * The mutation check is a window one minute later than the wall's clock:
 * same load, same wait, and the canvas must *not* swap — because a boundary
 * test that only ever waits until something changes cannot tell a schedule
 * from a wall that swaps for any reason at all. It also has to see the wall
 * *redraw* past 06:30, so a tick that never fired cannot pass as a wall that
 * declined to swap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HARNESS_HOUR,
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  instantAt,
  loadWallSettled,
  settleWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
const ZONE = 'Europe/London';
const VIEWPORT = { width: 1080, height: 1920 } as const;
/** The words on the morning canvas and on nothing else a household has. */
const MORNING_NOTE = 'Bags by the door';

/** Everything on the glass that says which canvas is drawn. */
interface Drawn {
  readonly types: string[];
  readonly hasMorningNote: boolean;
  readonly canvas: { readonly width: number; readonly height: number };
}

async function drawn(page: Page): Promise<Drawn> {
  return page.evaluate((note) => {
    const boxes = [...document.querySelectorAll<HTMLElement>('#wall .canvas .fw')];
    const canvas = document.querySelector<HTMLElement>('#wall .canvas')?.getBoundingClientRect();
    return {
      types: boxes
        .map((box) => [...box.classList].find((c) => c.startsWith('fw-') && c !== 'fw-clock-face') ?? '')
        .sort(),
      hasMorningNote: boxes.some((box) => box.textContent?.includes(note) === true),
      canvas: { width: Math.round(canvas?.width ?? 0), height: Math.round(canvas?.height ?? 0) },
    };
  }, MORNING_NOTE);
}

/**
 * The morning canvas: one note, on both orientations, and a rule for it.
 *
 * Through the real POSTs, because the shape of the feature is those two
 * boundaries — a slot on the layout save and rows on the settings form —
 * and a test writing the columns would pass over either refusing the field.
 */
async function scheduleMorning(wall: Installation, screenId: string, from: string, to: string): Promise<void> {
  for (const orientation of ['portrait', 'landscape'] as const) {
    const saved = await wall.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: screenId,
        orientation,
        slot: 'morning',
        mode: 'freeform',
        aspect: orientation === 'portrait' ? 0.5625 : 1.7778,
        widgets: [
          { id: `morning-note-${orientation}`, type: 'notes', x: 0.05, y: 0.05, w: 0.9, h: 0.4, z: 0, config: { text: MORNING_NOTE } },
          { id: `morning-clock-${orientation}`, type: 'clock', x: 0.05, y: 0.5, w: 0.9, h: 0.3, z: 1 },
        ],
        background: null,
      }),
    });
    expect(saved.status, `saving the morning ${orientation} canvas`).toBe(200);
  }
  const rule = await wall.post(`/admin/screens/${screenId}`, {
    name: 'Kitchen',
    orientation: 'auto',
    rotation: '0',
    theme: 'panels',
    clock_24: '',
    schedule_form: '1',
    schedule_slot_1: 'morning',
    schedule_from_1: from,
    schedule_to_1: to,
  });
  expect(rule.status, `scheduling ${from}–${to}`).toBe(302);
}

/**
 * Start counting the wall's redraws.
 *
 * A draw empties `#wall` and builds a new `.canvas` inside it, so a canvas
 * arriving — on its own or inside whatever the draw appends — is a draw
 * having happened. Counted rather than assumed because the
 * boundary is crossed with `page.clock.runFor`: a swap proves a tick fired, but
 * "it did not swap" proves nothing unless something shows a tick *did* fire
 * after the boundary and chose not to.
 */
async function countDraws(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const counter = window as unknown as { __draws: number };
    counter.__draws = 0;
    const wall = document.getElementById('wall');
    if (wall === null) return;
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.classList.contains('canvas') || node.querySelector('.canvas') !== null) counter.__draws += 1;
        });
      }
    }).observe(wall, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __draws: number }).__draws);
}

async function pairingLink(wall: Installation, screenId: string): Promise<string> {
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  return found;
}

describe('the swap happens on the tick, with the server blocked', () => {
  let wall: Installation;
  let screenId: string;
  let link: string;

  beforeAll(async () => {
    wall = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1), timezone: ZONE });
    equipHousehold(wall.db, wall.now());
    screenId = await wall.pairWall('Kitchen');
    link = await pairingLink(wall, screenId);
  }, SLOW);

  afterAll(async () => {
    await wall.dispose();
    await shutDownBrowser();
  }, TEARDOWN);

  /**
   * Load at a moment ten seconds before the boundary, block the manifest, and
   * read the canvas back once the wall's clock has crossed it plus one tick.
   * Returns what was drawn just before the block and what was drawn after,
   * how many redraws the wall made in between, and the wall's clock at the
   * reading.
   */
  async function crossTheBoundary(
    boundary: { readonly hour: number; readonly minute: number },
  ): Promise<{ before: Drawn; after: Drawn; delivered: number; tried: number; draws: number; wallClock: number }> {
    /*
     * Ten seconds before the window opens, tomorrow: the pinned hour is
     * eleven, so the boundary is on the next civil day and the shift is
     * about nineteen and a half hours — applied to the app's clock, never
     * the device's, so the wall reads it off `x-server-time` on the load.
     */
    const opens = instantAt(ZONE, 1, boundary.hour, boundary.minute);
    wall.shiftClock(opens - 10_000 - wall.now());
    const { page, close } = await loadWallSettled(link, VIEWPORT, { clock: 'installed' });
    try {
      const before = await drawn(page);
      expect(before.hasMorningNote, 'the window has not opened and the morning canvas is already up').toBe(false);

      // From here nothing reaches the wall: every poll is refused at the
      // network, and counted, so "no poll" is a number rather than a hope.
      let tried = 0;
      let delivered = 0;
      await page.route('**/d/manifest*', async (route) => {
        tried += 1;
        await route.abort('connectionrefused');
      });
      page.on('response', (response) => {
        if (response.url().includes('/d/manifest')) delivered += 1;
      });

      /*
       * Past the boundary and a whole tick after it, on the wall's own timers.
       *
       * This used to be real seconds — the installation's clock watched until
       * it read the boundary plus a tick, then a second and a half for the
       * draw: twenty-eight seconds a crossing, two crossings a run. The wall
       * was not doing anything in them but waiting for its own
       * `setInterval(draw, 15_000)`, and `runFor` fires that same callback on
       * that same schedule without the wait. The wall's clock is the device's
       * plus the offset its last poll took from `x-server-time`, so moving
       * the device's timers moves the wall's clock by exactly as much and the
       * server's not at all — which is also why the reading's time is
       * `wall.now()` plus everything run, rather than `wall.now()`.
       *
       * In two steps, so the redraws counted are the ones *after* the
       * boundary: up to it first, then a whole tick and two seconds more.
       * Seventeen seconds of a fifteen-second interval holds at least one.
       */
      const toBoundary = opens - wall.now();
      await page.clock.runFor(toBoundary);
      const draws = await countDraws(page);
      await page.clock.runFor(15_000 + 2_000);
      const wallClock = wall.now() + toBoundary + 15_000 + 2_000;
      const after = await drawn(page);
      return { before, after, delivered, tried, draws: await draws(), wallClock };
    } finally {
      await close();
    }
  }

  it(
    'draws the everyday canvas at eleven, and the morning one after 06:30 without a poll',
    async () => {
      await scheduleMorning(wall, screenId, '06:30', '08:30');

      // At HARNESS_HOUR the default draws, with the schedule already stored.
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      const atEleven = await drawn(page);
      await close();
      expect(atEleven.hasMorningNote).toBe(false);
      expect(atEleven.types).toContain('fw-calendar');
      const localHour = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' })
        .format(new Date(wall.now()));
      expect(Number(localHour), 'the harness hour moved; this file’s arithmetic assumes eleven').toBe(HARNESS_HOUR);

      const { before, after, delivered, draws } = await crossTheBoundary({ hour: 6, minute: 30 });
      expect(before.types).toContain('fw-calendar');
      expect(draws, 'no tick redrew the wall after 06:30').toBeGreaterThan(0);
      // The swap: the morning canvas, and nothing of the everyday one.
      expect(after.hasMorningNote, `the wall did not swap at 06:30 (types: ${after.types.join(' ')})`).toBe(true);
      expect(after.types).toEqual(['fw-clock', 'fw-notes']);
      // Without a manifest: none was delivered after the block.
      expect(delivered).toBe(0);
      // And the geometry did not move — the schedule picks an arrangement,
      // never a shape, so the letterboxed canvas is the same rectangle.
      expect(after.canvas).toEqual(before.canvas);
    },
    SLOW,
  );

  it(
    'does not swap when the window starts one minute later than the wall’s clock',
    async () => {
      /*
       * The mutation, made by hand: the same load ten seconds before 06:30,
       * the same wait, and a window that opens at 06:31. The wall's clock at
       * the reading is about 06:30:20, so a swap here is a wall that swaps
       * for some reason other than the schedule — and the assertion that the
       * clock is still short of 06:31 is what keeps a slow runner from
       * turning this into the other test.
       */
      await scheduleMorning(wall, screenId, '06:31', '08:30');
      const { after, draws, wallClock } = await crossTheBoundary({ hour: 6, minute: 30 });
      const opensLater = instantAt(ZONE, 1, 6, 31);
      expect(wallClock, 'the runner stalled past 06:31, so this reading proves nothing').toBeLessThan(opensLater);
      // And the wall did redraw past 06:30 — it had its chance to swap, and
      // declined. Without this, a tick that never fired would pass here.
      expect(draws, 'no tick redrew the wall after 06:30, so "no swap" proves nothing').toBeGreaterThan(0);
      expect(after.hasMorningNote).toBe(false);
      expect(after.types).toContain('fw-calendar');
    },
    SLOW,
  );
});

describe('the swap happens from the stored copy, with the server gone', () => {
  let wall: Installation;
  let screenId: string;
  let link: string;

  beforeAll(async () => {
    wall = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1), timezone: ZONE });
    equipHousehold(wall.db, wall.now());
    screenId = await wall.pairWall('Kitchen');
    link = await pairingLink(wall, screenId);
    await scheduleMorning(wall, screenId, '06:30', '08:30');
  }, SLOW);

  afterAll(async () => {
    await wall.dispose();
    await shutDownBrowser();
  }, TEARDOWN);

  it(
    'draws the morning canvas after a reload with nothing behind it, inside the window and not outside',
    async () => {
      const context = await (await browser()).newContext({ viewport: VIEWPORT });
      try {
        const page = await context.newPage();
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);
        // The worker has to be controlling before a reload can be served
        // from it — `browser-wall.test.ts`'s own wait, for its own reason.
        const controlled = await page
          .waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        expect(controlled, 'the service worker never took control, so no reload can be offline').toBe(true);
        // A second online load, so the stored copy is the one with the
        // schedule in it and the worker's cache is warm.
        await page.reload({ waitUntil: 'load' });
        await settleWall(page);
        expect((await drawn(page)).hasMorningNote).toBe(false);

        await wall.kill();

        /*
         * A wall with no server has only its device clock — which under
         * Playwright is the runner's, at whatever hour the suite happened to
         * start. Fixed inside the window, then outside it: the one place this
         * file touches the device clock, because after a power cut it is the
         * only clock a real tablet has either.
         */
        await page.clock.setFixedTime(instantAt(ZONE, 1, 7, 0));
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(1_500);
        const inside = await drawn(page);
        expect(inside.hasMorningNote, `offline at 07:00 the morning canvas did not draw (types: ${inside.types.join(' ')})`).toBe(true);
        expect(inside.types).toEqual(['fw-clock', 'fw-notes']);

        await page.clock.setFixedTime(instantAt(ZONE, 1, 9, 0));
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(1_500);
        const outside = await drawn(page);
        expect(outside.hasMorningNote).toBe(false);
        expect(outside.types).toContain('fw-calendar');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
