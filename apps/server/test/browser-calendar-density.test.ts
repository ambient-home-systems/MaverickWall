/**
 * Three views and a density, measured on a wall and driven through the editor.
 *
 * The Calendar offered five views — `month`, `week`, `list`, `skyweek`,
 * `skymonth` — and two of them were not views at all. `skymonth` drew the same
 * month grid `month` does and `skyweek` the same week columns, edge to edge with
 * hairline rules instead of gaps and cards. That is a choice about how much room
 * the calendar spends on itself, and dressing it as a view put "Month grid" and
 * "Sky month" side by side in one list with nothing on screen saying which one
 * draws more and which one draws bigger.
 *
 * There is a real trade under those names and this file is where it is written
 * down as numbers rather than as an adjective. Measured here on a 1080x1920
 * portrait wall with three ordinary family calendars, a calendar filling the
 * canvas:
 *
 * | view              | words on the glass | smallest | median |
 * |-------------------|--------------------|----------|--------|
 * | Month comfortable | 23                 | 22.1px   | 22.1px |
 * | Month compact     | 25                 | 18.2px   | 19.2px |
 * | Week comfortable  | 11                 | 22.1px   | 22.1px |
 * | Week compact      | 14                 | 18.2px   | 18.2px |
 *
 * So compact buys events and pays in type, and it pays *below this project's
 * own 22px floor* (`--t-floor`, the size a wall is still readable at from five
 * to ten feet). That is worth offering and it is not worth hiding, which is the
 * whole of the change: one axis for what you see, one for how much of it.
 *
 * Everything below is read off computed geometry and the text actually on the
 * glass — never off a class name. This project has shipped a month cell that
 * said "+6" and drew none of its six events with every structural check
 * passing, and a tick box whose class was right while the pixels were wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  browser,
  install,
  measureWall,
  settleWall,
  shutDownBrowser,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';

/*
 * The container a household installs on: `docker run` with no `TZ` resolves to
 * UTC, and the wizard is told Europe/London.
 */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser, an admin session and several walls. */
const SLOW = 300_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

/** The wall this is all measured on: the design target and the kitchen tablet. */
const PORTRAIT = { width: 1080, height: 1920 } as const;

/**
 * Three feeds, because one is not a household.
 *
 * The question a density control answers is what a *busy* month looks like in a
 * fixed box, and a single ten-event calendar cannot pose it. Three ordinary
 * family calendars with a couple of dozen events between them is the case the
 * table above was measured on.
 */
const CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      { title: 'Bin day', day: 0 },
      { title: 'Sports day', day: 1, from: '0930', to: '1500' },
      { title: 'Dentist', day: 2, from: '0900', to: '1000' },
      { title: 'Vet', day: 3, from: '1100', to: '1130' },
      { title: 'Book club', day: 6, from: '1930', to: '2130' },
      { title: 'Piano', day: 9, from: '1600', to: '1700' },
      { title: 'Car service', day: 11, from: '0800', to: '1200' },
      { title: 'Swimming lesson', day: 15, from: '0730', to: '0830' },
      { title: 'Grandma’s birthday', day: 20 },
    ],
  },
  {
    name: 'School',
    events: [
      { title: 'INSET day - school closed', day: 4 },
      { title: 'Cake sale', day: 6, from: '1500', to: '1600' },
      { title: 'School trip to the aquarium', day: 8, from: '0830', to: '1600' },
      { title: 'Parents evening', day: 13, from: '1800', to: '2000' },
      { title: 'Term ends', day: 22 },
    ],
  },
  {
    name: 'Work',
    events: [
      { title: 'Team retro', day: 2, from: '1400', to: '1500' },
      { title: 'Client call', day: 5, from: '1000', to: '1100' },
      { title: 'One to one', day: 9, from: '0900', to: '0930' },
      { title: 'Planning', day: 16, from: '1300', to: '1400' },
    ],
  },
];

let wall: Installation;
let link: string;
let screenId: string;
let page: Page;

beforeAll(async () => {
  wall = await install({ calendars: [...CALENDARS] });
  link = await wall.pairLink();
  /*
   * The screen's own canvas, not the household's. A screen is seeded with one
   * of its own when it is created, so writing the household's would be
   * overridden and every measurement here would silently be of Classic.
   */
  screenId = (wall.db.prepare('SELECT id FROM screens').get() as { id: string }).id;
  /*
   * One browser context for the whole file, re-navigated per canvas.
   *
   * Not thrift: the month grid trims its cells *once*, at first draw, against
   * whatever font metrics have arrived — `CLAUDE.md` records the same wall
   * naming 2 or 6 or 13 of its cells depending on whether the fonts beat the
   * render. A fresh context per draw re-runs that race and makes the
   * comfortable grid differ from itself between two identical runs, which was
   * measured before this file was written. One context loads the fonts once.
   */
  const context = await (await browser()).newContext({ viewport: PORTRAIT });
  page = await context.newPage();
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
});

/** Put one calendar widget on the screen's canvas, filling it, with this config. */
function canvasOf(config: Record<string, unknown>): void {
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

interface Drawn {
  /**
   * The drawn calendar as one comparable string — **pixels, not markup**.
   *
   * Every element in the widget, in document order, as its depth, its rounded
   * box, the type it is set in, its two colours and its own words. Deliberately
   * *not* the class names: a renderer can apply the right class and draw the
   * wrong thing, which is a bug this project has shipped, and two identical
   * signatures here mean two identical walls rather than two identical DOMs.
   */
  readonly pixels: string;
  /** Every word on the glass, at the size it is actually drawn (transforms out). */
  readonly words: readonly { readonly text: string; readonly px: number }[];
}

async function draw(config: Record<string, unknown>): Promise<Drawn> {
  canvasOf(config);
  await page.goto(link, { waitUntil: 'load' });
  await settleWall(page);

  const pixels = await page.evaluate(() => {
    // The one calendar box on the canvas. A missing root would make every
    // comparison below hold two identical sentinels to each other and pass,
    // so it is reported rather than defaulted.
    const root = document.querySelector('#wall .canvas .fw-calendar');
    if (root === null) return '';
    const rows: unknown[] = [];
    const walk = (node: Element, depth: number): void => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const own = [...node.childNodes]
        .filter((child) => child.nodeType === 3)
        .map((child) => (child.textContent ?? '').trim())
        .join(' ');
      rows.push([
        depth,
        Math.round(box.x * 10),
        Math.round(box.y * 10),
        Math.round(box.width * 10),
        Math.round(box.height * 10),
        style.fontSize,
        style.color,
        style.backgroundColor,
        own,
      ]);
      for (const child of [...node.children]) walk(child, depth + 1);
    };
    walk(root, 0);
    return JSON.stringify(rows);
  });

  if (pixels === '') {
    throw new Error('no calendar box on the canvas — the wall did not draw the widget under test');
  }

  const measured = await measureWall(page);
  return {
    pixels,
    words: measured.runs
      // The words, not the furniture: a bare number is a date or a counter and
      // says nothing about whether the calendar can be read.
      .filter((run) => run.text.trim().length > 2 && !/^\d+$/.test(run.text.trim()))
      .map((run) => ({ text: run.text.trim(), px: run.effectivePx })),
  };
}

const smallest = (drawn: Drawn): number =>
  drawn.words.reduce((least, word) => Math.min(least, word.px), Infinity);

const report = (name: string, drawn: Drawn): string =>
  `${name}: ${drawn.words.length} words, smallest ${smallest(drawn).toFixed(1)}px`;

describe('a calendar written before the split', () => {
  it(
    'draws exactly what the (view, density) pair it became draws',
    async () => {
      /*
       * The compatibility promise, and it is a promise about somebody's
       * kitchen. A wall hung before the split stores `skymonth`, and nothing
       * rewrites it — no migration touches a stored canvas, because that is a
       * change to somebody's arrangement made while they were not looking. The
       * old value is mapped at the *read* boundary instead, so it has to land
       * on the identical frame, pixel for pixel.
       *
       * Equality is the assertion, not "it still draws something": a renderer
       * that quietly dropped `skyweek` into the month grid would satisfy the
       * weaker claim, and that is the 0.33.2 bug exactly.
       */
      const legacyMonth = await draw({ mode: 'skymonth' });
      const pairMonth = await draw({ mode: 'month', density: 'compact' });
      expect(pairMonth.pixels, 'month + compact is not what skymonth draws').toBe(legacyMonth.pixels);

      const legacyWeek = await draw({ mode: 'skyweek' });
      const pairWeek = await draw({ mode: 'week', density: 'compact' });
      expect(pairWeek.pixels, 'week + compact is not what skyweek draws').toBe(legacyWeek.pixels);

      // And a legacy week is still a *week*. Equality against its own pair
      // would pass just as happily if both had fallen through to the month.
      expect(legacyWeek.pixels).not.toBe(legacyMonth.pixels);

      /*
       * A density stored beside a legacy value is a contradiction — the old
       * spelling already carries one — and the old value answers both halves.
       * The editor cannot write this; a hand-edited config can.
       */
      const contradicted = await draw({ mode: 'skymonth', density: 'comfortable' });
      expect(contradicted.pixels, 'a legacy value gave up half of itself').toBe(legacyMonth.pixels);
    },
    SLOW,
  );
});

describe('the density control, measured', () => {
  it(
    'buys events and pays in type, on both grids',
    async () => {
      /*
       * What a household is actually choosing between. Compact was reachable
       * before under a name that said none of this ("Sky month"), which is why
       * the numbers are asserted rather than described: an option whose two
       * settings drew the same thing would be worse than one not offered, and
       * this project has shipped that bug under three different names.
       */
      const month = await draw({});
      const monthCompact = await draw({ density: 'compact' });
      const week = await draw({ mode: 'week' });
      const weekCompact = await draw({ mode: 'week', density: 'compact' });

      for (const [name, roomy, dense] of [
        ['month', month, monthCompact],
        ['week', week, weekCompact],
      ] as const) {
        expect(dense.pixels, `the ${name} draws the same at both densities`).not.toBe(roomy.pixels);

        // More on the glass — the whole reason to spend the padding.
        expect(
          dense.words.length,
          `compact shows no more than comfortable on the ${name}: ` +
            `${report('comfortable', roomy)}; ${report('compact', dense)}`,
        ).toBeGreaterThan(roomy.words.length);

        // …and smaller, which is the cost and the thing the old naming hid.
        expect(
          smallest(dense),
          `compact does not draw the ${name} smaller: ${report('compact', dense)}`,
        ).toBeLessThan(smallest(roomy));
      }

      /*
       * The floor is where the trade becomes a decision rather than a
       * preference. 22px is what this wall is readable at from five to ten
       * feet; comfortable clears it and compact does not, measured, at the
       * design's own size. If comfortable ever slips under it that is a bug in
       * the *default* and this is where it should fail.
       */
      for (const [name, roomy] of [['month', month], ['week', week]] as const) {
        expect(
          smallest(roomy),
          `the comfortable ${name} is drawn below the ${FLOOR_PX}px floor: ${report(name, roomy)}`,
        ).toBeGreaterThanOrEqual(FLOOR_PX);
      }
      for (const [name, dense] of [['month', monthCompact], ['week', weekCompact]] as const) {
        expect(
          smallest(dense),
          `the compact ${name} no longer trades type for room, so the control is ` +
            `a restyling: ${report(name, dense)}`,
        ).toBeLessThan(FLOOR_PX);
      }
    },
    SLOW,
  );

  it(
    'draws five different walls for the five things a household can pick',
    async () => {
      /*
       * Three views, two densities, and no density on the agenda — which is not
       * a gap: there is one agenda and offering a control that redraws it
       * identically is worse than not offering one. So five reachable
       * combinations, and every one of them has to be a different wall.
       *
       * Pairwise, because "each differs from the default" would pass with two
       * of them identical to each other.
       */
      const seen = new Map<string, string>();
      for (const [name, config] of [
        ['Month comfortable', {}],
        ['Month compact', { density: 'compact' }],
        ['Week comfortable', { mode: 'week' }],
        ['Week compact', { mode: 'week', density: 'compact' }],
        ['Agenda', { mode: 'list' }],
      ] as const) {
        const drawn = await draw(config as Record<string, unknown>);
        const clash = [...seen.entries()].find(([, pixels]) => pixels === drawn.pixels);
        expect(clash?.[0], `${name} draws exactly what ${clash?.[0] ?? ''} draws`).toBeUndefined();
        seen.set(name, drawn.pixels);
      }
      expect(seen.size).toBe(5);
    },
    SLOW,
  );
});

/* ------------------------------------------------- driving the inspector ---- */

/**
 * What the household actually turns, and what it writes.
 *
 * The measurements above prove five different walls exist. This proves a
 * household can reach all five from the inspector, and that reaching them
 * writes the config those walls were measured from — which is the join nothing
 * else here checks. `CLAUDE.md` records the shape of the bug on the other side
 * of it more than once: a control that is drawn, is clicked, and does nothing.
 */

/** The screen's canvas, holding one calendar the editor can select. */
function seedOneCalendar(config: Record<string, unknown>): void {
  canvasOf(config);
}

/** The stored config of the portrait canvas's only widget. */
function storedConfig(): unknown {
  const row = wall.db
    .prepare("SELECT config FROM layout_widgets WHERE screen_id = ? AND orientation = 'portrait'")
    .get(screenId) as { config: string | null } | undefined;
  return row?.config === null || row?.config === undefined ? undefined : JSON.parse(row.config);
}

const VIEW_SELECT = '.le-cfg-field[data-cfg-key="mode"] select';
const DENSITY_SEG = '.le-cfg-field[data-cfg-key="density"] .seg button';

async function openInspector(editor: Page): Promise<void> {
  await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
  await editor.click('.le-orient-btn:has-text("Portrait")');
  await editor.waitForTimeout(250);
  await editor.locator('.le-overlay .le-widget').first().click();
  await editor.waitForSelector(VIEW_SELECT, { timeout: 20_000 });
}

describe('the inspector', () => {
  it(
    'offers three views and a density, writes both, and stores each default as an absence',
    async () => {
      seedOneCalendar({});
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await wall.signIn(editor);
        await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
        await openInspector(editor);

        // Three views, named as a household reads them — and not five.
        expect(
          await editor.locator(`${VIEW_SELECT} option`).allTextContents(),
        ).toEqual(['Month grid', 'Week columns', 'Upcoming list']);

        expect(
          await editor.locator(DENSITY_SEG).allTextContents(),
          'the density control is not two choices',
        ).toEqual(['Comfortable', 'Compact']);

        /*
         * Every combination, turned and then read out of the database.
         *
         * The stored shape is the assertion, not "the preview changed": both
         * defaults are stored as an **absence**, which is this codebase's
         * convention and the thing the panel's own reader got wrong once. A
         * `mode: 'month'` written out in full would still draw correctly today
         * and would quietly break the next reader that tests for absence.
         *
         * Each case starts from a *fresh* widget, so what comes out is the pair
         * and nothing else. Settings do carry across a view change — that is
         * deliberate and pinned below — and starting each case where the last
         * one finished would make this assert the carry-over instead.
         */
        for (const [seed, view, density, expected] of [
          /*
           * Each case is seeded from a state the target is *different* from,
           * because Save is off until something changes: setting a control to
           * the value it already holds leaves the canvas clean and the button
           * disabled, which is correct behaviour and would otherwise look like
           * a control that did nothing.
           */
          [{ mode: 'week', density: 'compact' }, 'month', 'Comfortable', undefined],
          [{}, 'month', 'Compact', { density: 'compact' }],
          [{}, 'week', undefined, { mode: 'week' }],
          [{}, 'week', 'Compact', { mode: 'week', density: 'compact' }],
          [{}, 'list', undefined, { mode: 'list' }],
        ] as const) {
          seedOneCalendar({ ...seed });
          await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
          await openInspector(editor);

          await editor.selectOption(VIEW_SELECT, view);
          await editor.waitForTimeout(200);
          if (density !== undefined) {
            await editor.click(`.le-cfg-field[data-cfg-key="density"] .seg button:has-text("${density}")`);
            await editor.waitForTimeout(200);
          }
          expect(
            await editor.locator('[data-action="save"]').isEnabled(),
            `${view} + ${density ?? 'no density control'} left the canvas clean, ` +
              'so the control wrote nothing',
          ).toBe(true);
          await Promise.all([
            editor.waitForNavigation({ timeout: 20_000 }),
            editor.click('[data-action="save"]'),
          ]);
          expect(
            storedConfig(),
            `${view} + ${density ?? 'no density control'} stored something else`,
          ).toEqual(expected);
        }

        /*
         * A density survives a trip through the agenda, the way `cellEvents`
         * already survives a trip through the week.
         *
         * It is inert while the agenda is drawing — nothing reads it — and it
         * is what the household last chose, so bringing it back when they
         * return to a grid is remembering rather than surprising them. Clearing
         * it would silently drop a choice they made; pinned here because the
         * opposite is just as arguable and should not be changed by accident.
         */
        seedOneCalendar({ mode: 'week', density: 'compact' });
        await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
        await openInspector(editor);
        await editor.selectOption(VIEW_SELECT, 'list');
        await editor.waitForTimeout(200);
        await Promise.all([
          editor.waitForNavigation({ timeout: 20_000 }),
          editor.click('[data-action="save"]'),
        ]);
        expect(storedConfig()).toEqual({ mode: 'list', density: 'compact' });
        await openInspector(editor);
        await editor.selectOption(VIEW_SELECT, 'month');
        await editor.waitForTimeout(250);
        expect(
          await editor.locator('.le-cfg-field[data-cfg-key="density"] .seg button.on').textContent(),
          'coming back to a grid forgot the density the household had chosen',
        ).toBe('Compact');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'offers nothing that would do nothing, and opens a legacy widget on the pair it means',
    async () => {
      /*
       * Two halves of one rule. The agenda has a single density, so offering
       * the control there would be two settings drawing one wall — worse than
       * not offering it. And neither dense grid reads `cellEvents` or draws a
       * week number, so those go with it. The week-number switch is a fault
       * this split *found* rather than caused: its guard was `mode !== 'list'`,
       * and `skymonth` is not `list`, so it has been offered and ignored on the
       * dense month since that view shipped.
       */
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await wall.signIn(editor);

        /*
         * A canvas written before the split opens on the pair it means, and
         * **`skyweek` is the value that proves it**.
         *
         * `skymonth` cannot: it resolves to Month, which is also the first
         * option, which is what a browser preselects when *nothing* matches. A
         * picker reading the raw `mode` would find no `skymonth` option, fall
         * back to the first, and pass an assertion for "Month". That was
         * measured — the check below was written with `skymonth`, the fix was
         * removed, and it stayed green. `skyweek` resolves to Week, so reading
         * the raw value lands on Month and the assertion fails, which is the
         * point of having one.
         */
        seedOneCalendar({ mode: 'skyweek' });
        await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
        await openInspector(editor);
        expect(
          await editor.locator(VIEW_SELECT).inputValue(),
          'a legacy widget opened on a view it does not draw',
        ).toBe('week');
        expect(
          await editor.locator('.le-cfg-field[data-cfg-key="density"] .seg button.on').textContent(),
          'a legacy widget opened on the wrong density',
        ).toBe('Compact');

        /*
         * Neither week renderer paints a rota — no `paintShift`, no
         * `shiftToken`, nothing that could — so "Show work schedules" has done
         * nothing on a week since the view shipped. It is not offered there.
         */
        expect(
          await editor.locator('.switch:has-text("Show work schedules")').count(),
          'the week columns were offered a rota colour they do not draw',
        ).toBe(0);

        seedOneCalendar({ mode: 'skymonth' });
        await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
        await openInspector(editor);
        expect(await editor.locator(VIEW_SELECT).inputValue()).toBe('month');
        expect(
          await editor.locator('.le-cfg-field[data-cfg-key="density"] .seg button.on').textContent(),
        ).toBe('Compact');

        // Compact reads neither, so neither is offered.
        expect(await editor.locator('.le-cfg-field[data-cfg-key="cellEvents"]').count()).toBe(0);
        expect(await editor.locator('.switch:has-text("Show week numbers")').count()).toBe(0);
        /*
         * The rota *is* drawn on both months and on the agenda, so it stays
         * offered there. Asserted alongside the absence above, because a gate
         * that hid it everywhere would satisfy "not on the week" and quietly
         * remove a working control from the two views that honour it.
         */
        expect(await editor.locator('.switch:has-text("Show work schedules")').count()).toBe(1);

        // Comfortable reads both, so both come back.
        await editor.click('.le-cfg-field[data-cfg-key="density"] .seg button:has-text("Comfortable")');
        await editor.waitForTimeout(250);
        expect(await editor.locator('.le-cfg-field[data-cfg-key="cellEvents"]').count()).toBe(1);
        expect(await editor.locator('.switch:has-text("Show week numbers")').count()).toBe(1);

        // The agenda has one density and no cells, so it offers neither.
        await editor.selectOption(VIEW_SELECT, 'list');
        await editor.waitForTimeout(250);
        expect(
          await editor.locator('.le-cfg-field[data-cfg-key="density"]').count(),
          'the agenda offers a density it cannot draw',
        ).toBe(0);
        expect(await editor.locator('.le-cfg-field[data-cfg-key="cellEvents"]').count()).toBe(0);
        // The agenda draws a rota rule down each row, so it keeps the switch.
        expect(await editor.locator('.switch:has-text("Show work schedules")').count()).toBe(1);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

describe('the ink lane', () => {
  it(
    'still offers what a panel reads when the wall it follows is compact',
    async () => {
      /*
       * A panel has no density and the editor must not pretend it has.
       *
       * `PANEL_IGNORES` names density: compact buys its room from gaps and
       * cards, and a 1-bit panel is already edge to edge with none to give up.
       * So a panel following a compact wall draws the month grid at its one
       * density — and it *does* read `cellEvents` there, which `INK_LANE`
       * offers. Gating the lane's controls on the wall's density would hide a
       * control the renderer honours, which is the "option that does nothing"
       * rule pointing the other way, and nothing in `epaper-ink.test.ts` can
       * see it: that file checks the tables against the renderer, never the
       * editor against the tables.
       *
       * The wall here is the household default, because that is what a panel
       * can be told to follow.
       */
      await wall.post('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
      const panel = wall.db
        .prepare("select id from screens where kind = 'epaper' limit 1")
        .get() as { id: string } | undefined;
      expect(panel?.id, 'no e-paper panel was created, so the lane cannot be tested').toBeTruthy();
      await wall.post(`/admin/epaper/${panel?.id ?? ''}/source`, { source: 'follow:default' });

      // A compact month on the *default* wall's landscape canvas — the one the
      // panel above draws, since the lane picks its panel by orientation.
      replaceLayout(wall.db, null, 'landscape', {
        mode: 'freeform',
        aspect: 1.7778,
        widgets: [
          {
            id: 'cal-landscape-default',
            type: 'calendar',
            x: 0.02,
            y: 0.02,
            w: 0.96,
            h: 0.96,
            z: 0,
            config: { density: 'compact' },
          },
        ],
        background: null,
      });

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await wall.signIn(editor);
        await editor.goto(`${wall.base}/admin/walls/default`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.click('.le-orient-btn:has-text("Landscape")');
        await editor.waitForTimeout(250);
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.waitForSelector(VIEW_SELECT, { timeout: 20_000 });

        // The wall lane hides it, because the wall really is drawing compact.
        expect(
          await editor.locator('.le-cfg-field[data-cfg-key="cellEvents"]').count(),
          'the compact wall was offered a cell treatment it does not read',
        ).toBe(0);

        await editor.click('.insp-lane:has-text("On ink")');
        await editor.waitForTimeout(300);
        expect(
          await editor.locator('.le-cfg-field[data-cfg-key="cellEvents"]').count(),
          'the ink lane hid a control the panel honours, because the wall is compact',
        ).toBe(1);
        // And the lane offers no density, which the panel could not draw.
        expect(await editor.locator('.le-cfg-field[data-cfg-key="density"]').count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
