/**
 * The hole in the middle of every fresh install, measured on a real wall.
 *
 * Reported and reproduced: a paired 1080x1920 wall with one calendar added and
 * nothing else configured drew the clock at y=58..250, **nothing at all until
 * y=576**, then the agenda and the month. A 280px band of wall with nothing on
 * it, and 19% of the height in empty bands of 120px or more.
 *
 * Nothing was drawing wrongly. The Classic seed places a forecast at
 * y=0.16..0.28 and a rota badge at y=0.03..0.15, the manifest correctly drops
 * both for a household that has set up neither (`widgetIsSetUp` — a box that
 * can only ever say "Nothing to show yet." is a sentence about somebody's admin
 * printed on their kitchen calendar), and a free-form canvas is absolutely
 * positioned, so the vacated space stays vacated. Retiring the reflowing "auto"
 * layout is what took away the wall's ability to close it.
 *
 * So the fix seeds from what is actually set up, and this file is the
 * measurement that says whether it worked — geometry read off the browser, never
 * a class name, because the boxes were always in the DOM and always in the right
 * place. What was wrong was which boxes existed at all.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { browser, install, settleWall, shutDownBrowser, type Installation, type NamedFeed } from './browser-harness.js';
import { applyTemplate, reseedClassicForSetUp, type DisplayTemplate } from '../src/api/templates.js';
import { classicFor } from '../src/templates/classic.js';
import { householdSetUp } from '../src/modules/index.js';

process.env['TZ'] = 'UTC';

const SLOW = 180_000;

/**
 * The threshold from the report: a band of 120px on the 1920px-tall wall it was
 * measured on. Applied to whichever wall is under the browser, so landscape is
 * held to the same absolute run of blank glass rather than the same fraction.
 */
const BAND_PX = 120;

/**
 * One ordinary family calendar — the whole of what a fresh install has.
 *
 * Deliberately **spread**: the next six events fall on six different days. The
 * agenda's height is mostly its day headers, so that is the shape that scales
 * it smallest and the only shape in which the box's *aspect* can be seen at
 * all — bunch the same events onto three days and the section fits with room
 * to spare, every geometry measures the same, and the comparison below goes
 * quiet. (It did: an earlier version of this fixture had two or three things on
 * some days, and the agenda regression this file exists to catch passed clean
 * through it.)
 */
const CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      { title: 'Bin day', day: 2 },
      { title: "Grandma's 80th birthday", day: 4 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
      { title: 'Swimming lesson', day: 0, from: '0730', to: '0830' },
      { title: 'Car service', day: 6, from: '0800', to: '1200' },
      { title: 'Half term', day: 12 },
      { title: 'Book club', day: 3, from: '1930', to: '2130' },
    ],
  },
];

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: CALENDARS });
  // Nothing else. No location, no rota, no Home Assistant — the state every
  // install passes through, and the one the fault was reported on.
  link = await wall.pairLink('Kitchen');
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
});

interface Measured {
  readonly canvas: { readonly w: number; readonly h: number };
  /** Every empty run down the canvas, in CSS pixels, largest first. */
  readonly bands: readonly number[];
  /** Rows of the canvas no widget spans, as a fraction of its height. */
  readonly emptyFraction: number;
  /** Canvas area no widget covers, as a fraction. The landscape measure. */
  readonly emptyArea: number;
  readonly widgets: readonly string[];
}

/**
 * Draw the paired wall at one size and measure where nothing is drawn.
 *
 * Two measures, because the fault has two shapes and one of them is invisible
 * to the other.
 *
 * **Bands.** A row of the canvas is covered when any widget box spans it. This
 * is the portrait fault exactly: the forecast and the badge sit in their own
 * rows, so dropping them leaves rows of wall with nothing in them.
 *
 * **Area.** Landscape puts all three utility widgets in one strip across the
 * top, so dropping two of them leaves the strip's *row* covered by the clock
 * and 71% of its width blank — a band scan reports a perfect wall. Measured on
 * a 0.5%-resolution grid, which is far finer than the difference it has to see
 * (30% of the wall empty against 16%).
 *
 * Both read from `getBoundingClientRect`, so a box that is in the DOM and
 * drawing nothing still counts as covering its space. That is deliberate and it
 * is the harder bar: neither measure can be passed by leaving an empty Weather
 * box in place saying "Nothing to show yet."
 */
async function measure(size: { readonly width: number; readonly height: number }): Promise<Measured> {
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    return await page.evaluate(() => {
      const canvas = document.querySelector('.canvas') as HTMLElement;
      const rect = canvas.getBoundingClientRect();
      const height = Math.round(rect.height);
      const covered = new Array<boolean>(height).fill(false);
      const GRID = 200;
      const cells = new Array<boolean>(GRID * GRID).fill(false);
      const widgets: string[] = [];
      document.querySelectorAll('.canvas .fw').forEach((node) => {
        const box = (node as HTMLElement).getBoundingClientRect();
        widgets.push(
          Array.from((node as HTMLElement).classList).find((c) => c.startsWith('fw-') && c !== 'fw-fill') ??
            'fw-?',
        );
        const from = Math.max(0, Math.round(box.top - rect.top));
        const to = Math.min(height, Math.round(box.bottom - rect.top));
        for (let i = from; i < to; i += 1) covered[i] = true;

        // The same box on the area grid, in canvas-relative fractions.
        const left = Math.max(0, Math.round(((box.left - rect.left) / rect.width) * GRID));
        const right = Math.min(GRID, Math.round(((box.right - rect.left) / rect.width) * GRID));
        const top = Math.max(0, Math.round(((box.top - rect.top) / rect.height) * GRID));
        const bottom = Math.min(GRID, Math.round(((box.bottom - rect.top) / rect.height) * GRID));
        for (let row = top; row < bottom; row += 1) {
          for (let col = left; col < right; col += 1) cells[row * GRID + col] = true;
        }
      });
      const bands: number[] = [];
      let run = 0;
      for (let i = 0; i < height; i += 1) {
        if (covered[i] === true) {
          if (run > 0) bands.push(run);
          run = 0;
        } else run += 1;
      }
      if (run > 0) bands.push(run);
      const empty = bands.reduce((sum, band) => sum + band, 0);
      return {
        canvas: { w: rect.width, h: rect.height },
        bands: bands.sort((a, b) => b - a),
        emptyFraction: height > 0 ? empty / height : 0,
        emptyArea: cells.filter((cell) => !cell).length / cells.length,
        widgets: widgets.sort(),
      };
    });
  } finally {
    await context.close();
  }
}


/**
 * Every text run drawn on the wall, with how small and how much of it is shown.
 *
 * The reason this file measures type at all: closing the hole moves the agenda
 * and the month, and a template's box is the only lever either has on its type.
 * The agenda and the rota badge are laid out at their box width and then
 * `transform: scale()`d to fill it, and **a transform multiplies straight
 * through `max(…, var(--t-floor))`** — so the 22px floor does not survive
 * scale-to-fit, and a box change is a type change whether or not anybody meant
 * one. `browser-classic-proportions.test.ts` measures the fully-equipped wall;
 * nothing measured this one, which is the wall most households have.
 */
interface FontRun {
  readonly where: string;
  readonly text: string;
  readonly font: number;
  readonly fit: number;
  /** The cascade's own size, before any transform. */
  readonly raw: number;
  /** The product of every transform above it. */
  readonly scale: number;
}

interface RunReading {
  readonly runs: readonly FontRun[];
  /** Font state at measure time, to tell a lost font race from a scale drift. */
  readonly diag: string;
}

async function measureRuns(size: {
  readonly width: number;
  readonly height: number;
}): Promise<RunReading> {
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  try {
    /*
     * Hold the first manifest back, then reload. `fitToBox` measures once, as
     * its section is appended, and nothing re-runs it — so on a cold context
     * whose fonts have not arrived the wall keeps a fit computed against
     * fallback metrics. The second load has them in the HTTP cache, which is
     * the steady state a wall that has been hanging for a minute is in.
     */
    let held = false;
    await page.route('**/d/manifest*', async (route) => {
      if (!held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      await route.continue();
    });
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    await page.reload({ waitUntil: 'load' });
    await settleWall(page);
    return await page.evaluate(() => {
      /** The cascade's size times every transform above it — what is drawn. */
      const scaleOf = (element: Element): number => {
        let scale = 1;
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const matched = /matrix\(([^)]+)\)/.exec(getComputedStyle(node).transform);
          if (matched === null) continue;
          const n = matched[1]!.split(',').map(Number);
          const determinant = Math.abs(n[0]! * n[3]! - n[1]! * n[2]!);
          if (determinant > 0) scale *= Math.sqrt(determinant);
        }
        return scale;
      };
      const out: {
        where: string;
        text: string;
        font: number;
        fit: number;
        raw: number;
        scale: number;
      }[] = [];
      const seen = new Set<Element>();
      const walker = document.createTreeWalker(
        document.querySelector('.canvas') as Node,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.nodeValue ?? '').trim() === '') continue;
        const element = node.parentElement;
        if (element === null || seen.has(element)) continue;
        seen.add(element);
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const needed = Math.max(element.scrollWidth, element.clientWidth);
        // One walk, reused — a second `scaleOf` call per element is measurable
        // work inside the very page whose timing is under suspicion.
        const raw = parseFloat(style.fontSize);
        const scale = scaleOf(element);
        out.push({
          where: String(element.className).trim().split(/\s+/)[0] ?? element.tagName,
          text: (element.textContent ?? '').trim().slice(0, 60),
          font: raw * scale,
          fit: needed > 0 ? Math.min(1, element.clientWidth / needed) : 1,
          raw,
          scale,
        });
      }
      return { runs: out, diag: `fonts.status=${document.fonts.status}` };
    });
  } finally {
    await context.close();
  }
}

/** The drawn height of a month cell, which is what the grid's height buys. */
async function measureCellHeight(size: {
  readonly width: number;
  readonly height: number;
}): Promise<number> {
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    return await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.canvas .hz-cell'));
      if (cells.length === 0) return 0;
      const heights = cells.map((cell) => cell.getBoundingClientRect().height).sort((a, b) => a - b);
      // The median, so one short row at the end of a month says nothing.
      return heights[Math.floor(heights.length / 2)] ?? 0;
    });
  } finally {
    await context.close();
  }
}

const report = (measured: Measured): string =>
  `${Math.round(measured.canvas.w)}x${Math.round(measured.canvas.h)}: ` +
  `widgets [${measured.widgets.join(', ')}], ` +
  `empty rows ${(measured.emptyFraction * 100).toFixed(1)}%, ` +
  `empty area ${(measured.emptyArea * 100).toFixed(1)}%, ` +
  `bands ${measured.bands.slice(0, 4).join('/')}px`;

describe('a fresh install with one calendar', () => {
  it(
    'draws no empty band down the portrait wall',
    async () => {
      const measured = await measure({ width: 1080, height: 1920 });
      const worst = measured.bands[0] ?? 0;
      /*
       * The reported fault was a single 280px band. Anything at or over 120px
       * on this wall reads as a wall with a piece missing rather than as a
       * margin between two widgets.
       */
      expect(worst, `the widest empty band. ${report(measured)}`).toBeLessThan(BAND_PX);
      /*
       * And the total, which is the number the report gives: 19% of the height
       * in bands of 120px or more. Under 5% is the shipped Classic's own
       * spacing — 0.02 above, 0.005 between, 0.01 below — so this says the
       * calendar-only wall is as tightly packed as the wall Classic was drawn
       * for, not merely better than a hole.
       */
      expect(measured.emptyFraction, `the empty fraction. ${report(measured)}`).toBeLessThan(0.05);
      /*
       * And by area, which is the measure landscape needs and which portrait
       * has too. Measured on this wall: 28.4% of it empty on the shipped
       * Classic seed, 13.6% on the variant. The two populations are 4 points
       * apart at their closest (a household with a location and no rota: 18.1%
       * seeded the old way, 14.1% the new), so 16% is the line between them.
       */
      expect(measured.emptyArea, `the empty area. ${report(measured)}`).toBeLessThan(0.16);
      // And it is drawing the product: both calendar views and a clock.
      expect(measured.widgets, report(measured)).toEqual(['fw-calendar', 'fw-calendar', 'fw-clock']);
    },
    SLOW,
  );

  it(
    'draws no empty band across the landscape wall',
    async () => {
      const measured = await measure({ width: 1920, height: 1080 });
      const worst = measured.bands[0] ?? 0;
      expect(worst, `the widest empty band. ${report(measured)}`).toBeLessThan(BAND_PX);
      /*
       * Landscape is a strip over two columns, so three margins rather than
       * Classic's own four — the shipped Classic sits at 12% here with its
       * widest band 43px, and this variant tightens the strip to 9%. The cap is
       * a guard on that, not a target.
       */
      expect(measured.emptyFraction, `the empty fraction. ${report(measured)}`).toBeLessThan(0.13);
      /*
       * **This is the landscape assertion that matters**, and the band scan
       * above cannot make it: all three utility widgets share one strip, so
       * dropping two of them leaves that strip's rows covered by the clock and
       * 71% of its width blank — a perfect band reading over a wall with a hole
       * in it. By area: the shipped Classic covers 80.5% with everything set up
       * and 69.8% with nothing; this variant covers 84%.
       */
      expect(measured.emptyArea, `the empty area. ${report(measured)}`).toBeLessThan(0.22);
      expect(measured.widgets, report(measured)).toEqual(['fw-calendar', 'fw-calendar', 'fw-clock']);
    },
    SLOW,
  );
});

describe('the calendar-only wall, read from across a kitchen', () => {
  it(
    'draws no class of text smaller than the wall Classic was measured on',
    async () => {
      /*
       * The measurement that changed this variant, kept as the guard on it.
       *
       * Closing the hole means moving boxes, and a template's box is the only
       * lever the agenda's type has: it is laid out at the box width and then
       * `transform: scale()`d to fit, so **a transform multiplies straight
       * through `max(…, var(--t-floor))`** and the 22px floor does not survive
       * scale-to-fit. An absolute floor cannot be the assertion here — a sparse
       * calendar spreads six events over six days, and the agenda's height is
       * mostly its day headers, so its labels sit at ~15px on this wall
       * whatever the template does (`classic.ts` says so, and no template
       * geometry reaches it).
       *
       * So the claim is comparative and exact: **the same data, the same
       * screen, the same browser, one variant against the other.** Every class
       * of text on the calendar-only wall must be at least as large as on the
       * wall Classic itself was measured on. The first draft of this variant
       * gave the agenda the reclaimed height and failed it — 15.7px to 15.2px,
       * because a taller box at the same width re-flows the section narrower
       * and its rows wrap.
       */
      const screen = (wall.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

      const smallestByClass = async (
        variant: DisplayTemplate,
      ): Promise<{ smallest: ReadonlyMap<string, FontRun>; diag: string }> => {
        applyTemplate(wall.db, screen, variant);
        const { runs, diag } = await measureRuns({ width: 1080, height: 1920 });
        const smallest = new Map<string, FontRun>();
        for (const run of runs) {
          const held = smallest.get(run.where);
          if (held === undefined || run.font < held.font) smallest.set(run.where, run);
        }
        return { smallest, diag };
      };

      const classic = await smallestByClass(classicFor({ modules: ['weather'], shift: true }));
      const seeded = await smallestByClass(classicFor({ modules: [], shift: false }));

      // Recorded from Node, on every run rather than on a failure, so the
      // distribution is visible and the recording cannot sit inside the race.
      if (process.env['MW_BANDS_LOG'] !== undefined) {
        const line = [...classic.smallest]
          .map(([where, was]) => {
            const now = seeded.smallest.get(where);
            return now === undefined
              ? `${where}=absent`
              : `${where} classic(${was.raw}x${was.scale.toFixed(6)}=${was.font.toFixed(4)}) ` +
                  `seeded(${now.raw}x${now.scale.toFixed(6)}=${now.font.toFixed(4)})`;
          })
          .join('; ');
        appendFileSync(
          process.env['MW_BANDS_LOG'] as string,
          `${new Date().toISOString()} ${classic.diag}/${seeded.diag} ${line}\n`,
        );
      }

      for (const [where, was] of classic.smallest) {
        const now = seeded.smallest.get(where);
        // A class Classic drew and this variant does not is the forecast's and
        // the badge's own text, which is the whole point — it has nowhere to be.
        if (now === undefined) continue;
        expect(
          now.font,
          `"${where}" is ${now.font.toFixed(4)}px on the calendar-only wall, ` +
            `${was.font.toFixed(4)}px on the wall Classic was measured on\n` +
            `  calendar-only: raw=${now.raw} scale=${now.scale.toFixed(6)} text="${now.text}"\n` +
            `        classic: raw=${was.raw} scale=${was.scale.toFixed(6)} text="${was.text}"\n` +
            `  calendar-only ${seeded.diag}\n` +
            `        classic ${classic.diag}`,
        ).toBeGreaterThanOrEqual(was.font - 0.05);
      }

      /*
       * And the height has to have gone somewhere useful, or this is the same
       * wall with a bigger margin. It goes to the month, and the reason it goes
       * there rather than to the agenda is `fw-fill`: the month is the one
       * widget that fills its box instead of being scaled into it, so height
       * becomes cell height, which is where a row of event text and the
       * calendar's own colour live (`classic.ts` and
       * `browser-source-colours.test.ts` carry that argument at length).
       *
       * Measured on the cells themselves, because "the box is taller" is a
       * claim about the template and this one is about the glass.
       */
      const cellHeight = async (variant: DisplayTemplate): Promise<number> => {
        applyTemplate(wall.db, screen, variant);
        return measureCellHeight({ width: 1080, height: 1920 });
      };
      const nowCell = await cellHeight(classicFor({ modules: [], shift: false }));
      const wasCell = await cellHeight(classicFor({ modules: ['weather'], shift: true }));
      // Restore the seed the rest of the file measures, so order cannot matter.
      applyTemplate(wall.db, screen, classicFor({ modules: [], shift: false }));
      expect(
        nowCell,
        `a month cell is ${nowCell.toFixed(0)}px on the calendar-only wall against ` +
          `${wasCell.toFixed(0)}px on the wall Classic was measured on — the reclaimed ` +
          'height went somewhere else',
      ).toBeGreaterThan(wasCell);
    },
    SLOW,
  );
});

describe('the same household, once a location is set', () => {
  it(
    'gains the forecast on the next boot and is still hole-free',
    async () => {
      const at = Date.now();
      wall.db
        .prepare(
          `UPDATE household_settings SET weather_enabled = 1, latitude = ?, longitude = ?,
             weather_provider = 'openmeteo', updated_at = ? WHERE id = 'singleton'`,
        )
        .run(51.5074, -0.1278, at);
      const iso = (offset: number): string =>
        new Date(at + offset * 86_400_000).toISOString().slice(0, 10);
      const days = ['Today', 'Tomorrow', 'Wednesday', 'Thursday', 'Friday'].map((name, index) => ({
        name,
        date: iso(index),
        high: 18 - index,
        low: 9 + index,
        unit: 'C',
        summary: ['Sunny', 'Light rain', 'Cloudy', 'Sunny', 'Showers'][index]!,
        icon: '☀',
      }));
      wall.db
        .prepare(
          `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        )
        .run('openmeteoforecast', 'openmeteo', 'openmeteo:forecast', JSON.stringify({ days, fetchedAt: at }), at, null);

      // A restart. This is the moment the choice is re-made — the household is
      // not looking at the wall while they type a postcode into the admin.
      reseedClassicForSetUp(wall.db, householdSetUp(wall.db));

      const measured = await measure({ width: 1080, height: 1920 });
      expect(measured.widgets, `the forecast is placed. ${report(measured)}`).toContain('fw-weather');
      expect(measured.widgets, report(measured)).toEqual([
        'fw-calendar',
        'fw-calendar',
        'fw-clock',
        'fw-weather',
      ]);
      const worst = measured.bands[0] ?? 0;
      expect(worst, `the widest empty band. ${report(measured)}`).toBeLessThan(BAND_PX);
      expect(measured.emptyFraction, `the empty fraction. ${report(measured)}`).toBeLessThan(0.05);
      // 18.1% seeded the old way — the forecast lands, and the badge's corner
      // of the top band is the hole that is left. 14.1% here.
      expect(measured.emptyArea, `the empty area. ${report(measured)}`).toBeLessThan(0.16);
    },
    SLOW,
  );
});
