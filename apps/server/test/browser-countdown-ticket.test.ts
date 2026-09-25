/**
 * The countdown's `ticket` look — a boarding pass — measured on a real wall
 * (plan item P5.2).
 *
 * The shipped Classic wall with three family calendars, its forecast's box
 * made a countdown, at 1080x1920 and 1920x1080, on a wall nobody has measured
 * and on one set to a 32" television read from 1.2 metres:
 *
 *  1. **A form from the box, and nothing cut** — Classic's box, the box grown
 *     to hold the whole pass, and a narrow column — with the belt given
 *     nothing to do, the parts on the glass exactly the parts the tier names,
 *     and every figure `tabular-nums`.
 *  2. **Roles, not the box.** The destination is the lede, the line the event
 *     role and the head the label's, on the measured wall.
 *  3. **One large reading, capped (D1)**: the board's flaps at most 1.8 ledes
 *     at three sizes, and the clock's role where there is room.
 *  4. **A flap falls only where its digit changed.** Twelve becomes eleven at
 *     midnight: the units flap falls carrying the 2 away, the tens stays put,
 *     nothing falls on the load, and nothing on the tick after.
 *  5. **The words**: "Departs in 12 days", "Departs in 12 sleeps", "Departed
 *     3 days ago" — and on the day "Today!" with its popper, and no board.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, instantAt, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  RATIO_SIZES,
  SIZES,
  WALLS,
  ZONE,
  civilDate,
  countdownWall,
  fontSizeIn,
  loadBeforeMidnight,
  measureScreen,
  motionOf,
  picturesIn,
  readCountdownBox,
  roleSizes,
  runUntil,
  setCountdown,
  wallName,
  type CountdownWall,
} from './browser-countdown-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 300_000;
const TICK = 15_000;

let cw: CountdownWall;

beforeAll(async () => {
  cw = await countdownWall();
}, SLOW);

afterAll(async () => {
  await cw?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const BOXES: readonly { readonly name: string; readonly resize?: { readonly w?: number; readonly h?: number } }[] = [
  { name: "Classic's box" },
  { name: 'a tall box', resize: { w: 0.9, h: 0.45 } },
  { name: 'a narrow column', resize: { w: 0.18, h: 0.35 } },
];

async function partsOn(page: Page, id: string): Promise<string[]> {
  return page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] [data-part]`, (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset['part'] ?? ''),
  );
}

describe('the ticket on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `takes a form from its box and cuts nothing, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(cw, preset);
          const id = cw.box[size.orientation].id;
          for (const { name, resize } of BOXES) {
            await setCountdown(cw, { variant: 'ticket', target: civilDate(cw.wall.now(), 345), title: 'Lisbon' }, resize);
            const { page, close } = await loadWallSettled(cw.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${name}`;
              const box = await readCountdownBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              expect(box.tier, `${where}: no tier stamped`).not.toBeNull();
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');
              const parts = await partsOn(page, id);
              expect([...parts].sort(), where).toEqual((box.rungs ?? '').split(' ').sort());
              expect(parts, `${where}: the destination is gone`).toContain('dest');
              expect(parts, `${where}: the line is gone`).toContain('when');
              if (name === 'a tall box') expect(box.tier, where).toBe('T2');
              if (parts.includes('board')) {
                const flaps = await page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdt-flap`, (n) => n.map((one) => one.textContent));
                expect(flaps, where).toEqual(['3', '4', '5']);
              }

              if (preset !== undefined) {
                const roles = await roleSizes(page);
                expect(await fontSizeIn(page, id, '.cdt-dest'), `${where}: destination`).toBeCloseTo(roles['lede']!, 1);
                expect(await fontSizeIn(page, id, '.cdt-when'), `${where}: line`).toBeCloseTo(roles['event']!, 1);
                if (parts.includes('head')) {
                  expect(await fontSizeIn(page, id, '.cdt-head'), `${where}: head`).toBeCloseTo(roles['label']!, 1);
                }
              }
            } finally {
              await close();
            }
          }
        },
        SLOW,
      );
    }
  }
});

describe('the board is one large reading, capped against the lede (D1)', () => {
  for (const preset of WALLS) {
    it(
      `is at most 1.8 ledes at three sizes, and the clock's role where there is room, on the ${wallName(preset)} wall`,
      async () => {
        measureScreen(cw, preset);
        await setCountdown(cw, { variant: 'ticket', target: civilDate(cw.wall.now(), 12), title: 'Lisbon' }, { w: 0.9, h: 0.45 });
        for (const size of RATIO_SIZES) {
          const { page, close } = await loadWallSettled(cw.link, size);
          try {
            const id = cw.box[size.orientation].id;
            const where = `${wallName(preset)} ${size.width}x${size.height}`;
            const flap = (await fontSizeIn(page, id, '.cdt-flap'))!;
            const lede = (await fontSizeIn(page, id, '.cdt-dest'))!;
            expect(flap / lede, `${where}: ${flap}px over ${lede}px`).toBeLessThanOrEqual(1.8 + 1e-3);
            const clock = await page.evaluate(() => {
              const probe = document.createElement('span');
              probe.style.fontSize = 'var(--t-wall-clock, calc(var(--t-event) * 1.8))';
              document.querySelector('#wall .canvas')?.appendChild(probe);
              const px = parseFloat(getComputedStyle(probe).fontSize);
              probe.remove();
              return px;
            });
            expect(flap, where).toBeCloseTo(clock, 1);
          } finally {
            await close();
          }
        }
      },
      SLOW,
    );
  }
});

describe('a flap falls only where its digit changed', () => {
  it(
    'turns the units at midnight and leaves the tens, and turns nothing on the load or the tick after',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      const eve = instantAt(ZONE, 1, 0, 0) - 20_000;
      await setCountdown(cw, { variant: 'ticket', target: civilDate(eve, 12), title: 'Lisbon' }, { w: 0.9, h: 0.45 });
      const { page, close, toMidnight } = await loadBeforeMidnight(cw, size);
      const falling = `#wall .canvas .fw[data-widget-id="${id}"] .cdt-flap-old`;
      const board = async (): Promise<(string | null)[]> =>
        page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdt-flap`, (nodes) =>
          nodes.map((node) => Array.from(node.childNodes).find((one) => one.nodeType === Node.TEXT_NODE)?.textContent ?? null),
        );
      try {
        expect(await page.$$(falling), 'a flap fell on the load').toHaveLength(0);
        expect(await board()).toEqual(['1', '2']);
        await page.clock.runFor(Math.max(0, toMidnight() - 3_000));
        expect(await page.$$(falling), 'a flap fell before midnight').toHaveLength(0);

        expect(await runUntil(page, falling, 25), 'no flap fell in the draw after midnight').toBeDefined();
        expect(await board()).toEqual(['1', '1']);
        // One flap falls — the units, carrying the 2 away — and the tens stays put.
        const fell = await page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdt-flap`, (nodes) =>
          nodes.map((node) => node.querySelector('.cdt-flap-old')?.textContent ?? null),
        );
        expect(fell).toEqual([null, '2']);
        expect(await motionOf(page, falling)).toEqual({ name: 'cd-flap-fall', running: 1 });

        await page.clock.runFor(TICK);
        expect(await page.$$(falling), 'a flap fell again on the next tick').toHaveLength(0);
        expect(await board()).toEqual(['1', '1']);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the words', () => {
  it(
    'departs in days or sleeps, departed days ago, and on the day says "Today!" with no board',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[1]!;
      const id = cw.box[size.orientation].id;
      const cases: readonly [Record<string, unknown>, string][] = [
        [{ target: civilDate(cw.wall.now(), 12) }, 'Departs in 12 days'],
        [{ target: civilDate(cw.wall.now(), 12), unitWords: 'sleeps' }, 'Departs in 12 sleeps'],
        [{ target: civilDate(cw.wall.now(), -3), unitWords: 'sleeps' }, 'Departed 3 days ago'],
        [{ target: civilDate(cw.wall.now(), 0) }, 'Today!'],
      ];
      for (const [config, line] of cases) {
        await setCountdown(cw, { variant: 'ticket', title: 'Lisbon', ...config }, { w: 0.9, h: 0.45 });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const when = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdt-when`, (n) => n.textContent);
          expect(when).toBe(line);
          const boards = await page.$$(`#wall .canvas .fw[data-widget-id="${id}"] .cdt-board`);
          expect(boards.length, line).toBe(line === 'Today!' ? 0 : 1);
          if (line === 'Today!') {
            const pictures = await picturesIn(page, id);
            expect(pictures.images.map((one) => new URL(one.src).pathname)).toEqual(['/assets/emoji/party-popper.svg']);
            expect(pictures.codePoints).toEqual([]);
          }
          const box = await readCountdownBox(page, id);
          expect(box.clipped, line).toEqual([]);
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );
});
