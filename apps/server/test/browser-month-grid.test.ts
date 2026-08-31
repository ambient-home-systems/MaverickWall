/**
 * The month grid, measured on a wall.
 *
 * The month grid is the product's central screen and it could not be read.
 * Measured on a paired 1080x1920 portrait wall carrying three ordinary family
 * calendars, the shipped treatment drew 37 event names and cut 32 of them —
 * the worst showing 26% of its string. At that depth a truncation is not a
 * shortened title, it is a *different* string, and two events can share it:
 * "Year 6 trip to the Science Museum" and "Year 6 sports day" were both
 * "Year 6…", and seventeen separate cells read "Stan…".
 *
 * The arithmetic behind that is not fixable inside a pill. 972px of usable
 * width over seven columns is about 139px a cell, of which a pill's inside is
 * 100; at the 22px the design calls its floor, that is eight characters. And in
 * landscape the grid used to buy width by spending type, landing at 18.6px —
 * under its own floor, on the screen viewed from furthest away.
 *
 * So four things changed, and this file is the measurement of each:
 *
 *  1. flat names are the default cell treatment, and a pill is a choice;
 *  2. a title wraps to two lines and is drawn *whole or not at all*;
 *  3. an all-day event — a birthday, a bin day, a half term, the titles that
 *     truncate worst — takes the whole cell, before the timed ones;
 *  4. 22px is a hard floor, and when it binds the cell gives up a row rather
 *     than the type giving up a point.
 *
 * Everything here is measured in a real browser against computed styles and
 * geometry, never against class names. This project has shipped a bug where
 * the class was right and the pixels were wrong, and it has shipped a month
 * cell reading "+6" with none of its six events — nothing overflowing, every
 * counter truthful, and the grid saying nothing at all. "Nothing overflowed" is
 * not the assertion. What is drawn, and whether it can be read, is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  measureMonthGrid,
  settleWall,
  shutDownBrowser,
  type CellText,
  type Installation,
  type MonthGrid,
  type NamedFeed,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

/*
 * The container a household installs on: `docker run` with no `TZ` resolves to
 * UTC, and the wizard is told Europe/London. Both halves matter here — the feed
 * writes its timed events in London and its all-day ones as bare dates, which
 * is what a real calendar does.
 */
process.env['TZ'] = 'UTC';

/** Long: each of these boots a server, a browser context and a wall. */
const SLOW = 120_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

/**
 * The three walls this project keeps measuring, and why these three.
 *
 * 1080x1920 is the design target and the portrait kitchen tablet. 1920x1080 is
 * the hall television, where the rem is 1.5x a much shorter canvas and the type
 * used to land at 18.6px. 1280x720 is the cheap panel, where it landed at
 * 12.4px — the smallest wall and the one furthest from the reader.
 */
const WALLS = [
  { width: 1080, height: 1920 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
] as const;

/**
 * Three calendars an ordinary household has, with the titles people write.
 *
 * Written as feeds served over loopback rather than as rows, so the whole path
 * — fetch through the SSRF guard, parse, expand, store, manifest, draw — is
 * what is measured. The long titles are not invented to be awkward: they are
 * the ones the reported wall was drawing as "Year…", "Desi…", "INSE…" and
 * "Gra…".
 */
const CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      { title: 'Bin day', day: -5 },
      { title: 'Bin day', day: 2 },
      { title: 'Bin day', day: 9 },
      { title: 'Bin day', day: 16 },
      { title: "Grandma's 80th birthday", day: 4 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
      { title: 'Car service', day: 11, from: '0800', to: '1200' },
      { title: 'Half term', day: 18 },
      { title: 'Half term', day: 19 },
      { title: 'Swimming lesson', day: -3, from: '0730', to: '0830' },
      { title: 'Swimming lesson', day: 4, from: '0730', to: '0830' },
      { title: 'Swimming lesson', day: 11, from: '0730', to: '0830' },
      { title: 'Book club', day: 5, from: '1930', to: '2130' },
    ],
  },
  {
    name: 'School',
    events: [
      { title: 'Year 6 trip to the Science Museum', day: 3, from: '0830', to: '1600' },
      { title: 'INSET day - school closed', day: 7 },
      { title: 'Year 6 sports day', day: 14, from: '0930', to: '1500' },
      { title: 'Parents evening', day: 2, from: '1800', to: '2000' },
      { title: 'Football practice', day: 1, from: '1730', to: '1900' },
      { title: 'Football practice', day: 8, from: '1730', to: '1900' },
      { title: 'Football practice', day: 15, from: '1730', to: '1900' },
      { title: 'School photos', day: 6, from: '0900', to: '1100' },
      { title: 'Assembly', day: 10, from: '0915', to: '1000' },
      { title: 'Reading morning', day: 13, from: '0845', to: '0930' },
      { title: 'Term ends', day: 21 },
      { title: 'Cake sale', day: 17, from: '1500', to: '1600' },
      { title: 'Swimming gala', day: 12, from: '1300', to: '1700' },
      { title: 'Class trip deposit due', day: 5 },
    ],
  },
  {
    name: 'Work',
    events: [
      { title: 'Standup', day: -1, from: '0930', to: '0945' },
      { title: 'Standup', day: 0, from: '0930', to: '0945' },
      { title: 'Standup', day: 1, from: '0930', to: '0945' },
      { title: 'Standup', day: 2, from: '0930', to: '0945' },
      { title: 'Standup', day: 3, from: '0930', to: '0945' },
      { title: 'Standup', day: 6, from: '0930', to: '0945' },
      { title: 'Standup', day: 7, from: '0930', to: '0945' },
      { title: 'Design critique - wall renderer', day: 2, from: '1400', to: '1500' },
      { title: 'Quarterly planning review', day: 8, from: '1000', to: '1200' },
      { title: 'One to one', day: 5, from: '1130', to: '1200' },
      { title: 'Sprint retro', day: 9, from: '1600', to: '1700' },
      { title: 'On call', day: 13 },
    ],
  },
];

/**
 * A fourth calendar with one deliberately overloaded day.
 *
 * `viewmodel.ts` caps the slim per-cell list at twelve events while
 * `eventCount` stays the day's true total, and the documented failure is a cell
 * saying "+9" where it owes "+17". Fourteen on one day is what makes those two
 * numbers disagree, and `Zebra` is short enough to always be drawable, so the
 * cell can be found from the outside by the name it shows.
 */
const OVERLOADED: NamedFeed = {
  name: 'Overloaded',
  events: [
    { title: 'Zebra', day: 20, from: '0700', to: '0715' },
    ...Array.from({ length: 13 }, (_, index) => ({
      title: `Committee meeting number ${index + 1}`,
      day: 20,
      from: `${String(8 + index).padStart(2, '0')}00`,
      to: `${String(8 + index).padStart(2, '0')}45`,
    })),
  ],
};

/**
 * One day built to catch a fault the assertions above would let through.
 *
 * On a 1280x720 wall a cell has room for one row and its counter. "Year 6 trip
 * to the Science Museum" wraps to two lines there and does not fit; "Yoga"
 * fits on one and does. A cell must therefore draw "Yoga" and say "+1" —
 * showing nothing and saying "+2" is truthful, permitted by every other check
 * here, and is the grid giving up a name it had room for.
 *
 * The bug it pins is one this change introduced and only a measurement caught:
 * the packing that reserves room for the counter used to resume from the
 * previous packing's leftovers, so a short row hidden in the first pass was
 * never looked at again once the long row above it was dropped.
 */
const CROWDED_DAY = 22;
const CROWDED: NamedFeed = {
  name: 'Crowded',
  events: [
    { title: 'Year 6 trip to the Science Museum', day: CROWDED_DAY, from: '0900', to: '1500' },
    { title: 'Yoga', day: CROWDED_DAY, from: '1800', to: '1900' },
  ],
};

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: [...CALENDARS, OVERLOADED, CROWDED] });
  link = await wall.pairLink();
  /*
   * The screen's own canvas, not the household's.
   *
   * A screen is seeded with a canvas of its own when it is created, so writing
   * the household's would be overridden by the wall's — every measurement here
   * would silently be of the Classic layout instead of the widget under test.
   */
  screenId = (wall.db.prepare('SELECT id FROM screens').get() as { id: string }).id;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Put one calendar widget on the wall, filling the canvas, in this treatment. */
function canvasOf(cellEvents?: string): void {
  const config: Record<string, unknown> = { mode: 'month' };
  if (cellEvents !== undefined) config['cellEvents'] = cellEvents;
  for (const orientation of ['portrait', 'landscape'] as const) {
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: [
        { id: `cal-${orientation}`, type: 'calendar', x: 0.02, y: 0.02, w: 0.96, h: 0.96, z: 0, config },
      ],
      background: null,
    });
  }
}

/**
 * Draw the wall at one size and measure the grid.
 *
 * A fresh context per size rather than a resize: the trim is measured as the
 * wall draws, and `main.ts` only re-applies the geometry on `resize` — the next
 * fifteen-second tick is what redraws. Three sizes here means three walls,
 * which is also what they are in a household.
 */
async function drawAt(
  size: { readonly width: number; readonly height: number },
  cellEvents?: string,
): Promise<MonthGrid> {
  canvasOf(cellEvents);
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    return await measureMonthGrid(page);
  } finally {
    await context.close();
  }
}

/** Everything a failure needs to be actionable: the words, and how much fits. */
function report(runs: readonly CellText[]): string {
  return runs
    .slice()
    .sort((a, b) => a.fit - b.fit)
    .slice(0, 8)
    .map(
      (run) =>
        `  "${run.text}" in ${run.where}: needs ${Math.round(run.neededPx)}px, ` +
        `has ${Math.round(run.widthPx)}px (${Math.round(run.fit * 100)}%) at ${run.fontPx.toFixed(1)}px`,
    )
    .join('\n');
}

const at = (size: { readonly width: number; readonly height: number }): string =>
  `${size.width}x${size.height}`;

describe('the month grid, drawn on a real wall', () => {
  it(
    'draws event names by default, where it used to draw dots',
    async () => {
      const grid = await drawAt(WALLS[0]);
      /*
       * `cellEvents` unset used to mean `dots`: a cell that says a day is busy
       * and never says what is on it. The default is the treatment that can
       * show a name now, and `dots` is a value a household writes.
       */
      expect(grid.titles.length).toBeGreaterThan(0);
      const quiet = await drawAt(WALLS[0], 'dots');
      expect(quiet.titles).toHaveLength(0);
    },
    SLOW,
  );

  for (const size of WALLS) {
    it(
      `cuts no title it draws, at ${at(size)}`,
      async () => {
        const grid = await drawAt(size);
        const cut = grid.titles.filter((title) => title.truncated);
        expect(
          cut.length,
          `${cut.length} of ${grid.titles.length} titles are cut off:\n${report(cut)}`,
        ).toBe(0);
        // And it is drawing names at all: zero cut out of zero drawn would pass
        // this on a grid that had gone back to dots.
        expect(grid.titles.length).toBeGreaterThan(0);
      },
      SLOW,
    );

    it(
      `draws nothing under the ${FLOOR_PX}px floor, at ${at(size)}`,
      async () => {
        const grid = await drawAt(size);
        // Every run in the grid, furniture included: a weekday header nobody can
        // read is as absent as a title. Half a pixel of slack for sub-pixel
        // rounding of a `max()` against a fractional rem.
        const small = grid.texts.filter((run) => run.fontPx < FLOOR_PX - 0.5);
        expect(
          small.length,
          `drawn under the floor:\n` +
            small
              .map((run) => `  "${run.text}" in ${run.where} at ${run.fontPx.toFixed(1)}px`)
              .join('\n'),
        ).toBe(0);
        expect(grid.texts.length).toBeGreaterThan(0);
      },
      SLOW,
    );

    it(
      `says something in every cell it can, and counts the rest, at ${at(size)}`,
      async () => {
        const grid = await drawAt(size);
        const busy = grid.cells.filter((cell) => cell.total > 0);
        expect(busy.length).toBeGreaterThan(0);

        for (const cell of busy) {
          if (cell.shown.length > 0) {
            /*
             * The whole rule: a title on the glass is a title that can be read.
             * Anything that would have to be cut is hidden and counted instead,
             * because "Year 6…" is not a shortened title, it is a different one.
             */
            for (const title of cell.shown) {
              expect(
                title.truncated,
                `day ${cell.day} draws "${title.text}" cut to ${Math.round(title.fit * 100)}%`,
              ).toBe(false);
            }
          } else {
            /*
             * And a cell with no room says so. This is the half that matters:
             * the documented failure here is a cell reading "+6" and showing
             * none of its six — truthful, and a grid that has stopped saying
             * what is on. Silence *without* the count is the unacceptable one.
             */
            expect(cell.more, `day ${cell.day} holds ${cell.total} events and says nothing`).toMatch(
              /^\+\d+$/,
            );
          }
        }
      },
      SLOW,
    );

    it(
      `accounts for every event on every day, at ${at(size)}`,
      async () => {
        const grid = await drawAt(size);
        const busy = grid.cells.filter((cell) => cell.total > 0);
        expect(busy.length).toBeGreaterThan(0);
        for (const cell of busy) {
          expect(
            cell.shown.length + cell.moreCount,
            `day ${cell.day}: ${cell.shown.length} drawn + "${cell.more}" != ${cell.total} on that day`,
          ).toBe(cell.total);
        }
      },
      SLOW,
    );
  }

  it(
    'wraps a title to a second line rather than giving it up',
    async () => {
      /*
       * The other half of "whole or not at all". With one line to work in, the
       * rule still cuts nothing — it just hides far more, and the grid says
       * much less while every clipping check stays green. So the wrap itself is
       * measured: something on the wall is drawn over two lines.
       */
      const grid = await drawAt(WALLS[0]);
      const wrapped = grid.titles.filter((title) => title.lines === 2);
      expect(
        wrapped.length,
        `nothing wrapped; the longest drawn was ` +
          `"${grid.titles.slice().sort((a, b) => b.neededPx - a.neededPx)[0]?.text ?? 'nothing'}"`,
      ).toBeGreaterThan(0);
      // And no further: a third line is a title this cell should have given up.
      expect(Math.max(...grid.titles.map((title) => title.lines))).toBe(2);
    },
    SLOW,
  );

  it(
    'draws the short event beside a long one it had no room for',
    async () => {
      const grid = await drawAt(WALLS[2]);
      const cell = grid.cells.find((one) => one.shown.some((title) => title.text === 'Yoga'));
      expect(
        cell,
        'the cell drew neither of its two events; a row it had room for was given up ' +
          'because a taller one above it did not fit',
      ).toBeDefined();
      expect(cell?.total).toBe(2);
      expect(cell?.more).toBe('+1');
    },
    SLOW,
  );

  it(
    'counts the day rather than the rows it was sent',
    async () => {
      /*
       * A second opinion on `data-count` itself, which every assertion above
       * takes on trust. The fixture puts fourteen events on one day; the model
       * hands the renderer twelve. A cell that counted its rows would say "+11"
       * where it owes "+13" — the documented "+9 rather than +17".
       */
      const grid = await drawAt(WALLS[0]);
      const overloaded = grid.cells.find((cell) =>
        cell.shown.some((title) => title.text === 'Zebra'),
      );
      expect(overloaded, 'the overloaded day drew none of its names').toBeDefined();
      expect(overloaded?.total).toBe(14);
      expect((overloaded?.shown.length ?? 0) + (overloaded?.moreCount ?? 0)).toBe(14);
    },
    SLOW,
  );

  it(
    'gives an all-day event the whole cell instead of a dot column',
    async () => {
      const grid = await drawAt(WALLS[0]);
      const allDay = grid.titles.filter((title) => title.allDay);
      const timed = grid.titles.filter((title) => !title.allDay);
      expect(allDay.length, 'no all-day event was drawn at all').toBeGreaterThan(0);
      expect(timed.length, 'no timed event was drawn at all').toBeGreaterThan(0);

      /*
       * The claim in pixels. "The row is full width" is *not* the assertion —
       * every row is a stretched flex item and spans the cell, so that would
       * pass on the treatment this replaced. What changes is the words: a timed
       * event spends a column on its colour dot and an all-day one does not,
       * because its colour is a rule down the row's own edge.
       */
      for (const title of allDay) {
        expect(
          title.markerPx,
          `the all-day "${title.text}" still pays ${title.markerPx.toFixed(1)}px for a dot`,
        ).toBe(0);
        expect(
          title.ofCell,
          `the all-day "${title.text}" gets only ${(title.ofCell * 100).toFixed(0)}% of its cell`,
        ).toBeGreaterThan(0.9);
      }
      for (const title of timed) {
        expect(title.markerPx, `the timed "${title.text}" lost its colour dot`).toBeGreaterThan(0);
      }
      expect(Math.min(...allDay.map((t) => t.ofCell))).toBeGreaterThan(
        Math.max(...timed.map((t) => t.ofCell)),
      );
    },
    SLOW,
  );

  it(
    'draws the all-day events above the timed ones in the same cell',
    async () => {
      /*
       * Honest about what this does and does not prove.
       *
       * The ordering is over-determined: an all-day event starts at midnight,
       * so it sorts ahead of a timed one on start time alone, and
       * `buildManifest` sorts explicitly for it as well. Removing either was
       * checked and neither turns this red — which is why the renderer no
       * longer sorts a third time, and why this is a guard on the property a
       * household sees rather than a test of a change.
       *
       * It still earns its place: the trim now cuts from the bottom, so what
       * sorts first is what survives a cell with no room, and a future change
       * that reordered rows anywhere along that path would be silent without
       * it. A wide wall, so cells hold both kinds and the ordering is visible.
       */
      const grid = await drawAt(WALLS[1]);
      const mixed = grid.cells.filter(
        (cell) =>
          cell.shown.some((title) => title.allDay) && cell.shown.some((title) => !title.allDay),
      );
      expect(mixed.length, 'no cell drew an all-day event beside a timed one').toBeGreaterThan(0);
      for (const cell of mixed) {
        const lastAllDay = Math.max(
          ...cell.shown.filter((title) => title.allDay).map((title) => title.topPx),
        );
        const firstTimed = Math.min(
          ...cell.shown.filter((title) => !title.allDay).map((title) => title.topPx),
        );
        expect(lastAllDay, `day ${cell.day} draws a timed event above an all-day one`).toBeLessThan(
          firstTimed,
        );
      }
    },
    SLOW,
  );

  it(
    'still draws pills for a canvas that asked for them, and cuts fewer titles than they do',
    async () => {
      /*
       * The pill renderer is kept: it is a look a household can choose and
       * canvases have it stored. What is measured here is that choosing it
       * still gets it — and, on identical data at the same size, what the
       * default replaced.
       */
      const pills = await drawAt(WALLS[0], 'pills');
      const flat = await drawAt(WALLS[0]);
      expect(pills.titles.length).toBeGreaterThan(0);
      expect(pills.titles.some((title) => title.where.includes('hz-pill'))).toBe(true);
      expect(flat.titles.some((title) => title.where.includes('hz-rowtext'))).toBe(true);

      const cutPills = pills.titles.filter((title) => title.truncated).length;
      const cutFlat = flat.titles.filter((title) => title.truncated).length;
      expect(cutPills, 'the pill treatment stopped cutting titles; this comparison is stale').toBeGreaterThan(0);
      expect(cutFlat).toBe(0);
    },
    SLOW,
  );
});
