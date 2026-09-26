/**
 * The rota on the calendar, in every look a household can choose, with two
 * people on it (plan item P5.4, parts 1–3).
 *
 * Measured rather than read, on the shipped Classic wall at 1080x1920 and
 * 1920x1080 — a real paired screen, the household's three calendars, a
 * forecast and **two** rota workers, because one person cannot show the fault
 * this phase closes: the month cell and the agenda row both read `shifts[0]`,
 * so Ben's nights were nowhere on a wall whose badge drew him. Every
 * assertion reads computed geometry, computed colour or the words on the
 * glass, never a class name; this project has shipped a control whose class
 * was right and whose pixels were an empty outline.
 *
 * The constraint that decides whether this ships is stated in CLAUDE.md and
 * held here in three ways: **a mark never costs an event its row.** The label
 * sits on the numeral's line beside it, so (1) that line is exactly as tall
 * with a label or a dot on it as without, (2) the grid names the same events
 * in every look as it does in `tint`, and (3) the two ratchets — `wall-density`
 * and `browser-classic-proportions`, one rota person, every key absent — were
 * compared as text against a clean worktree of `main` and are unmoved, which
 * this file cannot see and its sibling records.
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
} from './browser-harness.js';
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { applyTemplate } from '../src/api/templates.js';
import { classicFor } from '../src/templates/classic.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

const SIZES = [
  { width: 1080, height: 1920 },
  { width: 1920, height: 1080 },
] as const;

let wall: Installation;
let link: string;
let screenId: string;

/**
 * A second person on a rota — `browser-shift-two-people`'s fixture, with one
 * change. Amy's six-day pattern lands on a day shift today; Ben's is the same
 * pattern turned by two, so today is a night: a different shift, so the two
 * marks carry different colours and cannot be one mark drawn twice. Ben's plan
 * **ends tomorrow**, so the same grid holds days with two people on the rota
 * (yesterday, today and tomorrow) and weeks with Amy alone, and a cell that
 * draws two segments can be held beside one that keeps its own border — which
 * is the discriminator a renderer that drew every cell one way would fail.
 * Today is always among the two-person days, so the agenda's first row and the
 * week strip's own column carry two people whatever weekday the suite runs on.
 */
const SECOND_UNTIL_DAYS = 1;
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
         (id, person_id, name, kind, effective_from, effective_to, priority, anchor_date, cycle, consumes_events, created_at, updated_at)
       VALUES (?, ?, ?, 'pattern', ?, ?, 0, ?, ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      'plan-ben', 'p-ben', 'Ben rota', iso(-30), iso(SECOND_UNTIL_DAYS), iso(-30),
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
  applyTemplate(wall.db, screenId, classicFor({ modules: ['weather'], shift: true, todoLists: [] }));
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * Classic's seed, re-applied, with these keys laid over its **month** widget's
 * config on both canvases. The agenda beside it keeps the seed's own config
 * throughout, so the chips it draws are what a household on defaults sees. A
 * key set to `undefined` is removed, which is how the editor stores a default,
 * so the `tint` case here is the byte-identical seed. Re-seeding each time
 * rather than patching the last arrangement is what keeps one case's `mode`
 * from leaking into the next — the first draft did not, and measured a week
 * strip where it asked for a month.
 */
function configureCalendars(patch: Record<string, unknown>): void {
  applyTemplate(wall.db, screenId, classicFor({ modules: ['weather'], shift: true, todoLists: [] }));
  const only = (config: Record<string, unknown>): boolean => config['mode'] === 'month';
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
      if (widget.type === 'calendar' && only(config)) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete config[key];
          else config[key] = value;
        }
      }
      return {
        id: widget.id,
        type: widget.type,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        z: widget.z,
        config,
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

interface Mark {
  readonly text: string;
  readonly colour: string;
  /** `scrollWidth` past `clientWidth`, which is a cut string. */
  readonly cut: boolean;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface CellRota {
  readonly day: string;
  readonly background: string;
  readonly borderTopWidth: number;
  readonly borderTopColour: string;
  /** The strip of segments, when one is drawn: each segment's colour and rect. */
  readonly segments: readonly Mark[];
  readonly stripTop: number | undefined;
  readonly cellTop: number;
  readonly cellLeft: number;
  readonly cellRight: number;
  /** The visible label form's codes, each in its own colour. */
  readonly codes: readonly Mark[];
  readonly labelForm: string | undefined;
  /** Every form the label carries, visible or not, as words. */
  readonly forms: readonly string[];
  readonly dots: readonly Mark[];
  /** The numeral's line: its rect. */
  readonly line: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly height: number };
  readonly numeralRight: number;
  readonly markWidth: number;
  /** The first event row's top, so a mark can be shown to sit above it. */
  readonly firstRowTop: number | undefined;
}

interface HeadRota {
  readonly day: string;
  /** Today's head carries the accent ground of its own, rota or not. */
  readonly today: boolean;
  readonly background: string;
  readonly segments: readonly Mark[];
  readonly codes: readonly Mark[];
  /** Which form of a label is shown, `-1` when none fits, undefined when there is no label. */
  readonly labelForm: string | undefined;
  readonly dots: readonly Mark[];
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly stripTop: number | undefined;
}

interface RotaReading {
  readonly theme: { readonly day: string; readonly night: string; readonly rest: string };
  readonly cells: readonly CellRota[];
  readonly heads: readonly HeadRota[];
  /** The agenda's day rows: the chips and hours in each date column. */
  readonly agenda: readonly {
    readonly day: string;
    readonly chips: readonly Mark[];
    readonly borderLeftColour: string;
  }[];
  readonly legend: readonly string[];
  /** The class of the first calendar section drawn, so a test knows which view it got. */
  readonly grid: string;
}

async function readRota(page: Page): Promise<RotaReading> {
  return page.evaluate(() => {
    const visible = (node: Element): boolean => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const markOf = (node: HTMLElement, colourOf: (style: CSSStyleDeclaration) => string): Mark => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        text: (node.textContent ?? '').trim(),
        colour: colourOf(style),
        cut: node.scrollWidth > node.clientWidth + 1,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    };
    /** A shift token resolved through the live cascade, as the browser paints it. */
    const resolve = (declaration: string): string => {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;color:${declaration}`;
      const canvas = document.querySelector('#wall .canvas') ?? document.body;
      canvas.appendChild(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    const theme = {
      day: resolve('var(--s-day)'),
      night: resolve('var(--s-night)'),
      rest: resolve('var(--s-break)'),
    };
    const marksIn = (scope: HTMLElement) => {
      const strip = scope.querySelector<HTMLElement>(':scope > .hz-shifts');
      const label = scope.querySelector<HTMLElement>('.hz-shiftlabel');
      const form = label === null ? null : [...label.querySelectorAll<HTMLElement>('.hz-shiftform')].find(visible) ?? null;
      return {
        segments: strip === null ? [] : [...strip.querySelectorAll<HTMLElement>('.hz-shiftseg')].map((seg) => markOf(seg, (s) => s.backgroundColor)),
        stripTop: strip?.getBoundingClientRect().top,
        codes: form === null ? [] : [...form.querySelectorAll<HTMLElement>('.hz-shiftcode')].map((code) => markOf(code, (s) => s.color)),
        labelForm: label?.getAttribute('data-form') ?? undefined,
        forms: label === null ? [] : [...label.querySelectorAll<HTMLElement>('.hz-shiftform')].map((f) => (f.textContent ?? '').trim()),
        dots: [...scope.querySelectorAll<HTMLElement>('.hz-shiftdot')].map((dot) => markOf(dot, (s) => s.backgroundColor)),
      };
    };

    const grid = document.querySelector('#wall .horizon, #wall .sky, #wall .weekcols');
    const cells: CellRota[] = [];
    for (const cell of document.querySelectorAll<HTMLElement>('#wall .hz-cell, #wall .sk-cell')) {
      const style = getComputedStyle(cell);
      const rect = cell.getBoundingClientRect();
      const line = cell.querySelector<HTMLElement>('.hz-top, .sk-top');
      const numeral = cell.querySelector<HTMLElement>('.hz-num, .sk-mnum');
      const lineRect = line?.getBoundingClientRect() ?? numeral?.getBoundingClientRect();
      const firstRow = [...cell.querySelectorAll<HTMLElement>('.hz-row, .sk-bar')].find(visible);
      cells.push({
        day: (numeral?.textContent ?? '').trim(),
        background: style.backgroundColor,
        borderTopWidth: parseFloat(style.borderTopWidth),
        borderTopColour: style.borderTopColor,
        ...marksIn(cell),
        cellTop: rect.top,
        cellLeft: rect.left,
        cellRight: rect.right,
        line: lineRect === undefined
          ? { top: 0, bottom: 0, left: 0, right: 0, height: 0 }
          : { top: lineRect.top, bottom: lineRect.bottom, left: lineRect.left, right: lineRect.right, height: lineRect.height },
        numeralRight: numeral?.getBoundingClientRect().right ?? 0,
        markWidth: cell.querySelector<HTMLElement>('.hz-mark')?.getBoundingClientRect().width ?? 0,
        firstRowTop: firstRow?.getBoundingClientRect().top,
      });
    }

    const heads: HeadRota[] = [];
    for (const head of document.querySelectorAll<HTMLElement>('#wall .wc-head, #wall .sk-head')) {
      const rect = head.getBoundingClientRect();
      const marks = marksIn(head);
      heads.push({
        day: (head.querySelector('.wc-num, .sk-num')?.textContent ?? '').trim(),
        today: head.closest('.is-today') !== null,
        background: getComputedStyle(head).backgroundColor,
        segments: marks.segments,
        codes: marks.codes,
        labelForm: marks.labelForm,
        dots: marks.dots,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        stripTop: marks.stripTop,
      });
    }

    const agenda = [...document.querySelectorAll<HTMLElement>('#wall section.next .day-row')].filter(visible).map((row) => ({
      day: (row.querySelector('.dr-num')?.textContent ?? '').trim(),
      chips: [...row.querySelectorAll<HTMLElement>('.dr-shift')].map((chip) => markOf(chip, (s) => s.color)),
      borderLeftColour: getComputedStyle(row).borderLeftColor,
    }));

    const legend = [...document.querySelectorAll<HTMLElement>('#wall .legend span')].map((entry) => (entry.textContent ?? '').trim());

    return { theme, cells, heads, agenda, legend, grid: grid === null ? '' : String(grid.className) };
  });
}

interface Drawn {
  readonly rota: RotaReading;
  /** Every event name on the month grid, bars included, sorted. */
  readonly names: readonly string[];
  readonly plusN: number;
}

/** The wall drawn at one size with the calendars configured so. */
async function drawn(size: { readonly width: number; readonly height: number }, patch: Record<string, unknown>): Promise<Drawn> {
  configureCalendars(patch);
  const { page, close } = await loadWallSettled(link, size);
  try {
    const [rota, grid] = await Promise.all([readRota(page), measureMonthGrid(page)]);
    const out = {
      rota,
      names: [
        ...grid.titles.map((title) => title.text),
        ...grid.spans.filter((bar) => bar.labelled).map((bar) => bar.title),
      ].sort(),
      plusN: grid.cells.filter((cell) => cell.more !== '').length,
    };
    if (process.env['SHIFT_DUMP'] !== undefined) appendFileSync(process.env['SHIFT_DUMP'], JSON.stringify({ size, patch, ...out }) + '\n');
    return out;
  } finally {
    await close();
  }
}

const NONE = 'rgba(0, 0, 0, 0)';
const TINT = { shiftStyle: undefined, showShifts: undefined } as const;

/** The rota days on a grid: cells whose marks say one person, and cells that say two. */
function people(cell: CellRota): number {
  if (cell.segments.length > 0) return cell.segments.length;
  if (cell.codes.length > 0) return cell.codes.length;
  if (cell.dots.length > 0) return cell.dots.length;
  return cell.borderTopColour !== NONE || cell.background !== NONE ? 1 : 0;
}

describe('two people on the rota, on the shipped Classic wall', () => {
  for (const size of SIZES) {
    const key = `${size.width}x${size.height}`;
    let tint: Drawn;

    it(
      `${key}: the tint marks both people — the wash from the first, the rule split between them`,
      async () => {
        tint = await drawn(size, TINT);
        const { rota } = tint;
        const shiftColours = [rota.theme.day, rota.theme.night, rota.theme.rest];
        const two = rota.cells.filter((cell) => cell.segments.length === 2);
        const one = rota.cells.filter((cell) => cell.segments.length === 0 && cell.borderTopColour !== NONE);
        const none = rota.cells.filter((cell) => people(cell) === 0);
        expect(two.length, `${key}: no cell carries two segments`).toBeGreaterThanOrEqual(2);
        expect(one.length, `${key}: no cell keeps one person's own border`).toBeGreaterThan(3);
        expect(none.length, `${key}: no cell is without a rota`).toBeGreaterThan(0);
        for (const cell of one) {
          // One person draws exactly what every wall drew: the cell's own border and wash.
          expect(cell.borderTopWidth).toBeGreaterThan(0);
          expect(shiftColours).toContain(cell.borderTopColour);
          expect(cell.background).not.toBe(NONE);
        }
        for (const cell of two) {
          // The strip lies where the border was: at the very top of the cell, and
          // the border itself is gone rather than hidden under it.
          expect(cell.borderTopWidth).toBe(0);
          expect(Math.abs((cell.stripTop ?? 0) - cell.cellTop)).toBeLessThan(0.6);
          // Two colours, both the rota's, side by side and together the cell's width.
          const [a, b] = cell.segments as [Mark, Mark];
          expect(a.colour).not.toBe(b.colour);
          expect(shiftColours).toContain(a.colour);
          expect(shiftColours).toContain(b.colour);
          expect(a.right - a.left).toBeGreaterThan(10);
          expect(Math.abs(a.right - b.left)).toBeLessThan(0.6);
          expect(Math.abs(a.left - cell.cellLeft)).toBeLessThan(0.6);
          expect(Math.abs(b.right - cell.cellRight)).toBeLessThan(0.6);
          // The wash is the first person's — a coloured ground, not the theme's.
          expect(cell.background).not.toBe(NONE);
          // And the numeral's line under it is where it is on every other cell.
          const plain = one[0] as CellRota;
          expect(Math.abs(cell.line.height - plain.line.height)).toBeLessThan(0.6);
          expect(Math.abs(cell.line.top - cell.cellTop - (plain.line.top - plain.cellTop))).toBeLessThan(1);
        }
        // The legend explains every colour on the grid, the second person's too.
        expect(rota.legend).toEqual(expect.arrayContaining(['Days', 'Mids', 'Off']));
      },
      SLOW,
    );

    it(
      `${key}: the label puts the codes beside the numeral, by initial for two, whole, and costs no event its row`,
      async () => {
        const { rota, names, plusN } = await drawn(size, { ...TINT, shiftStyle: 'label' });
        const shiftColours = [rota.theme.day, rota.theme.night, rota.theme.rest];
        const labelled = rota.cells.filter((cell) => cell.codes.length > 0);
        const two = labelled.filter((cell) => cell.codes.length === 2);
        const one = labelled.filter((cell) => cell.codes.length === 1);
        expect(two.length, `${key}: no cell labels two people`).toBeGreaterThanOrEqual(2);
        expect(one.length, `${key}: no cell labels one person`).toBeGreaterThan(3);
        for (const cell of labelled) {
          // No wash and no coloured rule: the code is the whole mark.
          expect(cell.background).toBe(NONE);
          expect(cell.borderTopColour).toBe(NONE);
          expect(cell.segments).toEqual([]);
          expect(cell.dots).toEqual([]);
          for (const code of cell.codes) {
            expect(shiftColours, `${key}: day ${cell.day}'s "${code.text}" is ${code.colour}`).toContain(code.colour);
            expect(code.cut, `${key}: day ${cell.day}'s "${code.text}" is cut`).toBe(false);
            // On the numeral's line, to its right, inside the line.
            expect(code.left).toBeGreaterThan(cell.numeralRight - 0.5);
            expect(code.right).toBeLessThanOrEqual(cell.line.right + 0.5);
            expect(code.top).toBeGreaterThanOrEqual(cell.line.top - 0.5);
            expect(code.bottom).toBeLessThanOrEqual(cell.line.bottom + 0.5);
          }
          // Above the first event row, never in it.
          if (cell.firstRowTop !== undefined) {
            for (const code of cell.codes) expect(code.bottom).toBeLessThanOrEqual(cell.firstRowTop + 0.5);
          }
        }
        for (const cell of one) expect(cell.codes[0]?.text).toMatch(/^[A-Z]{1,3}$/);
        for (const cell of two) {
          const [a, b] = cell.codes as [Mark, Mark];
          expect(a.colour).not.toBe(b.colour);
          // The long form, "A·D B·M", or the codes alone where the line cannot
          // hold that whole — the same form for every two-person cell in the grid.
          expect(cell.forms.length).toBe(2);
          expect(cell.labelForm).toBe((two[0] as CellRota).labelForm);
          if (cell.labelForm === '0') {
            expect(a.text).toMatch(/^A·[A-Z]{1,3}$/);
            expect(b.text).toMatch(/^B·[A-Z]{1,3}$/);
          } else {
            expect(cell.labelForm).toBe('1');
            expect(a.text).toMatch(/^[A-Z]{1,3}$/);
          }
        }
        // The numeral's line is exactly as tall as the tint's, and the grid
        // names the same events with the same counts: the label cost no row.
        for (const cell of rota.cells) {
          const before = tint.rota.cells.find((other) => other.day === cell.day && Math.abs(other.cellTop - cell.cellTop) < 2);
          expect(before, `${key}: day ${cell.day} moved`).toBeDefined();
          expect(Math.abs(cell.line.height - (before as CellRota).line.height)).toBeLessThan(0.6);
        }
        expect(names).toEqual(tint.names);
        expect(plusN).toBe(tint.plusN);
        expect(names.length).toBeGreaterThan(5);
      },
      SLOW,
    );

    it(
      `${key}: the edge keeps the rule and drops the wash, in segments for two`,
      async () => {
        const { rota, names, plusN } = await drawn(size, { ...TINT, shiftStyle: 'edge' });
        const shiftColours = [rota.theme.day, rota.theme.night, rota.theme.rest];
        const two = rota.cells.filter((cell) => cell.segments.length === 2);
        const one = rota.cells.filter((cell) => cell.segments.length === 0 && cell.borderTopColour !== NONE);
        expect(two.length).toBeGreaterThanOrEqual(2);
        expect(one.length).toBeGreaterThan(3);
        for (const cell of [...one, ...two]) {
          expect(cell.background, `${key}: day ${cell.day} is washed under an edge`).toBe(NONE);
          expect(cell.codes).toEqual([]);
          expect(cell.dots).toEqual([]);
        }
        for (const cell of one) {
          expect(cell.borderTopWidth).toBeGreaterThan(0);
          expect(shiftColours).toContain(cell.borderTopColour);
        }
        for (const cell of two) {
          expect(cell.borderTopWidth).toBe(0);
          const [a, b] = cell.segments as [Mark, Mark];
          expect(a.colour).not.toBe(b.colour);
          expect(Math.abs((cell.stripTop ?? 0) - cell.cellTop)).toBeLessThan(0.6);
          expect(Math.abs(b.right - cell.cellRight)).toBeLessThan(0.6);
        }
        expect(names).toEqual(tint.names);
        expect(plusN).toBe(tint.plusN);
      },
      SLOW,
    );

    it(
      `${key}: the dot draws one disc a person beside the numeral, and costs no event its row`,
      async () => {
        const { rota, names, plusN } = await drawn(size, { ...TINT, shiftStyle: 'dot' });
        const shiftColours = [rota.theme.day, rota.theme.night, rota.theme.rest];
        const dotted = rota.cells.filter((cell) => cell.dots.length > 0);
        const two = dotted.filter((cell) => cell.dots.length === 2);
        expect(two.length).toBeGreaterThanOrEqual(2);
        expect(dotted.filter((cell) => cell.dots.length === 1).length).toBeGreaterThan(3);
        for (const cell of dotted) {
          expect(cell.background).toBe(NONE);
          expect(cell.borderTopColour).toBe(NONE);
          expect(cell.codes).toEqual([]);
          for (const dot of cell.dots) {
            expect(shiftColours).toContain(dot.colour);
            const diameter = dot.right - dot.left;
            expect(diameter).toBeGreaterThan(4);
            expect(Math.abs(dot.bottom - dot.top - diameter)).toBeLessThan(0.6);
            expect(dot.left).toBeGreaterThan(cell.numeralRight - 0.5);
            expect(dot.top).toBeGreaterThanOrEqual(cell.line.top - 0.5);
            expect(dot.bottom).toBeLessThanOrEqual(cell.line.bottom + 0.5);
          }
          const before = tint.rota.cells.find((other) => other.day === cell.day && Math.abs(other.cellTop - cell.cellTop) < 2) as CellRota;
          expect(Math.abs(cell.line.height - before.line.height)).toBeLessThan(0.6);
        }
        for (const cell of two) {
          const [a, b] = cell.dots as [Mark, Mark];
          expect(a.colour).not.toBe(b.colour);
        }
        expect(names).toEqual(tint.names);
        expect(plusN).toBe(tint.plusN);
      },
      SLOW,
    );

    it(
      `${key}: the switch takes every mark off the month, in every look`,
      async () => {
        /*
         * The one case the four looks above cannot see, and the one that was
         * broken first: `renderCell` took its look through a defaulted
         * parameter, and a default is substituted for an explicit `undefined`
         * — so a switched-off rota drew as the tint, on the wall and in the
         * editor's preview, under a legend that had correctly gone.
         */
        for (const style of [undefined, 'label', 'edge', 'dot']) {
          const { rota, names, plusN } = await drawn(size, { ...TINT, showShifts: false, shiftStyle: style });
          for (const cell of rota.cells) {
            expect(people(cell), `${key} ${style ?? 'tint'}: day ${cell.day} is still marked with the switch off`).toBe(0);
          }
          expect(rota.legend).toEqual([]);
          /*
           * At least what the tint names, and measured, more: the legend under
           * the grid goes with the switch, and the row it stood in is a row the
           * cells get back — 13 names to the tint's 11 at 1920x1080. Room coming
           * back is the direction this file allows; a name lost is not.
           */
          expect(names.length).toBeGreaterThanOrEqual(tint.names.length);
          expect(plusN).toBeLessThanOrEqual(tint.plusN + 1);
        }
      },
      SLOW,
    );

    it(
      `${key}: the agenda draws one chip a person, told apart by initial`,
      async () => {
        const { rota } = await drawn(size, TINT);
        const shiftColours = [rota.theme.day, rota.theme.night, rota.theme.rest];
        const two = rota.agenda.filter((row) => row.chips.length === 2);
        const one = rota.agenda.filter((row) => row.chips.length === 1);
        expect(two.length, `${key}: no agenda day carries two chips: ${JSON.stringify(rota.agenda.map((row) => row.chips.map((c) => c.text)))}`).toBeGreaterThan(0);
        /*
         * A one-person day is in the agenda where the box has room for a third
         * day — the landscape wall — and not always on the portrait one: a
         * second chip is a second line in the date column, so two two-person
         * days can cost the agenda the day after them. That is content the
         * household has, spent honestly, and what is asserted of a one-person
         * row is asserted wherever one is drawn.
         */
        if (size.width > size.height) expect(one.length, `${key}: no one-person agenda day`).toBeGreaterThan(0);
        for (const row of one) {
          // One person's chip is the shift's own name, as it always was.
          expect(row.chips[0]?.text).toMatch(/^(Days|Mids|Off)$/);
          expect(row.borderLeftColour).toBe(row.chips[0]?.colour);
        }
        for (const row of two) {
          const [a, b] = row.chips as [Mark, Mark];
          expect(a.text).toMatch(/^A · (Days|Mids|Off)$/);
          expect(b.text).toMatch(/^B · (Days|Mids|Off)$/);
          expect(a.colour).not.toBe(b.colour);
          expect(shiftColours).toContain(a.colour);
          expect(shiftColours).toContain(b.colour);
          expect(a.cut).toBe(false);
          expect(b.cut).toBe(false);
          // The row's own rule takes the first person's colour, as it always did.
          expect(row.borderLeftColour).toBe(a.colour);
        }
      },
      SLOW,
    );

    it(
      `${key}: the week views draw the rota only when told to, in every look (Q2)`,
      async () => {
        for (const density of ['comfortable', 'compact'] as const) {
          const week = { ...TINT, mode: 'week', density: density === 'compact' ? 'compact' : undefined };
          const off = await drawn(size, week);
          expect(off.rota.grid, `${key} ${density}: no week drawn`).toMatch(density === 'compact' ? /skyweek/ : /weekcols/);
          expect(off.rota.heads.length).toBe(7);
          for (const head of off.rota.heads) {
            // Today's head has the accent ground of its own on the compact strip.
            if (!head.today) expect(head.background, `${key} ${density}: day ${head.day}'s head is washed with the switch off`).toBe(NONE);
            expect(head.segments).toEqual([]);
            expect(head.codes).toEqual([]);
            expect(head.dots).toEqual([]);
          }
          for (const style of ['tint', 'label', 'edge', 'dot'] as const) {
            const on = await drawn(size, { ...week, showShifts: true, shiftStyle: style === 'tint' ? undefined : style });
            const shiftColours = [on.rota.theme.day, on.rota.theme.night, on.rota.theme.rest];
            const marked = on.rota.heads.filter((head) => head.segments.length + head.codes.length + head.dots.length > 0);
            /*
             * Today's head is always in the strip and always carries both people
             * — with one honest exception. The compact strip's head is one line
             * carrying the weekday *and* the number, and on Classic's landscape
             * month box (a 110px column) neither "A·D B·M" nor "D M" fits beside
             * them at the scaffold size, so the label is drawn whole or not at
             * all and here it is not at all: the forms were measured and every
             * one declined (`data-form` of -1), which is what is asserted, rather
             * than a label that is missing or cut. The dot is the look for that
             * box, and it is asserted below to fit there.
             */
            if (style === 'label' && marked.length === 0) {
              const declined = on.rota.heads.filter((head) => head.labelForm !== undefined);
              expect(declined.length, `${key} ${density}: no head carries a label at all`).toBeGreaterThan(0);
              for (const head of declined) expect(head.labelForm, `${key} ${density}: day ${head.day}'s label`).toBe('-1');
              expect(density === 'compact' && size.width > size.height, `${key} ${density}: the label fitted no head`).toBe(true);
              continue;
            }
            expect(marked.length, `${key} ${density} ${style}: no head is marked`).toBeGreaterThan(0);
            // The seven heads stay one height, rota day or not.
            const heights = new Set(on.rota.heads.map((head) => Math.round((head.bottom - head.top) * 2) / 2));
            expect(heights.size, `${key} ${density} ${style}: heads of ${[...heights].join(', ')}px`).toBe(1);
            for (const head of marked) {
              if (style === 'tint' || style === 'edge') {
                expect(head.segments.length).toBeGreaterThan(0);
                expect(Math.abs((head.stripTop ?? 0) - head.top)).toBeLessThan(0.6);
                for (const seg of head.segments) expect(shiftColours).toContain(seg.colour);
                if (style === 'tint') expect(head.background).not.toBe(NONE);
                else if (!head.today) expect(head.background).toBe(NONE);
              } else if (style === 'label') {
                expect(head.codes.length).toBeGreaterThan(0);
                for (const code of head.codes) {
                  expect(shiftColours).toContain(code.colour);
                  expect(code.cut).toBe(false);
                  expect(code.right).toBeLessThanOrEqual(head.right + 0.5);
                  expect(code.bottom).toBeLessThanOrEqual(head.bottom + 0.5);
                }
              } else {
                expect(head.dots.length).toBeGreaterThan(0);
                for (const dot of head.dots) expect(shiftColours).toContain(dot.colour);
              }
            }
            expect(marked.some((head) => head.segments.length === 2 || head.codes.length === 2 || head.dots.length === 2), `${key} ${density} ${style}: no head marks two people`).toBe(true);
          }
        }
      },
      SLOW,
    );

    it(
      `${key}: the compact month takes every look too`,
      async () => {
        const compact = { ...TINT, density: 'compact' };
        const plain = await drawn(size, compact);
        expect(plain.rota.grid).toMatch(/skymonth/);
        const oneTint = plain.rota.cells.filter((cell) => cell.segments.length === 0 && cell.background !== NONE);
        const twoTint = plain.rota.cells.filter((cell) => cell.segments.length === 2);
        // One person is the fill alone, as the compact grid always drew; two add the strip.
        expect(oneTint.length).toBeGreaterThan(3);
        expect(twoTint.length).toBeGreaterThanOrEqual(2);
        for (const cell of twoTint) expect(Math.abs((cell.stripTop ?? 0) - cell.cellTop)).toBeLessThan(0.6);
        const edge = await drawn(size, { ...compact, shiftStyle: 'edge' });
        for (const cell of edge.rota.cells.filter((cell) => cell.segments.length > 0)) expect(cell.background).toBe(NONE);
        expect(edge.rota.cells.filter((cell) => cell.segments.length === 1).length).toBeGreaterThan(3);
        expect(edge.rota.cells.filter((cell) => cell.segments.length === 2).length).toBeGreaterThanOrEqual(2);
        const label = await drawn(size, { ...compact, shiftStyle: 'label' });
        const labelled = label.rota.cells.filter((cell) => cell.codes.length > 0);
        expect(labelled.filter((cell) => cell.codes.length === 2).length).toBeGreaterThanOrEqual(2);
        for (const cell of labelled) {
          expect(cell.background).toBe(NONE);
          for (const code of cell.codes) {
            expect(code.cut).toBe(false);
            expect(code.left).toBeGreaterThan(cell.numeralRight - 0.5);
            expect(code.right).toBeLessThanOrEqual(cell.line.right + 0.5);
          }
        }
        const dot = await drawn(size, { ...compact, shiftStyle: 'dot' });
        expect(dot.rota.cells.filter((cell) => cell.dots.length === 2).length).toBeGreaterThanOrEqual(2);
        for (const cell of dot.rota.cells.filter((cell) => cell.dots.length > 0)) {
          for (const d of cell.dots) expect(d.left).toBeGreaterThan(cell.numeralRight - 0.5);
        }
      },
      SLOW,
    );
  }
});

/* ------------------------------------------------------------------------ */

const VIEW_SELECT = '.le-cfg-field[data-cfg-key="mode"] select';
const SWITCH = '.switch:has-text("Show work schedules") input';
const STYLE = '.le-cfg-field:has-text("Shift style") .seg button';

/** What the editor's live preview draws, asked of its shadow root. */
async function previewHas(editor: Page, selector: string): Promise<boolean> {
  return editor.evaluate(
    (sel) => document.querySelector('.le-preview')?.shadowRoot?.querySelector(sel) != null,
    selector,
  );
}

async function previewSettles(editor: Page, selector: string, present: boolean): Promise<void> {
  await editor.waitForFunction(
    ([sel, want]) => (document.querySelector('.le-preview')?.shadowRoot?.querySelector(sel as string) != null) === want,
    [selector, present] as const,
    { timeout: 20_000 },
  );
}

describe('the editor', () => {
  it(
    'offers the switch on every view, off on a week by default, and a look beside it that the preview follows',
    async () => {
      configureCalendars(TINT);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await wall.signIn(editor);
        await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.click('.le-orient-btn:has-text("Portrait")');
        await editor.waitForTimeout(250);
        // The month box, by the name the editor gives it.
        await editor.locator('.le-overlay .le-widget', { hasText: 'Month' }).first().click();
        await editor.waitForSelector(VIEW_SELECT, { timeout: 20_000 });
        await editor.click('.insp-tab:has-text("Content")');

        // On the month: the switch on, as the rota has always been, and Tint pressed.
        expect(await editor.locator(SWITCH).isChecked()).toBe(true);
        expect(await editor.locator(`${STYLE}.on`).textContent()).toBe('Tint');
        expect(await editor.locator(STYLE).allTextContents()).toEqual(['Tint', 'Label', 'Edge', 'Dot']);
        expect(await previewHas(editor, '.hz-cell.has-shift')).toBe(true);
        expect(await previewHas(editor, '.hz-shiftlabel')).toBe(false);

        // Label: the preview draws the codes and drops the wash — the key was written.
        await editor.click(`${STYLE}:has-text("Label")`);
        await previewSettles(editor, '.hz-shiftlabel', true);
        expect(await previewHas(editor, '.hz-cell.has-shift')).toBe(false);
        expect(await editor.locator(`${STYLE}.on`).textContent()).toBe('Label');

        // Dot, then back to Tint, which is stored as an absence and draws the seed.
        await editor.click(`${STYLE}:has-text("Dot")`);
        await previewSettles(editor, '.hz-shiftdot', true);
        await editor.click(`${STYLE}:has-text("Tint")`);
        await previewSettles(editor, '.hz-cell.has-shift', true);
        expect(await previewHas(editor, '.hz-shiftdot')).toBe(false);

        // Off: the look goes with the switch, and so do the marks.
        await editor.locator(SWITCH).click();
        expect(await editor.locator(SWITCH).isChecked(), 'the switch did not turn off').toBe(false);
        await previewSettles(editor, '.hz-cell.has-shift', false);
        expect(await editor.locator(STYLE).count(), 'a look offered for a rota that is off').toBe(0);
        await editor.locator(SWITCH).click();
        await previewSettles(editor, '.hz-cell.has-shift', true);

        // The week: the switch is offered and starts off (Q2), so nothing hanging lights up.
        await editor.selectOption(VIEW_SELECT, 'week');
        await editor.waitForTimeout(300);
        await previewSettles(editor, '.weekcols', true);
        expect(await editor.locator(SWITCH).count()).toBe(1);
        expect(await editor.locator(SWITCH).isChecked(), 'the week opened with the rota on').toBe(false);
        expect(await editor.locator(STYLE).count()).toBe(0);
        expect(await previewHas(editor, '.wc-head.has-shift')).toBe(false);
        expect(await previewHas(editor, '.wc-head .hz-shifts')).toBe(false);

        // Turned on, the heads take the tint and the look appears beside the switch.
        await editor.locator(SWITCH).click();
        await previewSettles(editor, '.wc-head.has-shift', true);
        expect(await previewHas(editor, '.wc-head .hz-shifts')).toBe(true);
        expect(await editor.locator(`${STYLE}.on`).textContent()).toBe('Tint');
        await editor.click(`${STYLE}:has-text("Dot")`);
        await previewSettles(editor, '.wc-head .hz-shiftdot', true);
        expect(await previewHas(editor, '.wc-head.has-shift')).toBe(false);

        /*
         * What was written, read off the editor's own save body rather than the
         * preview: `true` for the week (never an absence, which means off
         * there), `dot` for the look, and the month's default earlier stored as
         * no key at all.
         */
        const stored = await editor.evaluate(() => {
          const boxes = [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')];
          const month = boxes.find((box) => (box.textContent ?? '').includes('Week') || (box.textContent ?? '').includes('Month'));
          return month?.dataset['id'] ?? '';
        });
        expect(stored).not.toBe('');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
