/**
 * The countdown's `progress` look — a bar of the days gone since a start date
 * — measured on a real wall (plan item P5.2, the second half).
 *
 * The shipped Classic wall with three family calendars, its forecast's box
 * made a countdown, at 1080x1920 and 1920x1080, on a wall nobody has measured
 * and on one set to a 32" television read from 1.2 metres:
 *
 *  1. **A form from the box, and nothing cut.** In Classic's own box, a tall
 *     one and a narrow column: every run inside the box, the belt with nothing
 *     to do, the parts on the glass the parts the tier names, every figure
 *     `tabular-nums`, and on the measured wall the label the lede and the
 *     unit and the percentage the scaffold.
 *  2. **The bar is as long as the days gone.** Its computed fill, measured
 *     against its track, is the fraction the start and the target make of
 *     today; the percentage under it says the same in words, floored.
 *  3. **One large reading, capped (D1)**, at three sizes on both walls.
 *  4. **It fills once, at midnight.** Loaded twenty seconds before midnight
 *     with the server cut off: nothing grows on the load; the first draw after
 *     midnight grows the bar from yesterday's length to today's, under the
 *     scoped keyframes; the tick after draws it still.
 *  5. **With no start date the bar's place says what to do**, and on the day
 *     the count is "Today!" and the bar is full.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, instantAt, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import { readLayoutWidgets } from '../src/api/queries.js';
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
  { name: 'a tall box', resize: { w: 0.9, h: 0.3 } },
  { name: 'a narrow column', resize: { w: 0.18, h: 0.35 } },
];

async function partsOn(page: Page, id: string): Promise<string[]> {
  return page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] [data-part]`, (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset['part'] ?? ''),
  );
}

/** The bar as drawn: the fill's computed width over the track's inner width, and the words beside it. */
async function readBar(page: Page, id: string): Promise<{ readonly share: number; readonly label: string | null; readonly pct: string | null }> {
  return page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-progress`, (section) => {
    const bar = section.querySelector<HTMLElement>('.cdg-bar');
    const fill = section.querySelector<HTMLElement>('.cdg-fill');
    if (bar === null || fill === null) throw new Error('no bar drawn');
    return {
      share: parseFloat(getComputedStyle(fill).width) / bar.clientWidth,
      label: bar.getAttribute('aria-label'),
      pct: section.querySelector('.cdg-pct')?.textContent ?? null,
    };
  });
}

describe('the progress bar on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `takes a form from its box and cuts nothing, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(cw, preset);
          const id = cw.box[size.orientation].id;
          const now = cw.wall.now();
          for (const { name, resize } of BOXES) {
            await setCountdown(
              cw,
              { variant: 'progress', from: civilDate(now, -100), target: civilDate(now, 245), title: 'Summer holiday', unitWords: 'sleeps' },
              resize,
            );
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
              expect(parts, `${where}: the count is gone`).toContain('count');
              if (name === 'a tall box') expect(box.tier, where).toBe('T3');
              // Classic's own box keeps the bar, which is the look.
              if (name === "Classic's box") expect(parts, `${where}: Classic's box gave up the bar`).toContain('bar');
              if (preset !== undefined) {
                const roles = await roleSizes(page);
                expect(await fontSizeIn(page, id, '.cdg-unit'), `${where}: unit`).toBeCloseTo(roles['scaffold']!, 1);
                if (parts.includes('label')) {
                  expect(await fontSizeIn(page, id, '.cdg-label'), `${where}: label`).toBeCloseTo(roles['lede']!, 1);
                }
                if (parts.includes('pct')) {
                  expect(await fontSizeIn(page, id, '.cdg-pct'), `${where}: percentage`).toBeCloseTo(roles['scaffold']!, 1);
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

describe('the bar is as long as the days gone', () => {
  it(
    'measures its fill against its track, and says the same floored in words',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      const now = cw.wall.now();
      for (const [gone, left, percent] of [
        [10, 10, 50],
        [1, 3, 25],
        // Two days of three: 66.7%, and the words floor it.
        [2, 1, 66],
        // The day before the day: 99%, never 100%.
        [99, 1, 99],
      ] as const) {
        await setCountdown(
          cw,
          { variant: 'progress', from: civilDate(now, -gone), target: civilDate(now, left), title: 'Holiday' },
          { w: 0.9, h: 0.3 },
        );
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const bar = await readBar(page, id);
          expect(bar.share, `${gone} gone, ${left} to go`).toBeCloseTo(gone / (gone + left), 2);
          expect(bar.pct?.toLowerCase(), `${gone} gone, ${left} to go`).toBe(`${percent}% of the way`);
          expect(bar.label).toBe(`${percent}% of the way`);
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );

  it(
    'says to set a start date where the bar goes when there is none, and fills the bar on the day',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      await setCountdown(cw, { variant: 'progress', target: civilDate(cw.wall.now(), 12), title: 'Holiday' }, { w: 0.9, h: 0.3 });
      const unset = await loadWallSettled(cw.link, size);
      try {
        const drawn = await unset.page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-progress`, (section) => ({
          bar: section.querySelectorAll('.cdg-bar').length,
          said: section.querySelector('.cdg-empty')?.textContent ?? null,
          count: section.querySelector('.cdg-num')?.textContent ?? null,
        }));
        expect(drawn).toEqual({ bar: 0, said: 'Set a start date in this widget’s options.', count: '12' });
      } finally {
        await unset.close();
      }

      await setCountdown(
        cw,
        { variant: 'progress', from: civilDate(cw.wall.now(), -20), target: civilDate(cw.wall.now(), 0), title: 'Holiday' },
        { w: 0.9, h: 0.3 },
      );
      const day = await loadWallSettled(cw.link, size);
      try {
        const num = await day.page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdg-num`, (n) => ({
          text: n.textContent,
          img: n.querySelector('img')?.getAttribute('src') ?? null,
        }));
        expect(num).toEqual({ text: 'Today!', img: '/assets/emoji/party-popper.svg' });
        expect((await readBar(day.page, id)).share).toBeCloseTo(1, 2);
        const box = await readCountdownBox(day.page, id);
        expect(box.clipped).toEqual([]);
        expect(box.belted).toBe(0);
      } finally {
        await day.close();
      }
    },
    SLOW,
  );
});

describe('the count is one large reading, capped against the lede (D1)', () => {
  for (const preset of WALLS) {
    it(
      `is at most 1.8 ledes at three sizes, and the clock's role where there is room, on the ${wallName(preset)} wall`,
      async () => {
        measureScreen(cw, preset);
        const now = cw.wall.now();
        await setCountdown(cw, { variant: 'progress', from: civilDate(now, -30), target: civilDate(now, 12), title: 'Holiday' }, { w: 0.9, h: 0.3 });
        for (const size of RATIO_SIZES) {
          const { page, close } = await loadWallSettled(cw.link, size);
          try {
            const id = cw.box[size.orientation].id;
            const where = `${wallName(preset)} ${size.width}x${size.height}`;
            const count = (await fontSizeIn(page, id, '.cdg-num'))!;
            const lede = (await fontSizeIn(page, id, '.cdg-label'))!;
            expect(count / lede, `${where}: ${count}px over ${lede}px`).toBeLessThanOrEqual(1.8 + 1e-3);
            const clock = await page.evaluate(() => {
              const probe = document.createElement('span');
              probe.style.fontSize = 'var(--t-wall-clock, calc(var(--t-event) * 1.8))';
              document.querySelector('#wall .canvas')?.appendChild(probe);
              const px = parseFloat(getComputedStyle(probe).fontSize);
              probe.remove();
              return px;
            });
            expect(count, where).toBeCloseTo(clock, 1);
          } finally {
            await close();
          }
        }
      },
      SLOW,
    );
  }
});

describe('the bar fills once, at midnight', () => {
  it(
    'grows nothing on the load, grows from yesterday’s length on the first draw after midnight, and nothing after',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      const eve = instantAt(ZONE, 1, 0, 0) - 20_000;
      // Nine days of twenty gone on the eve, ten after midnight.
      await setCountdown(
        cw,
        { variant: 'progress', from: civilDate(eve, -9), target: civilDate(eve, 11), title: 'Holiday' },
        { w: 0.9, h: 0.3 },
      );
      const { page, close, toMidnight } = await loadBeforeMidnight(cw, size);
      const growing = `#wall .canvas .fw[data-widget-id="${id}"] .cdg-fill.fx-playing`;
      try {
        expect(await page.$$(growing), 'the bar grew on the load').toHaveLength(0);
        expect((await readBar(page, id)).share).toBeCloseTo(9 / 20, 2);
        await page.clock.runFor(Math.max(0, toMidnight() - 3_000));
        expect(await page.$$(growing), 'the bar grew before midnight').toHaveLength(0);

        const took = await runUntil(page, growing, 25);
        expect(took, 'the bar did not grow in the draw after midnight').toBeDefined();
        expect((await readBar(page, id)).share, 'the bar is not today’s length').toBeCloseTo(10 / 20, 2);
        // From yesterday's length, as a share of today's: 9 of 10.
        const from = await page.$eval(growing, (n) => getComputedStyle(n).getPropertyValue('--cdg-was').trim());
        expect(Number(from)).toBeCloseTo(0.9, 3);
        expect(await motionOf(page, growing)).toEqual({ name: 'cd-fill-grow', running: 1 });

        await page.clock.runFor(TICK);
        expect(await page.$$(growing), 'the bar grew again on the next tick').toHaveLength(0);
        expect((await readBar(page, id)).share).toBeCloseTo(10 / 20, 2);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the editor', () => {
  it(
    'offers the start date on the bar alone and the occasion on the occasion alone, and says a refused date twice',
    async () => {
      const orientation = 'portrait';
      const id = cw.box[orientation].id;
      const target = civilDate(cw.wall.now(), 30);
      await setCountdown(cw, { variant: 'progress', target, title: 'Holiday' });
      const read = (): Record<string, unknown> =>
        (readLayoutWidgets(cw.wall.db, cw.screenId, orientation).find((one) => one.id === id)?.config ?? {}) as Record<string, unknown>;
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await cw.wall.signIn(page);
        const open = async (): Promise<void> => {
          await page.goto(`${cw.wall.base}/admin/walls/${encodeURIComponent(cw.screenId)}`, { waitUntil: 'load' });
          await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        };
        const content = async (): Promise<string[]> => {
          await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
          await page.waitForSelector('.le-config', { timeout: 20_000 });
          await page.locator('.insp-tab', { hasText: 'Content' }).click();
          await page.waitForSelector('.le-config [data-cfg-key="unitWords"]', { timeout: 20_000 });
          return page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>('.le-config > [data-cfg-key]')).map((el) => el.dataset['cfgKey'] ?? ''),
          );
        };
        const look = async (label: string): Promise<void> => {
          await page.locator('.insp-tab', { hasText: 'Style' }).click();
          await page.locator('.le-config [data-cfg-key="variant"] button', { hasText: label }).click();
        };
        const save = async (): Promise<string> => {
          await page.click('#savebar button[data-action="save"]');
          await page.waitForFunction(
            () => {
              const bar = document.querySelector('#savebar');
              const msg = bar?.querySelector('.msg')?.textContent ?? '';
              return msg !== '' || bar?.getAttribute('hidden') !== null || location.search.includes('saved');
            },
            undefined,
            { timeout: 20_000 },
          ).catch(() => undefined);
          await page.waitForLoadState('load');
          return (await page.locator('#savebar .msg').textContent().catch(() => '')) ?? '';
        };

        await open();
        const onBar = await content();
        expect(onBar, 'the bar offers no start date').toContain('from');
        expect(onBar, 'the bar offers an occasion').not.toContain('occasion');

        // A start after the target: said beside the field before anything is
        // saved, and refused by the save in the same words.
        const from = page.locator('.le-config label[data-cfg-key="from"] input[type="date"]');
        await from.fill(civilDate(cw.wall.now(), 40));
        await from.dispatchEvent('change');
        const said = page.locator('.le-config p[data-cfg-key="from"]');
        await expect.poll(async () => said.textContent()).toBe('The start date has to be before the date it counts down to.');
        expect(await said.getAttribute('role')).toBe('alert');
        const refused = await save();
        expect(refused).toContain('The start date has to be before the date it counts down to.');
        expect(read(), 'a refused start date was written').toEqual({ variant: 'progress', target, title: 'Holiday' });

        // A start before it saves, and the hint says what the bar is.
        await open();
        await content();
        await from.fill(civilDate(cw.wall.now(), -10));
        await from.dispatchEvent('change');
        await expect.poll(async () => said.textContent()).toBe('The bar runs from this date to the one above, and fills a little each day.');
        await save();
        await expect.poll(read).toEqual({ variant: 'progress', target, title: 'Holiday', from: civilDate(cw.wall.now(), -10) });

        // The occasion: its picker on its own look, and "Something else" an absence.
        await open();
        await content();
        await look('Occasion');
        const onOccasion = await content();
        expect(onOccasion, 'the occasion offers no picker').toContain('occasion');
        expect(onOccasion, 'the occasion offers a start date').not.toContain('from');
        const picker = page.locator('.le-config label[data-cfg-key="occasion"] select');
        expect(await picker.inputValue(), 'a fresh occasion is not “Something else”').toBe('custom');
        expect(await picker.locator('option').allTextContents()).toEqual([
          'Christmas', 'A birthday', 'Halloween', 'A holiday', 'School’s out', 'New Year', 'Something else',
        ]);
        await picker.selectOption('christmas');
        await save();
        await expect.poll(() => read()['occasion']).toBe('christmas');
        expect(read()['variant']).toBe('occasion');
        await open();
        await content();
        await picker.selectOption('custom');
        await save();
        await expect.poll(() => 'occasion' in read()).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
