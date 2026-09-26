/**
 * The calendar's looks, its month filter and the agenda's locations (plan item
 * P5.4, parts 4–6), measured on the shipped Classic wall at 1080x1920 and
 * 1920x1080: a real paired screen, the household's three calendars plus a
 * fourth whose events say where they are, a forecast and a rota.
 *
 * Every assertion reads a computed value — an outline, a colour, a font, a
 * rectangle, the words on the glass — never a class name; this project has
 * shipped a control whose class was right and whose pixels were wrong.
 *
 * The constraint that decides whether this ships is CLAUDE.md's: **nothing
 * that annotates an event costs it a row.** So every look is drawn beside the
 * treatment's own on the same wall and held to it:
 *
 *   - today's three marks, the week rules and the two calendar looks leave
 *     every month cell and every numeral line where it was, to half a pixel,
 *     and name exactly the same events with the same "+N" counts;
 *   - the bar and coloured text give the words width rather than take it, so
 *     every event the dot named is still named;
 *   - a location is drawn only where it leaves its entry's height unchanged,
 *     so every agenda entry keeps its rectangle.
 *
 * The heading is the one look that spends room, and it spends it on words
 * rather than on a mark; what it costs is written down here per size rather
 * than asserted away, and hiding the Swiss heading is held to *give* room.
 *
 * `wall-density` and `browser-classic-proportions` — the ratchets, on a wall
 * with every key absent — were compared as text against a clean worktree of
 * `main` and are unmoved; this file cannot see that and CLAUDE.md records it.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  HOUSEHOLD_CALENDARS,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  measureMonthGrid,
  shutDownBrowser,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { applyTemplate } from '../src/api/templates.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { classicFor } from '../src/templates/classic.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

const SIZES = [
  { width: 1080, height: 1920 },
  { width: 1920, height: 1080 },
] as const;

/**
 * A fourth calendar whose events carry a place. One place is short enough to
 * sit on its title's line on either wall; the other is a paragraph, which can
 * only ever start a line of its own and so must never be drawn.
 */
const CLUBS: NamedFeed = {
  name: 'Clubs',
  events: [
    { title: 'Choir', day: 0, from: '1800', to: '1900', location: 'Hall' },
    {
      title: 'Allotment committee meeting',
      day: 0,
      from: '2000',
      to: '2100',
      location:
        'The pavilion behind the allotments on Upper Road, past the second gate and round by the water butts',
    },
  ],
};

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: [...HOUSEHOLD_CALENDARS, CLUBS] });
  equipHousehold(wall.db, wall.now());
  link = await wall.pairLink('Kitchen');
  screenId = (wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }).id;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * Classic's seed, re-applied, with `month` laid over its month widget's config
 * and `list` over its agenda's, on both canvases. A key set to `undefined` is
 * removed, which is how the editor stores a default.
 */
function configure(month: Record<string, unknown>, list: Record<string, unknown> = {}): void {
  applyTemplate(wall.db, screenId, classicFor({ modules: ['weather'], shift: true, todoLists: [] }));
  const row = wall.db
    .prepare(
      `SELECT layout_aspect AS portrait, layout_landscape_aspect AS landscape,
              layout_background AS portraitBg, layout_landscape_background AS landscapeBg
         FROM screens WHERE id = ?`,
    )
    .get(screenId) as { portrait: number; landscape: number; portraitBg: string | null; landscapeBg: string | null };
  for (const orientation of ['portrait', 'landscape'] as const) {
    const widgets = readLayoutWidgets(wall.db, screenId, orientation).map((widget) => {
      const config = { ...((widget.config as Record<string, unknown> | undefined) ?? {}) };
      const patch = widget.type !== 'calendar' ? {} : config['mode'] === 'month' ? month : config['mode'] === 'list' ? list : {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete config[key];
        else config[key] = value;
      }
      return {
        id: widget.id, type: widget.type, x: widget.x, y: widget.y, w: widget.w, h: widget.h, z: widget.z, config,
        ...(widget.parentId !== undefined && widget.parentId !== null ? { parentId: widget.parentId } : {}),
      };
    });
    replaceLayout(wall.db, screenId, orientation, {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? row.landscape : row.portrait,
      widgets,
      background: orientation === 'landscape' ? row.landscapeBg : row.portraitBg,
    });
  }
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Looked {
  /** Every month cell's rectangle and its numeral line's, in grid order. */
  readonly cells: readonly Rect[];
  readonly lines: readonly Rect[];
  readonly today: {
    readonly outlineStyle: string;
    readonly outlineWidth: number;
    readonly outlineOffset: number;
    readonly numeralColour: string;
    readonly numeralBackground: string;
    readonly numeralFamily: string;
    readonly numeralWeight: string;
  };
  /** Any other day's numeral, for the looks that dress every numeral. */
  readonly numeral: { readonly family: string; readonly weight: string; readonly colour: string };
  readonly heading: { readonly text: string; readonly fontPx: number; readonly bottom: number } | undefined;
  readonly gridTop: number;
  /** Timed rows: the mark's drawn width and display, the words' colour and left edge. */
  readonly rows: readonly {
    /** Which cell, in grid order, and the words — together, since "Bin day" is on two. */
    readonly at: string;
    readonly text: string;
    readonly dotDisplay: string;
    readonly dotWidth: number;
    readonly dotColour: string;
    readonly textColour: string;
    readonly textLeft: number;
    readonly textRight: number;
  }[];
  /** The flat-text month's week rules. */
  readonly rules: readonly (Rect & { readonly colour: string })[];
  /** The Swiss month's cell tops, colour and width, for the cells no rota marks. */
  readonly cellTops: readonly { readonly colour: string; readonly width: number; readonly rota: boolean }[];
  /** The month widget's box ground, and the tokens it resolved. */
  readonly box: { readonly background: string; readonly bg: string; readonly panel: string; readonly ink: string; readonly ruleWeek: string; readonly scaffold: string };
  /** Which calendars' colours the grid draws, by computed colour. */
  readonly rowColours: readonly string[];
  readonly spanColours: readonly string[];
  /** The agenda: every entry's rect, and every place and whether it is drawn. */
  readonly agenda: {
    readonly entries: readonly Rect[];
    readonly places: readonly { readonly text: string; readonly shown: boolean; readonly colour: string; readonly fontPx: number }[];
  };
}

interface Drawn {
  readonly look: Looked;
  readonly names: readonly string[];
  readonly plusN: number;
  readonly truncated: number;
}

async function readLooks(page: Page): Promise<Looked> {
  return page.evaluate(() => {
    const rect = (el: Element): { left: number; top: number; width: number; height: number } => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const horizon = document.querySelector('#wall .horizon') as HTMLElement;
    const grid = horizon.querySelector('.hz-grid') as HTMLElement;
    const cells = [...grid.querySelectorAll('.hz-cell')] as HTMLElement[];
    const today = cells.find((cell) => cell.classList.contains('is-today'))!;
    const todayNum = today.querySelector('.hz-num') as HTMLElement;
    const other = cells.find((cell) => !cell.classList.contains('is-today') && !cell.classList.contains('dim') && !cell.classList.contains('outside'))!;
    const otherNum = getComputedStyle(other.querySelector('.hz-num')!);
    const todayStyle = getComputedStyle(today);
    const todayNumStyle = getComputedStyle(todayNum);
    const heading = horizon.querySelector('.hz-title') as HTMLElement | null;
    const box = horizon.closest('.fw') as HTMLElement;
    const boxStyle = getComputedStyle(box);
    const token = (name: string): string => getComputedStyle(grid).getPropertyValue(name).trim();
    const rows = ([...grid.querySelectorAll('.hz-row:not(.allday)')] as HTMLElement[])
      .filter((row) => row.offsetParent !== null && getComputedStyle(row).display !== 'none')
      .map((row) => {
        const dot = row.querySelector('.hz-rowdot') as HTMLElement;
        const text = row.querySelector('.hz-rowtext') as HTMLElement;
        return {
          at: `${cells.indexOf(row.closest('.hz-cell') as HTMLElement)}:${text.textContent ?? ''}`,
          text: text.textContent ?? '',
          dotDisplay: getComputedStyle(dot).display,
          dotWidth: dot.getBoundingClientRect().width,
          dotColour: getComputedStyle(dot).backgroundColor,
          textColour: getComputedStyle(text).color,
          textLeft: text.getBoundingClientRect().left,
          textRight: text.getBoundingClientRect().right,
        };
      });
    const visible = (el: Element): boolean => getComputedStyle(el).display !== 'none' && (el as HTMLElement).offsetParent !== null;
    const agenda = document.querySelector('#wall .next') as HTMLElement | null;
    return {
      cells: cells.map(rect),
      lines: cells.map((cell) => rect(cell.querySelector('.hz-top')!)),
      today: {
        outlineStyle: todayStyle.outlineStyle,
        outlineWidth: parseFloat(todayStyle.outlineWidth),
        outlineOffset: parseFloat(todayStyle.outlineOffset),
        numeralColour: todayNumStyle.color,
        numeralBackground: todayNumStyle.backgroundColor,
        numeralFamily: todayNumStyle.fontFamily,
        numeralWeight: todayNumStyle.fontWeight,
      },
      numeral: { family: otherNum.fontFamily, weight: otherNum.fontWeight, colour: otherNum.color },
      heading:
        heading === null
          ? undefined
          : { text: heading.textContent ?? '', fontPx: parseFloat(getComputedStyle(heading).fontSize), bottom: heading.getBoundingClientRect().bottom },
      gridTop: grid.getBoundingClientRect().top,
      rows,
      rules: ([...grid.querySelectorAll('.hz-weekrule')] as HTMLElement[]).map((rule) => ({
        ...rect(rule),
        colour: getComputedStyle(rule).backgroundColor,
      })),
      cellTops: cells.map((cell) => ({
        colour: getComputedStyle(cell).borderTopColor,
        width: parseFloat(getComputedStyle(cell).borderTopWidth),
        rota: cell.classList.contains('has-shift') || cell.classList.contains('has-shift-edge') || cell.classList.contains('has-rule'),
      })),
      box: {
        background: boxStyle.backgroundColor,
        bg: token('--bg'),
        panel: token('--panel'),
        ink: token('--ink'),
        ruleWeek: token('--rule-week'),
        scaffold: token('--ink-scaffold'),
      },
      rowColours: [...new Set(rows.map((row) => row.dotColour))].sort(),
      spanColours: [
        ...new Set(
          ([...grid.querySelectorAll('.hz-span')] as HTMLElement[])
            .filter(visible)
            .map((bar) => getComputedStyle(bar).backgroundColor),
        ),
      ].sort(),
      agenda: {
        entries: agenda === null ? [] : ([...agenda.querySelectorAll('.dr-ev')] as HTMLElement[]).filter(visible).map(rect),
        places:
          agenda === null
            ? []
            : ([...agenda.querySelectorAll('.dr-ev-loc')] as HTMLElement[]).map((place) => ({
                text: place.textContent ?? '',
                shown: getComputedStyle(place).display !== 'none',
                colour: getComputedStyle(place).color,
                fontPx: parseFloat(getComputedStyle(place).fontSize),
              })),
      },
    };
  });
}

async function drawn(
  size: { readonly width: number; readonly height: number },
  month: Record<string, unknown>,
  list: Record<string, unknown> = {},
): Promise<Drawn> {
  configure(month, list);
  const { page, close } = await loadWallSettled(link, size);
  try {
    const [look, grid] = await Promise.all([readLooks(page), measureMonthGrid(page)]);
    const out: Drawn = {
      look,
      names: [
        ...grid.titles.map((title) => title.text),
        ...grid.spans.filter((bar) => bar.labelled).map((bar) => bar.title),
      ].sort(),
      plusN: grid.cells.filter((cell) => cell.more !== '').length,
      truncated: grid.titles.filter((title) => title.truncated).length,
    };
    if (process.env['LOOKS_DUMP'] !== undefined) {
      appendFileSync(process.env['LOOKS_DUMP'], JSON.stringify({ size, month, list, names: out.names.length, plusN: out.plusN, heading: look.heading }) + '\n');
    }
    return out;
  } finally {
    await close();
  }
}

/** CSS `rgb(…)` from a hex token, the way a computed colour reads. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  // eslint-disable-next-line no-bitwise
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function parseRgb(value: string): [number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (m === null) {
    const n = Number.parseInt(value.replace('#', ''), 16);
    // eslint-disable-next-line no-bitwise
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const [r, g, b] = m[1]!.split(',').map((p) => Number.parseFloat(p)) as [number, number, number];
  return [r, g, b];
}

function contrast(a: string, b: string): number {
  const lum = (value: string): number => {
    const lin = parseRgb(value).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Two lists of rectangles, the same to half a pixel. */
function sameRects(a: readonly Rect[], b: readonly Rect[], what: string): void {
  expect(a.length, `${what}: a different number`).toBe(b.length);
  a.forEach((one, index) => {
    const other = b[index]!;
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      expect(Math.abs(one[key] - other[key]), `${what} ${index} moved on ${key}`).toBeLessThan(0.5);
    }
  });
}

/** Every name the first drew, the second draws too — as many times. */
function keepsEveryName(before: readonly string[], after: readonly string[], what: string): void {
  const left = [...after];
  for (const name of before) {
    const at = left.indexOf(name);
    expect(at, `${what}: "${name}" is no longer on the wall`).toBeGreaterThanOrEqual(0);
    left.splice(at, 1);
  }
}

const NONE = 'rgba(0, 0, 0, 0)';

describe('the calendar’s looks, on the shipped Classic wall', () => {
  for (const size of SIZES) {
    const key = `${size.width}x${size.height}`;
    let text: Drawn;
    let swiss: Drawn;

    it(
      `${key}: today is a ring, a filled numeral or an accent numeral, and none of them moves a cell`,
      async () => {
        text = await drawn(size, {});
        expect(text.names.length, `${key}: the wall names too little for this to prove anything`).toBeGreaterThan(5);
        expect(text.look.today.outlineStyle).toBe('solid');
        expect(text.look.today.outlineWidth).toBeGreaterThan(1);

        const accent = rgb(BUILTIN_THEME_TOKENS.panels['--accent']);
        const fill = await drawn(size, { todayStyle: 'fill' });
        expect(fill.look.today.outlineStyle).toBe('none');
        expect(fill.look.today.numeralBackground).toBe(accent);
        expect(fill.look.today.numeralColour).toBe(rgb(fill.look.box.bg));

        const numeral = await drawn(size, { todayStyle: 'numeral' });
        expect(numeral.look.today.outlineStyle).toBe('none');
        expect(numeral.look.today.numeralBackground).toBe(NONE);
        expect(numeral.look.today.numeralColour).toBe(accent);

        for (const [name, look] of [['fill', fill], ['numeral', numeral]] as const) {
          sameRects(look.look.cells, text.look.cells, `${key} ${name}: cell`);
          sameRects(look.look.lines, text.look.lines, `${key} ${name}: numeral line`);
          expect(look.names, `${key} ${name}`).toEqual(text.names);
          expect(look.plusN).toBe(text.plusN);
        }
      },
      SLOW,
    );

    it(
      `${key}: a Swiss month rings today outside the cell, clear of its words, and moves nothing`,
      async () => {
        swiss = await drawn(size, { cellEvents: 'swiss' });
        expect(swiss.look.today.outlineStyle).toBe('none');
        const ring = await drawn(size, { cellEvents: 'swiss', todayStyle: 'ring' });
        expect(ring.look.today.outlineStyle).toBe('solid');
        expect(ring.look.today.outlineWidth).toBeGreaterThan(1);
        // Outside: a Swiss cell has no left padding, so an inset ring would lie on the words.
        expect(ring.look.today.outlineOffset).toBeGreaterThan(0);
        sameRects(ring.look.cells, swiss.look.cells, `${key} swiss ring: cell`);
        expect(ring.names).toEqual(swiss.names);
        expect(ring.plusN).toBe(swiss.plusN);
      },
      SLOW,
    );

    it(
      `${key}: the heading is drawn large or as a label, and hiding the Swiss one gives the cells its room`,
      async () => {
        expect(text.look.heading).toBeUndefined();
        expect(swiss.look.heading).toBeDefined();
        const small = await drawn(size, { monthHeading: 'small' });
        const large = await drawn(size, { monthHeading: 'large' });
        expect(small.look.heading?.text).toBe(swiss.look.heading?.text);
        expect(small.look.heading!.fontPx).toBeLessThan(large.look.heading!.fontPx);
        // The grid starts under it, and still draws every name it keeps whole.
        expect(small.look.gridTop).toBeGreaterThanOrEqual(small.look.heading!.bottom - 0.5);
        expect(small.truncated).toBe(0);
        // What a heading costs, measured rather than asserted away: at most one
        // name off the flat-text month on this wall (15 to 14 at 1080x1920,
        // none at 1920x1080), spent on the month's own name.
        expect(text.names.length - small.names.length).toBeLessThanOrEqual(1);
        expect(text.names.length - large.names.length).toBeLessThanOrEqual(1);
        expect(large.truncated).toBe(0);

        const hidden = await drawn(size, { cellEvents: 'swiss', monthHeading: 'hidden' });
        expect(hidden.look.heading).toBeUndefined();
        expect(hidden.look.gridTop).toBeLessThan(swiss.look.gridTop - 10);
        keepsEveryName(swiss.names, hidden.names, `${key} swiss, heading hidden`);
      },
      SLOW,
    );

    it(
      `${key}: a bar and coloured text mark whose event it is, and every name the dot drew is still drawn`,
      async () => {
        const dotWidth = Math.max(...text.look.rows.map((row) => row.dotWidth));
        expect(dotWidth).toBeGreaterThan(2);

        const bar = await drawn(size, { eventMark: 'bar' });
        expect(bar.look.rows.length).toBeGreaterThan(0);
        for (const row of bar.look.rows) {
          expect(row.dotDisplay).not.toBe('none');
          expect(row.dotWidth, `${key}: the bar is wider than the dot it replaced`).toBeLessThan(dotWidth);
        }
        keepsEveryName(text.names, bar.names, `${key} bar`);

        const coloured = await drawn(size, { eventMark: 'text' });
        expect(coloured.look.rows.length).toBeGreaterThan(0);
        const ink = rgb(coloured.look.box.ink);
        let hued = 0;
        for (const row of coloured.look.rows) {
          expect(row.dotDisplay).toBe('none');
          expect(contrast(row.textColour, coloured.look.box.bg), `${key}: "${row.text}" on the ground`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(row.textColour, coloured.look.box.panel), `${key}: "${row.text}" on the panel`).toBeGreaterThanOrEqual(4.5);
          if (row.textColour !== ink) hued += 1;
        }
        expect(hued, `${key}: no event is drawn in its calendar's colour`).toBeGreaterThan(0);
        // The words start where the dot used to: to the left, by the dot and its gap.
        const byCell = new Map(text.look.rows.map((row) => [row.at, row.textLeft]));
        for (const row of coloured.look.rows) {
          const before = byCell.get(row.at);
          if (before !== undefined) expect(row.textLeft).toBeLessThan(before);
        }
        keepsEveryName(text.names, coloured.names, `${key} coloured text`);
      },
      SLOW,
    );

    it(
      `${key}: week rules lie in the gap above each week, cost no cell a pixel, and a Swiss month can drop its hairline`,
      async () => {
        expect(text.look.rules).toEqual([]);
        const ruled = await drawn(size, { gridLines: 'week' });
        const weeks = ruled.look.cells.length / 7;
        expect(ruled.look.rules.length).toBe(weeks);
        const firstOfWeek = ruled.look.cells.filter((_, index) => index % 7 === 0);
        ruled.look.rules.forEach((rule, index) => {
          const cell = firstOfWeek[index]!;
          expect(rule.height).toBeGreaterThan(0.5);
          expect(rule.colour).toBe(rgb(ruled.look.box.ruleWeek));
          // Above the week, and no lower than its first cell's top edge.
          expect(rule.top + rule.height).toBeLessThanOrEqual(cell.top + 0.5);
          expect(cell.top - rule.top).toBeLessThan(8);
          // Across the whole row, gutters included.
          expect(rule.width).toBeGreaterThan(cell.width * 6.5);
        });
        sameRects(ruled.look.cells, text.look.cells, `${key} week rules: cell`);
        expect(ruled.names).toEqual(text.names);
        expect(ruled.plusN).toBe(text.plusN);

        const bare = await drawn(size, { cellEvents: 'swiss', gridLines: 'none' });
        const plain = swiss.look.cellTops.filter((top) => !top.rota);
        expect(plain.length).toBeGreaterThan(3);
        for (const top of plain) expect(top.colour).not.toBe(NONE);
        bare.look.cellTops.forEach((top, index) => {
          if (!top.rota) expect(top.colour, `${key}: cell ${index} still carries a week rule`).toBe(NONE);
          expect(top.width).toBe(swiss.look.cellTops[index]!.width);
        });
        sameRects(bare.look.cells, swiss.look.cells, `${key} swiss, no rules: cell`);
        expect(bare.names).toEqual(swiss.names);
      },
      SLOW,
    );

    it(
      `${key}: the planner is paper, Fraunces numerals and ruled weeks — legible, and naming what the standard look names`,
      async () => {
        const planner = await drawn(size, { variant: 'planner' });
        const paper = BUILTIN_THEME_TOKENS.almanac['--bg'];
        expect(planner.look.box.background).toBe(rgb(paper));
        expect(planner.look.numeral.family).toContain('Fraunces');
        expect(planner.look.numeral.weight).toBe('400');
        expect(contrast(planner.look.numeral.colour, paper)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(planner.look.box.scaffold, paper)).toBeGreaterThanOrEqual(4.5);
        expect(planner.look.rules.length).toBe(planner.look.cells.length / 7);
        expect(planner.look.rules[0]!.colour).toBe(rgb(BUILTIN_THEME_TOKENS.almanac['--rule']));
        sameRects(planner.look.cells, text.look.cells, `${key} planner: cell`);
        sameRects(planner.look.lines, text.look.lines, `${key} planner: numeral line`);
        expect(planner.names).toEqual(text.names);
        expect(planner.plusN).toBe(text.plusN);
      },
      SLOW,
    );

    it(
      `${key}: bold draws heavy numerals and rules in the ink, naming what the standard look names`,
      async () => {
        const bold = await drawn(size, { variant: 'bold' });
        expect(bold.look.numeral.family).toContain('Roboto Flex');
        expect(Number(bold.look.numeral.weight)).toBeGreaterThanOrEqual(900);
        expect(Number(text.look.numeral.weight)).toBeLessThan(900);
        const ink = rgb(BUILTIN_THEME_TOKENS.panels['--ink']);
        expect(bold.look.rules.length).toBe(bold.look.cells.length / 7);
        for (const rule of bold.look.rules) {
          expect(rule.colour).toBe(ink);
          expect(rule.height).toBeGreaterThan(1.5);
        }
        sameRects(bold.look.cells, text.look.cells, `${key} bold: cell`);
        sameRects(bold.look.lines, text.look.lines, `${key} bold: numeral line`);
        expect(bold.names).toEqual(text.names);
        expect(bold.plusN).toBe(text.plusN);
      },
      SLOW,
    );
  }
});

describe('the month’s “Which calendars”', () => {
  for (const size of SIZES) {
    const key = `${size.width}x${size.height}`;
    it(
      `${key}: draws exactly the month of a household that keeps only those calendars on the grid`,
      async () => {
        const sources = wall.db.prepare('SELECT id, name FROM calendar_sources ORDER BY name').all() as {
          id: string;
          name: string;
        }[];
        const family = sources.find((source) => source.name === 'Family')!;
        const all = await drawn(size, {});
        const filtered = await drawn(size, { calendars: [family.id] });
        // The household-wide switch, applied to every other calendar, is the
        // month a correct filter must reproduce — names, counts and bars.
        wall.db.prepare('UPDATE calendar_sources SET show_in_grid = 0 WHERE id <> ?').run(family.id);
        let expected: Drawn;
        try {
          expected = await drawn(size, {});
        } finally {
          wall.db.prepare('UPDATE calendar_sources SET show_in_grid = 1').run();
        }
        expect(filtered.names).toEqual(expected.names);
        expect(filtered.plusN).toBe(expected.plusN);
        expect(filtered.look.rowColours).toEqual(expected.look.rowColours);
        expect(filtered.look.spanColours).toEqual(expected.look.spanColours);
        expect(filtered.look.rowColours.length).toBeLessThanOrEqual(1);
        expect(filtered.names, `${key}: the filter took nothing off, so this proves nothing`).not.toEqual(all.names);
        expect(filtered.names).toContain('Half term');
      },
      SLOW,
    );
  }
});

describe('the agenda’s locations', () => {
  for (const size of SIZES) {
    const key = `${size.width}x${size.height}`;
    it(
      `${key}: a place is drawn after its title where it fits the line, and never costs an entry its height`,
      async () => {
        const without = await drawn(size, {}, {});
        expect(without.look.agenda.places).toEqual([]);
        const withPlaces = await drawn(size, {}, { showLocations: true });
        sameRects(withPlaces.look.agenda.entries, without.look.agenda.entries, `${key}: agenda entry`);
        const short = withPlaces.look.agenda.places.find((place) => place.text.includes('Hall'));
        const long = withPlaces.look.agenda.places.find((place) => place.text.includes('pavilion'));
        expect(short, `${key}: the short place was not drawn at all`).toBeDefined();
        expect(short!.shown, `${key}: "Hall" fits on "Choir"'s line and is not shown`).toBe(true);
        expect(long, `${key}: the long place was not built`).toBeDefined();
        expect(long!.shown, `${key}: a paragraph of a place was drawn`).toBe(false);
        expect(short!.text).toBe('· Hall');
        expect(contrast(short!.colour, withPlaces.look.box.bg)).toBeGreaterThan(3);
      },
      SLOW,
    );
  }
});

describe('the editor offers the looks, the filter and the places where they do something', () => {
  it(
    'draws Which calendars and the four looks on the month, Show locations on the agenda, and stores only a difference',
    async () => {
      configure({});
      const portrait = readLayoutWidgets(wall.db, screenId, 'portrait');
      const monthId = portrait.find((w) => w.type === 'calendar' && (w.config as Record<string, unknown>)?.['mode'] === 'month')!.id;
      const listId = portrait.find((w) => w.type === 'calendar' && (w.config as Record<string, unknown>)?.['mode'] === 'list')!.id;
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        const pressedIn = (label: string): Promise<string | null> =>
          page.locator(`.le-config .seg[aria-label="${label}"] button[aria-pressed="true"]`).textContent();

        await page.locator(`.le-overlay .le-widget[data-id="${monthId}"]`).click();
        await page.waitForSelector('.le-config', { timeout: 20_000 });
        const month = (await page.locator('.le-config').innerText()).replace(/\s+/g, ' ');
        for (const label of ['Calendars to show', 'Today', 'Month heading', 'Event marks', 'Lines']) {
          expect(month, `the month does not offer ${label}`).toContain(label);
        }
        // Each shows the look the flat-text month draws now.
        expect(await pressedIn('Today')).toBe('Ring');
        expect(await pressedIn('Month heading')).toBe('Hidden');
        expect(await pressedIn('Event marks')).toBe('Dot');
        expect(await pressedIn('Lines')).toBe('None');
        await page.locator('.le-config .seg[aria-label="Today"] button', { hasText: 'Fill' }).click();
        await page.locator('.le-config .seg[aria-label="Lines"] button', { hasText: 'None' }).click();
        expect(await pressedIn('Today')).toBe('Fill');

        await page.locator(`.le-overlay .le-widget[data-id="${listId}"]`).click();
        await page.waitForSelector('.le-config', { timeout: 20_000 });
        const list = (await page.locator('.le-config').innerText()).replace(/\s+/g, ' ');
        expect(list).toContain('Show locations');
        expect(list).not.toContain('Month heading');

        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('#savebar button[data-action="save"]'),
        ]);
        const stored = readLayoutWidgets(wall.db, screenId, 'portrait').find((w) => w.id === monthId)!.config as Record<string, unknown>;
        expect(stored['todayStyle']).toBe('fill');
        // Pressing the treatment's own look stores nothing.
        expect('gridLines' in stored).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
