/**
 * The month grid's three content rules, measured on a real wall.
 *
 * Each of them reclaims rows or serves the glance without spending a point of
 * type size, and each has a failure that is invisible in a screenshot:
 *
 *  1. **A multi-day event is drawn once.** "Half term" over seven days used to
 *     take a row in seven consecutive squares and print the same two words
 *     seven times, at the moment a row is the scarcest unit in the grid — a
 *     129px cell on the shipped Classic wall has room for one.
 *  2. **An overflow count never costs a name.** The counter used to take a
 *     line of its own and be paid for out of the same budget as the rows, so a
 *     cell with room for one row could spend it on "+3" and draw neither of
 *     its events.
 *  3. **A density mark**, whose *length* is the day's count, so the grid says
 *     something from a doorway with no legible text at all.
 *
 * Everything here is read off geometry and computed style, never off a class.
 * This project has shipped a control whose class was right and whose pixels
 * were an empty outline — a chore tick that drew as an outline while a
 * measurement counting `.ch-box-on` passed — and the density mark is exactly
 * that shape of thing: `.hz-mark` with no width is `.hz-mark`.
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
  type Installation,
  fixtureDate,
  type MonthGrid,
  type NamedFeed,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

process.env['TZ'] = 'UTC';

/** Long: each of these boots a server, a browser context and a wall. */
const SLOW = 120_000;

/**
 * The wall this is measured on.
 *
 * 1080x1920 is the design target and the portrait kitchen tablet. The widget
 * fills the canvas, which is the treatment under test rather than the shipped
 * Classic proportions — `browser-classic-proportions` measures those.
 */
const WALL = { width: 1080, height: 1920 } as const;
/** The cheap panel, where the type floor binds hardest and cells are smallest. */
const SMALL = { width: 1280, height: 720 } as const;

/**
 * A household's calendars, written so every trap in the rules has a case.
 *
 * `days` is a count of days on the wall and the harness turns it into `DTEND`
 * by adding it to `DTSTART`, because `DTEND` is exclusive and a fixture that
 * spells that out by hand is a fixture that will eventually spell it wrong.
 */

/**
 * The offset from today to a week start, a fortnight or so out.
 *
 * A seven-day event lands in exactly one grid row only if it *begins* on the
 * household's week start, which is Sunday by default — and today is any day of
 * the week, so a constant offset makes the shape of this fixture depend on
 * which day the suite happens to run. That is the `harness-fixture-dates`
 * lesson one file along: a test that is only right on some days reports the
 * truth some days and passes over the rest.
 *
 * Derived in the household's own zone, from `fixtureDate`, which is where
 * every other date in this suite comes from.
 */
const WEEK_START_OFFSET = ((): number => {
  const today = fixtureDate('Europe/London', 0);
  const at = new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(4, 6)) - 1,
      Number(today.slice(6, 8)),
    ),
  );
  // 0 is Sunday, which is this product's default week start.
  return 14 - at.getUTCDay();
})();

const CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      // Seven days inside one grid week: it starts on a Sunday, so it cannot
      // be broken by a week boundary whatever day the suite runs.
      { title: 'Half term', day: WEEK_START_OFFSET, days: 7 },
      // A fortnight, deliberately started so that it crosses a week boundary
      // whichever day of the week today is: fourteen days always does.
      { title: 'Grandparents visiting', day: 1, days: 14 },
      // The `DTEND`-exclusive control: one day, and never a bar.
      { title: "Grandma's 80th birthday", day: 4 },
      { title: 'Bin day', day: 2 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
      { title: 'Swimming lesson', day: 4, from: '0730', to: '0830' },
    ],
  },
  {
    name: 'Work',
    events: [
      // A daily standup: seven separate occurrences of one series, which must
      // stay seven rows. Grouping on the title would sweep them into a band.
      ...[0, 1, 2, 3, 4, 5, 6].map((day) => ({
        title: 'Standup',
        day,
        from: '0930',
        to: '0945',
      })),
      // A crowded day, so a cell has more than it can draw and owes a count.
      ...[0, 1, 2, 3].map((index) => ({
        title: `Committee meeting number ${index + 1}`,
        day: 9,
        from: `${String(8 + index).padStart(2, '0')}00`,
        to: `${String(8 + index).padStart(2, '0')}45`,
      })),
      { title: 'Quiet day', day: 12, from: '1000', to: '1030' },
    ],
  },
];

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: [...CALENDARS] });
  link = await wall.pairLink();
  // The screen's own canvas, not the household's — a screen is seeded with one
  // at creation and it wins, so writing the household's would silently measure
  // the Classic layout instead of the widget under test.
  screenId = (wall.db.prepare('SELECT id FROM screens').get() as { id: string }).id;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** One calendar widget filling the canvas, in the given treatment. */
function canvasOf(
  cellEvents?: string,
  extra: Record<string, unknown> = {},
  box: { readonly w?: number; readonly h?: number } = {},
): void {
  const config: Record<string, unknown> = { mode: 'month', ...extra };
  if (cellEvents !== undefined) config['cellEvents'] = cellEvents;
  const w = box.w ?? 0.96;
  const h = box.h ?? 0.96;
  for (const orientation of ['portrait', 'landscape'] as const) {
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: [
        { id: `cal-${orientation}`, type: 'calendar', x: 0.02, y: 0.02, w, h, z: 0, config },
      ],
      background: null,
    });
  }
}

async function drawAt(
  size: { readonly width: number; readonly height: number },
  cellEvents?: string,
  extra: Record<string, unknown> = {},
  box: { readonly w?: number; readonly h?: number } = {},
  patch?: (body: Record<string, unknown>) => void,
): Promise<MonthGrid> {
  canvasOf(cellEvents, extra, box);
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  try {
    if (patch !== undefined) {
      await page.route('**/d/manifest*', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        patch(body);
        /*
         * Answered without the ETag it came with, so the wall never gets a 304
         * carrying the *unpatched* body back on the next poll.
         */
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', 'x-server-time': String(Date.now()) },
          body: JSON.stringify(body),
        });
      });
    }
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    return await measureMonthGrid(page);
  } finally {
    await context.close();
  }
}

/**
 * Give the manifest a week number on every day, and a day for every date the
 * grid draws.
 *
 * **This is a stand-in, and the reason it is needed is a bug in the product
 * rather than in the test.** `renderHorizon` only draws the week-number column
 * when *every* week's first cell carries a number, which is right — a grid
 * with gaps down its first column is worse than one with no column. But the
 * manifest's window starts at `today - 1` (`DEFAULT_DAYS_BEFORE`) while the
 * grid starts on the week start, up to six days back, so the first week's
 * leading cells have no manifest day and carry no number. Measured: the
 * column renders only when today is the first or second day of the
 * household's week, so "Show week numbers" is a control that does nothing on
 * five days in seven. That is not this change's to fix and is written up
 * where the finding belongs; here it would make the assertion below vacuous
 * on most days, which is worse than a stand-in that says what it is.
 *
 * The numbering itself is deliberately arbitrary and never asserted on. What
 * is under test is where a *bar* lands once the layout has eight columns
 * instead of seven.
 */
function withWeekNumbers(body: Record<string, unknown>): void {
  const days = (body['days'] ?? []) as { date: string; weekNumber?: number }[];
  const window = body['window'] as { from: string } | undefined;
  const first = days[0]?.date ?? window?.from ?? '';
  if (first === '') return;
  const before: { date: string; weekNumber: number; shifts: unknown[]; events: unknown[] }[] = [];
  const at = new Date(`${first}T12:00:00Z`);
  for (let back = 1; back <= 7; back++) {
    const day = new Date(at.getTime() - back * 86_400_000);
    before.unshift({
      date: day.toISOString().slice(0, 10),
      weekNumber: 1,
      shifts: [],
      events: [],
    });
  }
  for (const day of days) day.weekNumber = 1;
  body['days'] = [...before, ...days];
}

/** Every node in the grid whose words are this title, bar or row alike. */
function saying(grid: MonthGrid, title: string): number {
  return (
    grid.titles.filter((run) => run.text === title).length +
    grid.spans.filter((bar) => bar.title === title).length
  );
}

describe('rule 1 — a multi-day event is drawn once, spanning its days', () => {
  it(
    'says "Half term" once, not seven times',
    async () => {
      const grid = await drawAt(WALL);
      /*
       * The whole rule in one number. Before this, seven consecutive cells
       * each carried a row saying the same two words — seven rows, in a grid
       * where a cell has room for one.
       */
      expect(saying(grid, 'Half term'), 'the title is drawn more than once').toBe(1);
      const bar = grid.spans.find((one) => one.title === 'Half term');
      expect(bar, 'no bar was drawn for the seven-day event').toBeDefined();
      expect(bar?.days).toBe(7);
      // And it is one object across the week rather than seven, which is what
      // "spanning" means in pixels: wider than one column by a long way.
      const columnWidth = (grid.cells[1]?.contentWidth ?? 0) + 6;
      expect((bar?.rightPx ?? 0) - (bar?.leftPx ?? 0)).toBeGreaterThan(columnWidth * 5);
    },
    SLOW,
  );

  it(
    'breaks a fortnight into two bars carrying one title',
    async () => {
      const grid = await drawAt(WALL);
      /*
       * Fourteen days cannot fit a seven-column week, so the run *has* to be
       * more than one bar — and a title on the second is the bug being fixed,
       * one row down instead of seven columns across.
       *
       * The pieces are put back together by the event's id rather than by its
       * title, because a continuation carrying no title is the thing under
       * test: attributing by the words would find only the piece that is
       * already known to be right.
       */
      const labelled = grid.spans.find((one) => one.title === 'Grandparents visiting');
      expect(labelled, 'the fortnight drew no labelled bar').toBeDefined();
      const run = grid.spans.filter((one) => one.id === labelled?.id);
      expect(run.length, 'the fortnight was drawn as one bar across a week boundary')
        .toBeGreaterThan(1);
      expect(
        run.filter((one) => one.labelled).length,
        'more than one bar of the run carries the title',
      ).toBe(1);
      expect(saying(grid, 'Grandparents visiting')).toBe(1);
      // Every bar of the run is in a different week, and together they cover
      // the days inside the grid's window — the pieces are a partition, not a
      // repetition.
      const rows = new Set(run.map((one) => grid.cells[one.cover[0] ?? -1]?.top));
      expect(rows.size, 'two bars of one run landed in the same week').toBe(run.length);
    },
    SLOW,
  );

  it(
    'leaves a one-day all-day event and a daily standup as rows',
    async () => {
      const grid = await drawAt(WALL);
      /*
       * `DTEND` is exclusive: a birthday on the 15th ends on the 16th. Deriving
       * a run length from the dates rather than from the occurrences puts every
       * birthday on a two-day bar, which is this repository's single most
       * common ICS bug wearing a new hat.
       */
      for (const bar of grid.spans) {
        expect(bar.title, 'a one-day event was drawn as a span').not.toBe(
          "Grandma's 80th birthday",
        );
        // Seven occurrences of one series, each its own event. A bar here would
        // be grouping on the words.
        expect(bar.title, 'a daily timed series was drawn as a span').not.toBe('Standup');
      }
      // And they are still on the wall, as rows — zero bars out of zero events
      // would pass the loop above.
      expect(grid.titles.filter((run) => run.text === 'Standup').length).toBeGreaterThan(1);
    },
    SLOW,
  );

  it(
    'lands each bar over exactly the days it covers, in both column layouts',
    async () => {
      /*
       * The trap the week-number column sets: with `.hz-grid.has-weeks` the
       * seven days start at grid column *two*, so a bar placed by line number
       * against the wrong base draws every span one day early — on exactly the
       * walls that asked for week numbers, and nowhere else.
       *
       * Measured by geometry rather than by the placement property: the bar's
       * left edge has to sit inside its first covered cell and its right edge
       * inside its last.
       */
      for (const weekNumbers of [false, true]) {
        const grid = await drawAt(
          WALL,
          undefined,
          { showWeekNumbers: weekNumbers },
          {},
          weekNumbers ? withWeekNumbers : undefined,
        );
        // The column is really there, or the second half of this loop is the
        // first half again under a different name.
        const numbers = grid.texts.filter((run) => run.where.includes('hz-wk'));
        expect(
          numbers.length > 0,
          `showWeekNumbers=${weekNumbers} drew ${numbers.length} week numbers`,
        ).toBe(weekNumbers);
        const bars = grid.spans;
        expect(bars.length, `no bars with showWeekNumbers=${weekNumbers}`).toBeGreaterThan(0);
        for (const bar of bars) {
          const first = grid.cells[bar.cover[0] ?? -1];
          const last = grid.cells[bar.cover[bar.cover.length - 1] ?? -1];
          expect(first, 'a bar covered a cell that is not in the grid').toBeDefined();
          // Same row: a bar may never straddle the week boundary it is broken at.
          expect(last?.top).toBeCloseTo(first?.top ?? -1, 0);
          /*
           * And it is over *those* cells, in pixels.
           *
           * This is the assertion the shape of the problem demands: with the
           * base column wrong the bar is still one row tall, still spans the
           * right *number* of columns, and covers the wrong days — which is
           * invisible to anything that reads back the placement the renderer
           * wrote. Its left edge has to be inside the first covered cell and
           * its right edge inside the last, with a pixel of slack for the
           * rounding of a rem-based inset.
           */
          const where =
            `${bar.title || '(continuation)'} at [${bar.leftPx.toFixed(0)}, ` +
            `${bar.rightPx.toFixed(0)}] over cells ` +
            `[${(first?.left ?? 0).toFixed(0)}, ${(last?.right ?? 0).toFixed(0)}]`;
          expect(bar.leftPx, `bar starts left of its first day (${where})`).toBeGreaterThanOrEqual(
            (first?.left ?? 0) - 1,
          );
          expect(bar.leftPx, `bar starts right of its first day (${where})`).toBeLessThan(
            first?.right ?? 0,
          );
          expect(bar.rightPx, `bar ends right of its last day (${where})`).toBeLessThanOrEqual(
            (last?.right ?? 0) + 1,
          );
          expect(bar.rightPx, `bar ends left of its last day (${where})`).toBeGreaterThan(
            last?.left ?? 0,
          );
        }
      }
    },
    SLOW,
  );

  it(
    'never draws a bar past the bottom of its own week',
    async () => {
      /*
       * A bar is absolutely positioned, so nothing clips it to its row: a lane
       * taller than the cell paints a band across the *next* week's numbers,
       * which is the one failure a month grid must never have. The lane
       * arithmetic is declared in the stylesheet and cannot know the box, so
       * `trimCellRows` measures it and hides a bar that does not fit.
       *
       * **A wall with room proves nothing here.** At full canvas the lane
       * always fits, so the guard never runs and removing it changes nothing —
       * which is exactly the assertion this project keeps finding it has
       * written. The third case is a calendar dragged to a *fifth* of a small
       * wall, where a cell is about 40px and a 26px lane genuinely cannot fit
       * under the numeral. That is where the guard earns its place.
       */
      const cases: readonly {
        readonly size: { readonly width: number; readonly height: number };
        readonly box: { readonly w?: number; readonly h?: number };
      }[] = [
        { size: WALL, box: {} },
        { size: SMALL, box: {} },
        { size: SMALL, box: { w: 0.6, h: 0.34 } },
      ];
      let cramped = 0;
      for (const one of cases) {
        const grid = await drawAt(one.size, undefined, {}, one.box);
        for (const bar of grid.spans) {
          const first = grid.cells[bar.cover[0] ?? -1];
          expect(first, 'a drawn bar covers no cell').toBeDefined();
          expect(
            bar.bottomPx,
            `a bar at ${one.size.width}x${one.size.height} runs ` +
              `${(bar.bottomPx - (first?.bottom ?? 0)).toFixed(1)}px past the bottom of its week`,
          ).toBeLessThanOrEqual((first?.bottom ?? 0) + 1);
        }
        // And the small box really is small enough to have needed the guard:
        // no bar survived it there, which is what makes the case load-bearing.
        if (one.box.h !== undefined && grid.spans.length === 0) cramped += 1;
      }
      expect(
        cramped,
        'the cramped case still had room for its bars, so it proves nothing',
      ).toBe(1);
    },
    SLOW,
  );

  it(
    'sits between the day number and the cell content, not over either',
    async () => {
      /*
       * The one piece of vertical arithmetic on this wall that is computed
       * rather than measured: a bar and the cells beside it have to agree
       * before either is laid out, so the lane top is a `calc()` in the
       * stylesheet. This is what stops it sliding quietly over a row of names
       * when somebody changes the cell's padding or its numeral.
       */
      const grid = await drawAt(WALL);
      const bar = grid.spans[0];
      expect(bar, 'no bar to measure').toBeDefined();
      const numbers = grid.texts.filter((run) => run.where.includes('hz-num'));
      expect(numbers.length).toBeGreaterThan(0);
      // Below every day number in its own row, and above the rows: a bar drawn
      // at the top of the cell would cover the date, which is the one thing a
      // month grid may never lose.
      const rowTop = bar?.topPx ?? 0;
      const sameRow = numbers.filter((run) => Math.abs(run.topPx - rowTop) < 200);
      expect(sameRow.length).toBeGreaterThan(0);
      expect(Math.min(...sameRow.map((run) => run.topPx))).toBeLessThan(rowTop);
    },
    SLOW,
  );
});

describe('rule 2 — an overflow count never costs a name', () => {
  for (const size of [WALL, SMALL]) {
    it(
      `draws no counter in a cell that names nothing, at ${size.width}x${size.height}`,
      async () => {
        /*
         * The failure this replaces: a cell drawing "+3" and none of its three
         * events. Truthful, and a month grid that has stopped saying what is
         * on — a number with no subject. The mark under the numeral is what
         * such a cell draws instead, and the assertion below is on its *width*
         * rather than on its class.
         */
        const grid = await drawAt(size);
        const silent = grid.cells.filter(
          (cell) => cell.total > 0 && cell.shown.length === 0 && cell.spans === 0,
        );
        for (const cell of silent) {
          expect(
            cell.more,
            `day ${cell.day} names nothing and still draws "${cell.more}"`,
          ).toBe('');
          expect(
            cell.markPx,
            `day ${cell.day} names nothing and draws no density mark either`,
          ).toBeGreaterThan(0);
        }
      },
      SLOW,
    );

    it(
      `spends no line on a counter, at ${size.width}x${size.height}`,
      async () => {
        /*
         * The counter rides on the last row it counts for. Measured: its top
         * has to be inside that row rather than under it — a counter on its own
         * line is a line the names wanted.
         *
         * It is allowed a line of its own where sharing would cost that row's
         * title *and* the names have left room underneath, which is the one
         * ordering that never trades a word for a number. That case is
         * measured by its consequence rather than forbidden: no cell may draw
         * a counter while showing fewer names than a cell with the same
         * content and no counter would.
         */
        const grid = await drawAt(size);
        const counting = grid.cells.filter((cell) => cell.more !== '');
        expect(counting.length, 'nothing overflowed at all').toBeGreaterThan(0);
        for (const cell of counting) {
          expect(
            cell.shown.length,
            `day ${cell.day} draws "${cell.more}" and no name`,
          ).toBeGreaterThan(0);
        }
      },
      SLOW,
    );
  }

  it(
    'accounts for every event on a day that draws a name',
    async () => {
      const grid = await drawAt(WALL);
      const speaking = grid.cells.filter((cell) => cell.total > 0 && cell.shown.length > 0);
      expect(speaking.length).toBeGreaterThan(0);
      for (const cell of speaking) {
        // Rows on the glass, plus what the bars over it are drawing, plus what
        // the counter says. A spanned event is *shown* — it is on the wall, in
        // the bar — so a cell counting it as missing would say "+1" for
        // something a household can read.
        expect(
          cell.shown.length + cell.spans + cell.moreCount,
          `day ${cell.day}: ${cell.shown.length} rows + ${cell.spans} spanned + ` +
            `"${cell.more}" != ${cell.total} on that day`,
        ).toBe(cell.total);
      }
    },
    SLOW,
  );
});

describe('rule 3 — a density mark, so the glance costs no type', () => {
  it(
    'draws a longer mark for a busier day',
    async () => {
      /*
       * The encoding *is* the length, so this measures the computed width and
       * never the class. A `.hz-mark` with no width is still a `.hz-mark`, and
       * this project has already shipped the mirror of that bug: a chore tick
       * that drew as an empty outline while a measurement counting
       * `.ch-box-on` passed.
       */
      const grid = await drawAt(WALL);
      const marked = grid.cells.filter((cell) => cell.markPx > 0);
      expect(marked.length, 'no density mark was drawn anywhere').toBeGreaterThan(0);

      const quiet = grid.cells.find((cell) => cell.total === 1);
      const busy = grid.cells.find((cell) => cell.total >= 4);
      expect(quiet, 'no one-event day in the fixture').toBeDefined();
      expect(busy, 'no four-event day in the fixture').toBeDefined();
      expect(
        busy?.markPx ?? 0,
        `a ${busy?.total ?? 0}-event day marks ${busy?.markPx ?? 0}px and a ` +
          `1-event day marks ${quiet?.markPx ?? 0}px`,
      ).toBeGreaterThan((quiet?.markPx ?? 0) + 1);
    },
    SLOW,
  );

  it(
    'draws nothing at all on an empty day',
    async () => {
      // An empty day is the information. A mark of no length is still a mark,
      // and a household would read one as something on.
      const grid = await drawAt(WALL);
      const empty = grid.cells.filter((cell) => cell.total === 0);
      expect(empty.length, 'every day in the fixture is busy').toBeGreaterThan(0);
      for (const cell of empty) {
        expect(cell.markPx, `day ${cell.day} is empty and draws a mark`).toBe(0);
        expect(cell.more, `day ${cell.day} is empty and draws "${cell.more}"`).toBe('');
        expect(cell.shown, `day ${cell.day} is empty and draws a row`).toHaveLength(0);
      }
    },
    SLOW,
  );

  it(
    'leaves the stored `dots` look exactly as it was',
    async () => {
      // `dots` is a look a household can have stored, and the mark replaces the
      // *default* treatment's quiet layer rather than that choice.
      const grid = await drawAt(WALL, 'dots');
      expect(grid.cells.every((cell) => cell.markPx === 0)).toBe(true);
      expect(grid.spans).toHaveLength(0);
      expect(grid.titles).toHaveLength(0);
    },
    SLOW,
  );
});
