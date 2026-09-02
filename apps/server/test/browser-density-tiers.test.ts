/**
 * Density tiers, measured on a real wall.
 *
 * The complaint this phase answers, measured on the shipped Classic wall with
 * three ordinary family calendars: six agenda events across three days and 0,
 * 0, 3, 7, 8 month names, from a 450x800 e-ink panel to a 3.7-megapixel
 * television. There was no mechanism anywhere in either renderer by which a
 * widget with more room showed *more things* — every legibility decision was a
 * measurement of the widget's own content, and a measurement of content can
 * only ever subtract.
 *
 * A tier is the other question, and this file is what says it is being asked.
 * Everything here is read off computed geometry and the words actually on the
 * glass. **Never off a class name**: this project has shipped a month cell that
 * said "+6" and drew none of its six events with every structural check
 * passing, and a control whose class was right and whose pixels were an empty
 * outline. The tier a cell resolved is re-derived here from the *measured* box
 * and the *measured* type, against the table's own thresholds, and compared
 * with what the renderer drew — so a renderer reading the table wrongly fails
 * even though it stamped a rung on the section.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  HOUSEHOLD_CALENDARS,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { replaceLayout } from '../src/api/queries.js';
import { mountedSize, wallSizePreset } from '../src/wall-sizes.js';
import { CALENDAR_TIERS, TYPE_SPECIMEN, namesAt, tierFor } from '../src/epaper/tiers.js';

process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and a good many walls. */
const SLOW = 300_000;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
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

/** Put an arrangement of this test's own on both canvases. */
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
 * Everything this file asks of one drawn wall, in one page evaluation.
 *
 * The two type metrics are the load-bearing part and they are measured exactly
 * as the renderer measures them: a specimen planted in a real cell, so it
 * inherits the same cascade, read *untransformed* through `offsetWidth` and the
 * computed `font-size`. Both terms of each ratio being untransformed is what
 * makes the answer independent of any `scale()` above it — the same reason the
 * renderer reads them that way, and the reason this can be compared with what
 * the renderer decided rather than merely with itself.
 */
interface WallShape {
  readonly grids: readonly {
    readonly stamped: string;
    readonly innerW: number;
    readonly innerH: number;
    readonly chPx: number;
    readonly emPx: number;
    /** The most names any one cell has on the glass. */
    readonly maxNames: number;
    /** Cells with at least one name, and cells with a "+N" but no name. */
    readonly named: number;
    readonly countedButSilent: number;
    readonly weekdayHead: string;
    readonly times: number;
    readonly edges: number;
  }[];
  /** Every event name on the whole wall — the grid's and the agenda's. */
  readonly names: readonly string[];
  readonly agendaEvents: number;
  readonly agendaTier: string;
}

async function shapeOf(page: Page): Promise<WallShape> {
  return page.evaluate((specimen) => {
    const visible = (node: Element): boolean => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const inner = (node: HTMLElement): { w: number; h: number } => {
      const style = getComputedStyle(node);
      return {
        w: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        h: node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      };
    };
    const metrics = (host: HTMLElement, className: string): { chPx: number; emPx: number } => {
      const probe = document.createElement('span');
      probe.className = className;
      probe.textContent = specimen;
      probe.style.cssText =
        'position:absolute;visibility:hidden;display:inline-block;white-space:pre;max-height:none;overflow:visible;left:0;top:0';
      host.appendChild(probe);
      const emPx = parseFloat(getComputedStyle(probe).fontSize);
      const chPx = probe.offsetWidth / specimen.length;
      probe.remove();
      return { chPx, emPx };
    };

    const names: string[] = [];
    const grids = Array.from(document.querySelectorAll('#wall .horizon-text, #wall .horizon-swiss'))
      .filter((section): section is HTMLElement => section instanceof HTMLElement)
      .map((section) => {
        const cells = Array.from(section.querySelectorAll('.hz-cell')).filter(
          (cell): cell is HTMLElement => cell instanceof HTMLElement,
        );
        const first = cells[0];
        const box = first === undefined ? { w: 0, h: 0 } : inner(first);
        const type = first === undefined ? { chPx: 0, emPx: 0 } : metrics(first, 'hz-rowtext');
        let maxNames = 0;
        let named = 0;
        let countedButSilent = 0;
        for (const cell of cells) {
          const shown = Array.from(cell.querySelectorAll('.hz-row')).filter(visible);
          for (const row of shown) names.push(row.querySelector('.hz-rowtext')?.textContent ?? '');
          if (shown.length > maxNames) maxNames = shown.length;
          if (shown.length > 0) named += 1;
          const more = cell.querySelector('.hz-more');
          if (shown.length === 0 && more !== null && (more.textContent ?? '') !== '') {
            countedButSilent += 1;
          }
        }
        for (const bar of section.querySelectorAll('.hz-span')) {
          if (!visible(bar)) continue;
          const text = bar.querySelector('.hz-spantext');
          if (text !== null && visible(text)) names.push(text.textContent ?? '');
        }
        return {
          stamped: section.getAttribute('data-tier') ?? '',
          innerW: box.w,
          innerH: box.h,
          chPx: type.chPx,
          emPx: type.emPx,
          maxNames,
          named,
          countedButSilent,
          weekdayHead: section.querySelector('.hz-head')?.textContent ?? '',
          times: Array.from(section.querySelectorAll('.hz-rowtime')).filter(visible).length,
          edges: Array.from(section.querySelectorAll('.hz-edge')).filter(visible).length,
        };
      });

    const agenda = document.querySelector('#wall .canvas section.next');
    const entries = agenda === null ? [] : Array.from(agenda.querySelectorAll('.dr-ev')).filter(visible);
    for (const entry of entries) names.push(entry.querySelector('.dr-ev-title')?.textContent ?? '');
    const agendaBox = agenda?.closest('[data-widget-id]');
    return {
      grids,
      names: names.filter((name) => name.trim() !== ''),
      agendaEvents: entries.length,
      agendaTier: agendaBox?.getAttribute('data-tier') ?? '',
    };
  }, TYPE_SPECIMEN);
}

async function drawWall(
  size: { readonly width: number; readonly height: number },
): Promise<WallShape> {
  const { page, close } = await loadWallSettled(link, size);
  try {
    return await shapeOf(page);
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------------ */

describe('a small panel says its events somewhere', () => {
  /*
   * The demotion rule, measured on the whole wall rather than on the grid.
   *
   * A 7.5" e-ink panel's month cell is under five characters wide, so the grid
   * names nothing — which is the honest answer and is what the wall already
   * drew there. What this asserts is that the household's events are *on the
   * wall* anyway, in the widget that has room for them, because a wall that
   * names nothing anywhere is the failure and a grid that names nothing is not.
   */
  for (const size of [
    { width: 800, height: 480 },
    { width: 480, height: 800 },
  ] as const) {
    it(
      `${size.width}x${size.height}: names at least six events across the whole wall`,
      async () => {
        measureScreen('eink-7.5', size.width > size.height ? 0 : 90);
        canvasOf([
          { type: 'calendar', x: 0.03, y: 0.24, w: 0.52, h: 0.72, config: { mode: 'list' } },
          { type: 'calendar', x: 0.57, y: 0.24, w: 0.4, h: 0.72, config: { mode: 'month' } },
        ]);
        const shape = await drawWall(size);
        expect(shape.grids.length, 'no month grid was drawn to measure').toBe(1);
        expect(
          shape.grids[0]?.stamped,
          'the month grid on a 7.5" panel is not the tier this measurement is about',
        ).toBe('M0');
        expect(
          shape.names.length,
          `the wall named ${shape.names.length} events: ${shape.names.join(', ')}`,
        ).toBeGreaterThanOrEqual(6);
      },
      SLOW,
    );
  }
});

describe('the tier a box resolves to', () => {
  /*
   * The table, checked against the measured box at every size this project
   * measures — and re-derived here rather than read off the section.
   *
   * `data-tier` is what the renderer decided and is used only as the thing
   * under test: the expectation is computed from the cell's own inner box and
   * its own type through `tierFor`, which is the panel's copy of the table.
   * A renderer that stamped a rung it did not draw at, or read the table with
   * the wrong units, fails here — where an assertion on the attribute alone
   * would agree with any answer the renderer gave itself.
   */
  for (const size of [
    { width: 480, height: 800 },
    { width: 800, height: 480 },
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ] as const) {
    it(
      `${size.width}x${size.height}: is the one the table gives for the box it drew`,
      async () => {
        measureScreen(undefined);
        canvasOf([{ type: 'calendar', x: 0.02, y: 0.02, w: 0.96, h: 0.96, config: { mode: 'month' } }]);
        const shape = await drawWall(size);
        const grid = shape.grids[0];
        expect(grid, 'no month grid was drawn to measure').toBeDefined();
        if (grid === undefined) return;

        const expected = tierFor(grid.innerW, grid.innerH, grid.chPx, grid.emPx);
        expect(
          grid.stamped,
          `a ${grid.innerW.toFixed(1)}x${grid.innerH.toFixed(1)}px cell at ${grid.chPx.toFixed(2)}ch/${grid.emPx.toFixed(2)}em ` +
            `is ${(grid.innerW / grid.chPx).toFixed(2)}ch x ${(grid.innerH / grid.emPx).toFixed(2)}em, which the table calls ${expected.tier}`,
        ).toBe(expected.tier);

        // And what it drew is what that rung permits, which is the half the
        // attribute cannot vouch for. A cell may draw fewer names than the
        // tier allows — its day may hold fewer events — but never more.
        expect(
          grid.maxNames,
          `${expected.tier} allows ${namesAt(expected, grid.innerH, grid.emPx)} names and a cell drew ${grid.maxNames}`,
        ).toBeLessThanOrEqual(namesAt(expected, grid.innerH, grid.emPx));

        // The weekday head, which is the one part of the form a cell's own
        // contents cannot change: one letter, three, or the whole word.
        const head = grid.weekdayHead.trim();
        const letters = expected.weekdayLetters;
        if (letters > 0) {
          expect(head.length, `${expected.tier} asks for ${letters} letters and drew "${head}"`).toBeLessThanOrEqual(letters);
        } else {
          expect(head.length, `${expected.tier} asks for the whole word and drew "${head}"`).toBeGreaterThan(3);
        }

        // Times are M4's alone: a clock beside a name in a cell that has no
        // room for the name is the inversion this whole scale exists to end.
        if (!expected.times) {
          expect(grid.times, `${expected.tier} drew ${grid.times} times beside its names`).toBe(0);
        }

        // And the colour rule at the cell's edge belongs to the tier with no
        // row to put a colour on, and to no other.
        if (expected.allDay === 'edge') {
          expect(grid.edges, 'M0 drew no all-day colour at any cell edge').toBeGreaterThan(0);
        } else {
          expect(grid.edges, `${expected.tier} drew an edge rule it has a row for`).toBe(0);
        }
      },
      SLOW,
    );
  }
});

describe('a box with more room shows more things', () => {
  /*
   * The sentence this whole phase is named for, as an experiment: the same
   * wall, the same calendars, the same viewport, and the widget's *area*
   * doubled. Everything else is held still, so the only thing that can move
   * the count is the box.
   *
   * Doubling the area rather than one edge, because a tier is two thresholds
   * and stepping one dimension can leave the other binding — which is the
   * table's own rule ("a tall narrow column is as much M1 as a short wide
   * one") and would make a one-edge experiment prove nothing about the ladder.
   *
   * The top rung is excluded by the brief and by the arithmetic: at M4 there is
   * no rung above and the count is bounded by what the household's calendars
   * actually hold, so a strict increase there would be an assertion about the
   * fixture rather than about the renderer.
   */
  const SIZE = { width: 1920, height: 1080 } as const;
  const GROW = Math.SQRT2;

  async function drawAt(view: string, w: number, h: number): Promise<WallShape> {
    canvasOf([
      {
        type: 'calendar',
        x: 0.02,
        y: 0.02,
        w: Math.min(0.96, w),
        h: Math.min(0.96, h),
        config: { mode: view },
      },
    ]);
    return drawWall(SIZE);
  }

  it(
    'names more in a month grid at every rung below the top',
    async () => {
      measureScreen(undefined);
      const steps: { w: number; h: number }[] = [];
      for (let w = 0.17, h = 0.17; w < 0.96 && h < 0.96; w *= GROW, h *= GROW) steps.push({ w, h });

      const seen: { tier: string; names: number; w: number; h: number }[] = [];
      for (const step of steps) {
        const shape = await drawAt('month', step.w, step.h);
        const grid = shape.grids[0];
        if (grid === undefined) continue;
        seen.push({ tier: grid.stamped, names: grid.maxNames, w: step.w, h: step.h });
      }
      expect(seen.length, 'no wall was drawn to compare').toBeGreaterThan(2);

      /*
       * Compared rung by rung rather than step by step: two boxes on the same
       * rung *should* draw the same, which is what a tier is, and asserting a
       * rise between them would be asserting that the tier does not work.
       */
      const best = new Map<string, number>();
      for (const step of seen) best.set(step.tier, Math.max(best.get(step.tier) ?? 0, step.names));
      const rungs = CALENDAR_TIERS.map((tier) => tier.tier).filter((tier) => best.has(tier));
      expect(
        rungs.length,
        `every box landed on one rung (${seen.map((s) => `${s.tier}:${s.names}`).join(' ')}), so nothing was compared`,
      ).toBeGreaterThan(1);
      for (let index = 1; index < rungs.length; index++) {
        const lower = rungs[index - 1] as string;
        const upper = rungs[index] as string;
        if (upper === 'M4') break;
        expect(
          best.get(upper) ?? 0,
          `${upper} named ${best.get(upper)} where ${lower} named ${best.get(lower)} — ` +
            `a bigger box drew no more (${seen.map((s) => `${s.tier}:${s.names}`).join(' ')})`,
        ).toBeGreaterThan(best.get(lower) ?? 0);
      }
    },
    SLOW,
  );

  it(
    'shows more events in an agenda when its box doubles',
    async () => {
      /*
       * No `count` in the config, deliberately: the household's own cap still
       * binds and Classic asks for six, so a Classic agenda draws six at every
       * size it always did. What the tier changes is what happens when nobody
       * has said — which is the default, and is where "more room shows more"
       * has to be true or the mechanism does not exist.
       */
      measureScreen(undefined);
      const small = await drawAt('list', 0.3, 0.24);
      const large = await drawAt('list', 0.3 * GROW, 0.24 * GROW);
      expect(
        large.agendaEvents,
        `a box of twice the area drew ${large.agendaEvents} events against ${small.agendaEvents}`,
      ).toBeGreaterThan(small.agendaEvents);
    },
    SLOW,
  );
});

describe('what the grid says when it can say nothing', () => {
  it(
    'never draws a count in a cell that names nothing',
    async () => {
      /*
       * Carried over whole from `trimCellRows`, whose third recorded fault this
       * is: today's cell drew "+6" and none of its six events, with nothing
       * overflowing, every measurement passing and every counter truthful. What
       * a measurement of this grid has to check is that something is *shown* —
       * not that nothing spilled — and that is a different assertion from every
       * other one in this file, which is why it has its own.
       *
       * Measured across a range of month boxes rather than one, so a tier that
       * reintroduced it at a size nobody chose still fails.
       */
      measureScreen(undefined);
      for (const [w, h] of [
        [0.2, 0.16],
        [0.3, 0.24],
        [0.5, 0.4],
        [0.96, 0.96],
      ] as const) {
        canvasOf([{ type: 'calendar', x: 0.02, y: 0.02, w, h, config: { mode: 'month' } }]);
        const shape = await drawWall({ width: 1920, height: 1080 });
        const grid = shape.grids[0];
        expect(grid, `no grid at ${w}x${h}`).toBeDefined();
        expect(
          grid?.countedButSilent,
          `at ${w}x${h} of the canvas, ${grid?.countedButSilent} cells drew a "+N" and not one of the events it counts`,
        ).toBe(0);
      }
    },
    SLOW,
  );

  it(
    'gives its names to the agenda beside it, and takes the promotion back',
    async () => {
      /*
       * The promotion, and the half that makes it a *drawing* decision: it has
       * to go away again. A month grid too narrow to name anything hands its
       * attention to the agendas on the same canvas; widen the month and the
       * agenda goes back to the rung its own box affords, with nothing written
       * to the canvas in either direction.
       *
       * Asserted as the tier the agenda resolved rather than as a count,
       * because the count is `min(what the household asked for, what the box
       * affords)` and a household cap would hide the mechanism entirely — which
       * is exactly what Classic's own `count: 6` does, and is why this builds
       * its own arrangement instead of measuring Classic.
       */
      /*
       * A *measured* wall, because that is where an agenda's tier is most
       * clearly below the top: the type in the box is the size the reader needs
       * and the box measures a real number of ems of it.
       *
       * (History, and worth keeping because the limit moved: on a wall nobody
       * had measured, `fitToBox` grew the section freely and every agenda came
       * out M4 — the promotion resolved and had no rung left to move to.
       * Nothing grows now, so the tier binds on every wall and this test would
       * work on either; it stays on the measured one because that is the wall
       * whose angle the rest of the file is about.)
       */
      measureScreen('tv-32', 0);
      const size = { width: 1920, height: 1080 } as const;

      canvasOf([
        { type: 'calendar', x: 0.02, y: 0.05, w: 0.3, h: 0.16, config: { mode: 'list' } },
        { type: 'calendar', x: 0.34, y: 0.05, w: 0.08, h: 0.9, config: { mode: 'month' } },
      ]);
      const narrow = await drawWall(size);
      expect(narrow.grids[0]?.stamped, 'the narrow month was not at the rung that promotes').toBe('M0');

      canvasOf([
        { type: 'calendar', x: 0.02, y: 0.05, w: 0.3, h: 0.16, config: { mode: 'list' } },
        { type: 'calendar', x: 0.34, y: 0.05, w: 0.6, h: 0.9, config: { mode: 'month' } },
      ]);
      const wide = await drawWall(size);
      const w = wide.grids[0];
      expect(
        w?.stamped,
        `the wide month still names nothing: ${w?.innerW.toFixed(1)}x${w?.innerH.toFixed(1)}px ` +
          `at ${w?.chPx.toFixed(2)}ch/${w?.emPx.toFixed(2)}em`,
      ).not.toBe('M0');

      const rung = (name: string): number =>
        CALENDAR_TIERS.findIndex((tier) => tier.tier === name);
      expect(
        rung(narrow.agendaTier),
        `the agenda drew at ${narrow.agendaTier} beside a month that names nothing, ` +
          `and at ${wide.agendaTier} beside one that does — the promotion is not reaching it`,
      ).toBeGreaterThan(rung(wide.agendaTier));

      // …and nothing was written down. The stored canvas is the one this test
      // put there, which is what makes the paragraph above true rather than a
      // hope: a promotion saved to the row would survive the month widening.
      const stored = wall.db
        .prepare(
          "SELECT config FROM layout_widgets WHERE screen_id = ? AND orientation = 'landscape' ORDER BY z",
        )
        .all(screenId) as { config: string | null }[];
      for (const row of stored) {
        expect(row.config ?? '{}', 'the renderer wrote a tier back to the household’s canvas')
          .not.toContain('tier');
      }
    },
    SLOW,
  );
});

describe('the editor says which tier, from the frame it drew', () => {
  it(
    'reads the rung back out of the live preview',
    async () => {
      /*
       * The inspector's note is a read-back and not a prediction — the same
       * seam the ladder's strike-through uses, and for the same reason: two
       * opinions about what fits is the whole class of bug this project keeps
       * finding, and one with a rung's name on it would be that bug wearing a
       * label. So this drives the real editor and holds the sentence it shows
       * against the rung the *preview* stamped.
       */
      measureScreen(undefined);
      canvasOf([{ type: 'calendar', x: 0.02, y: 0.02, w: 0.96, h: 0.96, config: { mode: 'month' } }]);
      const context = await (await browser()).newContext({ viewport: { width: 1400, height: 1000 } });
      const editor: Page = await context.newPage();
      try {
        await wall.signIn(editor);
        await editor.goto(`${wall.base}/admin/walls/${screenId}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.click('.le-orient-btn:has-text("Portrait")');
        await editor.waitForTimeout(400);
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.waitForSelector('.le-density', { timeout: 20_000 });

        const said = (await editor.locator('.le-density').first().textContent()) ?? '';
        const stamped = await editor.evaluate(() => {
          const host = document.querySelector('.le-preview');
          const root = host instanceof HTMLElement ? host.shadowRoot : null;
          return root?.querySelector('[data-tier]')?.getAttribute('data-tier') ?? '';
        });
        expect(stamped, 'the preview drew no tier for the note to read').not.toBe('');
        expect(said, `the note says "${said}" over a preview drawing ${stamped}`).toContain(
          `, ${stamped}, `,
        );
        expect(said, 'the note names no view').toContain('Month grid');
      } finally {
        await editor.close();
        await context.close();
      }
    },
    SLOW,
  );
});

describe('a paired wall still settles', () => {
  it(
    'draws the same tier twice on the same wall',
    async () => {
      /*
       * A tier decided from measured text has the font race's hazard, and this
       * project has already paid for it once: `fitToBox` measured a section
       * against fallback metrics and kept the arithmetic, which showed up as a
       * flake nobody believed. Nothing is kept now, but a tier is still read
       * from a measured advance, so the settle is still what makes an answer
       * repeatable. `loadWallSettled` is what holds the first
       * manifest back, and this is what says the settled answer is stable —
       * two loads of the identical wall, one rung.
       */
      measureScreen('tv-32', 90);
      canvasOf([{ type: 'calendar', x: 0.02, y: 0.02, w: 0.96, h: 0.96, config: { mode: 'month' } }]);
      const size = { width: 1080, height: 1920 } as const;
      const first = await drawWall(size);
      const second = await drawWall(size);
      expect(second.grids[0]?.stamped).toBe(first.grids[0]?.stamped);
      expect(second.grids[0]?.named).toBe(first.grids[0]?.named);
    },
    SLOW,
  );
});
