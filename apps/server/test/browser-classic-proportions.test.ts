/**
 * The default wall's proportions, measured on a real wall.
 *
 * Classic used to give the month 45% of the portrait height and the whole
 * right-hand column in landscape, and the agenda 20% and 7.8%. That is the most
 * space to the view that reads worst and the least to the one that reads best,
 * and the numbers are not close: measured on a paired wall carrying three
 * ordinary family calendars, a rota and a forecast, **17 of the agenda's 28 text
 * runs sat below the 22px legibility floor** in portrait — "Upcoming" at 15.0px,
 * the rota chip at 13.8px — and 19 of 21 in landscape, where three event titles
 * were cut to 35%, 38% and 44% of their strings.
 *
 * The mechanism, because it explains why only the template can fix it: every
 * widget reusing a section from the stacked layout is `transform: scale()`d to
 * fill its box, and a transform multiplies straight through
 * `max(…, var(--t-floor))`. The floor does not survive scale-to-fit. The month
 * grid fills its box rather than being scaled, so it is the one widget that
 * *cannot* fall below the floor — which is why it looked fine at any size while
 * everything beside it quietly did not.
 *
 * So this file measures five things, all in a real browser against computed
 * geometry and computed font sizes — never against class names, because this
 * project has shipped a bug where the class was right and the pixels were wrong:
 *
 *  1. a display created through the real admin route is seeded with the new
 *     proportions, in both orientations;
 *  2. a wall that already arranged its own canvas is byte-identical across the
 *     boot backfill — this changes the seed for new canvases and nothing else;
 *  3. the agenda's drawn area exceeds the month's in landscape;
 *  4. every run in the portrait agenda clears the 22px floor, and no landscape
 *     title is cut;
 *  5. the portrait month still paints its calendars' colours — which is the
 *     floor the portrait rebalance deliberately stops at, and the assertion that
 *     turns red on anybody who later "finishes the job" by shrinking it further.
 *
 * (4) is the reason for the change and (5) is its limit. They pull in opposite
 * directions on purpose: between them there is one band of month heights that
 * satisfies both, and this file is what found it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEARDOWN,
  equipHousehold,
  HOUSEHOLD_CALENDARS,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { backfillClassic } from '../src/api/templates.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { householdSetUp } from '../src/modules/index.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and several walls. */
const SLOW = 180_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  // `pairLink` is the real `POST /admin/screens`, which is where a new display
  // is seeded with Classic — so this exercises the seed rather than asserting
  // on the constant.
  link = await wall.pairLink('Kitchen');
  screenId = (wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }).id;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Run {
  readonly where: string;
  readonly text: string;
  readonly font: number;
  readonly fit: number;
  readonly cut: boolean;
}

interface Box {
  readonly kind: string;
  readonly w: number;
  readonly h: number;
  readonly area: number;
  readonly runs: readonly Run[];
}

/**
 * Draw the paired wall at one size and measure every widget box on it.
 *
 * The reload is not ceremony. `fitToBox` and `trimCellRows` measure once,
 * synchronously, as their section is appended, and nothing re-runs them — so on
 * a cold context whose web fonts have not arrived the wall settles on a fit
 * computed against fallback metrics and keeps it. Measured, that makes the same
 * geometry report anything from 2 to 13 named month cells across runs. The
 * second load has the fonts in the HTTP cache, which is the steady state a wall
 * that has been hanging for a while is actually in, and it is repeatable.
 */
async function measureWallBoxes(size: { readonly width: number; readonly height: number }): Promise<{
  readonly canvas: { readonly w: number; readonly h: number };
  readonly boxes: readonly Box[];
  readonly monthColours: readonly string[];
}> {
  const { page, close } = await loadWallSettled(link, size);
  try {
    return await page.evaluate(() => {
      const canvas = document.querySelector('.canvas') as HTMLElement;
      const canvasRect = canvas.getBoundingClientRect();

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

      const runsIn = (root: Element) => {
        const out: { where: string; text: string; font: number; fit: number; cut: boolean }[] = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const seen = new Set<Element>();
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if ((node.nodeValue ?? '').trim() === '') continue;
          const element = node.parentElement;
          if (element === null || seen.has(element)) continue;
          seen.add(element);
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          /*
           * Half a line of slack down, a pixel across. A block whose
           * `line-height` is under 1 reports a `scrollHeight` past its
           * `clientHeight` by the leading alone with nothing hidden; text can
           * only be lost a line at a time, so half a line is the bar.
           */
          const lineHeight = parseFloat(style.lineHeight);
          const slack = Number.isFinite(lineHeight) ? Math.max(1, lineHeight / 2) : 1;
          const needed = Math.max(element.scrollWidth, element.clientWidth);
          out.push({
            where: String(element.className).trim().split(/\s+/)[0] ?? element.tagName,
            text: (element.textContent ?? '').trim().slice(0, 60),
            font: parseFloat(style.fontSize) * scaleOf(element),
            fit: needed > 0 ? Math.min(1, element.clientWidth / needed) : 1,
            cut:
              element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + slack,
          });
        }
        return out;
      };

      /*
       * Every place a calendar's own colour reaches the glass inside the month
       * grid: the dot ahead of a timed event, and the rule down the left of an
       * all-day row, which has no dot because the words get that column. Read
       * from the computed paint, not from the class — a row the trim has hidden
       * still carries its class and paints nothing.
       */
      const monthColours: string[] = [];
      document.querySelectorAll('.horizon .hz-rowdot, .horizon .hz-row.allday').forEach((node) => {
        const element = node as HTMLElement;
        if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') return;
        const style = getComputedStyle(element);
        monthColours.push(
          element.classList.contains('hz-rowdot') ? style.backgroundColor : style.borderLeftColor,
        );
      });

      const boxes = Array.from(document.querySelectorAll('.fw')).map((element) => {
        const box = element as HTMLElement;
        const rect = box.getBoundingClientRect();
        /*
         * Which of the two calendar widgets this is, read from what it actually
         * drew rather than from its stored config — the agenda is the `next`
         * section and the month is the `horizon` grid, and a widget that fell
         * through to the wrong renderer is exactly the bug worth catching here.
         */
        const inner = box.querySelector('.next, .horizon');
        const kind = box.classList.contains('fw-calendar')
          ? inner !== null && String(inner.className).split(/\s+/)[0] === 'next'
            ? 'agenda'
            : 'month'
          : (Array.from(box.classList).find((c) => c.startsWith('fw-') && c !== 'fw-fill')?.slice(3) ?? '?');
        return {
          kind,
          w: rect.width,
          h: rect.height,
          area: rect.width * rect.height,
          runs: runsIn(box),
        };
      });
      return { canvas: { w: canvasRect.width, h: canvasRect.height }, boxes, monthColours };
    });
  } finally {
    await close();
  }
}

/** Everything a failure needs to be actionable: the words, and how small. */
const describeRuns = (runs: readonly Run[]): string =>
  runs
    .slice()
    .sort((a, b) => a.font - b.font)
    .slice(0, 6)
    .map((run) => `  "${run.text}" (${run.where}) at ${run.font.toFixed(1)}px, ${Math.round(run.fit * 100)}% shown`)
    .join('\n');

describe('the Classic seed', () => {
  it('seeds a new display with the rebalanced proportions', () => {
    // A second display, created through the same admin route a household uses.
    const before = new Set((wall.db.prepare('SELECT id FROM screens').all() as { id: string }[]).map((r) => r.id));
    return wall.pairLink('Hall').then(() => {
      const hall = (wall.db.prepare('SELECT id FROM screens').all() as { id: string }[])
        .map((r) => r.id)
        .find((id) => !before.has(id));
      expect(hall, 'the admin route created a display').toBeDefined();

      const areas: Record<string, { agenda: number; month: number }> = {};
      for (const orientation of ['portrait', 'landscape'] as const) {
        const widgets = readLayoutWidgets(wall.db, hall!, orientation);
        const calendars = widgets.filter((widget) => widget.type === 'calendar');
        const agenda = calendars.find((widget) => (widget.config as { mode?: string } | undefined)?.mode === 'list');
        const month = calendars.find((widget) => (widget.config as { mode?: string } | undefined)?.mode !== 'list');
        expect(agenda, `${orientation} agenda`).toBeDefined();
        expect(month, `${orientation} month`).toBeDefined();
        // Area, not height: in landscape the two are columns rather than rows,
        // so height alone would say nothing about which is the anchor.
        areas[orientation] = { agenda: agenda!.w * agenda!.h, month: month!.w * month!.h };
      }

      // Landscape inverts outright: the agenda is the larger of the two.
      expect(
        areas['landscape']!.agenda,
        `landscape: agenda ${areas['landscape']!.agenda.toFixed(3)} vs month ${areas['landscape']!.month.toFixed(3)}`,
      ).toBeGreaterThan(areas['landscape']!.month);

      /*
       * Portrait stops at a peer rather than an anchor, so the claim here is
       * about the agenda's own size rather than about which box is bigger.
       *
       * 0.30 is not a taste: it is the height at which the agenda's smallest
       * run reaches the 22px floor, measured — at 0.30 the rota chip lands at
       * 21.7px and at 0.305 it lands at 22.5px. So this and the rendered floor
       * assertion are the same claim from two sides, and either one alone would
       * let a well-meaning tidy-up of the seed through. The shipped seed was
       * 0.20, so a revert fails it by a wide margin.
       */
      const portrait = readLayoutWidgets(wall.db, hall!, 'portrait')
        .filter((widget) => widget.type === 'calendar')
        .find((widget) => (widget.config as { mode?: string } | undefined)?.mode === 'list');
      expect(
        portrait!.h,
        `portrait: the agenda is ${portrait!.h} of the wall's height, below the 0.30 its type needs`,
      ).toBeGreaterThanOrEqual(0.3);
    });
  }, SLOW);

  it('leaves a wall that arranged its own canvas byte-identical', () => {
    /*
     * The hard constraint: this changes the seed for *new* canvases only.
     *
     * A household who dragged their own wall into shape must not find it
     * rearranged by an upgrade, so the check is byte-identity of the stored
     * rows across the boot backfill — not "it still has widgets", which every
     * re-seed would also satisfy. Run twice: once with the one-shot flag set
     * (the state every upgraded database is in), and once with it cleared,
     * because an arranged canvas has to survive even the run that is allowed
     * to seed.
     */
    const dump = (): string =>
      JSON.stringify(
        wall.db.prepare('SELECT * FROM layout_widgets ORDER BY screen_id, orientation, id').all(),
      );

    /*
     * And a wall the household *cleared* stays cleared, which is the case the
     * one-shot flag exists for — the emptiness check cannot protect it, because
     * an empty canvas is exactly what the backfill is looking for.
     */
    const emptied = 'emptied-wall';
    const at = Date.now();
    wall.db
      .prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(emptied, 'Spare', `hash-${emptied}`, at, at, at);

    const before = dump();
    backfillClassic(wall.db, householdSetUp(wall.db));
    expect(dump(), 'with the flag set the backfill writes nothing at all').toBe(before);
    expect(readLayoutWidgets(wall.db, emptied, 'portrait'), 'a cleared wall stays cleared').toHaveLength(0);

    wall.db.prepare(`UPDATE household_settings SET layout_backfilled = 0 WHERE id = 'singleton'`).run();
    backfillClassic(wall.db, householdSetUp(wall.db));
    const arranged = JSON.parse(dump()) as { screen_id: string | null }[];
    expect(
      JSON.stringify(arranged.filter((row) => row.screen_id !== emptied)),
      'an arranged canvas is untouched even by a run that is allowed to seed',
    ).toBe(before);
    expect(
      (wall.db.prepare(`SELECT layout_backfilled AS f FROM household_settings WHERE id = 'singleton'`).get() as { f: number }).f,
      'the one-shot flag is set again',
    ).toBe(1);
  });
});

describe('the Classic wall, drawn', () => {
  it(
    'draws the agenda larger than the month in landscape',
    async () => {
      /*
       * Landscape only, and the asymmetry is measured rather than an oversight.
       * A landscape wall has width to spare, so the agenda can take the larger
       * column and the month still keeps the cell *height* it needs to name and
       * colour its events. Portrait has no such slack — see the colour test
       * below, which is the floor portrait stops at.
       */
      const { boxes } = await measureWallBoxes({ width: 1920, height: 1080 });
      const agenda = boxes.find((box) => box.kind === 'agenda');
      const month = boxes.find((box) => box.kind === 'month');
      expect(agenda, 'an agenda is drawn').toBeDefined();
      expect(month, 'a month is drawn').toBeDefined();
      expect(
        agenda!.area,
        `the agenda is drawn at ${Math.round(agenda!.w)}x${Math.round(agenda!.h)} and the month at ` +
          `${Math.round(month!.w)}x${Math.round(month!.h)} — the agenda should be the anchor`,
      ).toBeGreaterThan(month!.area);
    },
    SLOW,
  );

  it(
    'draws every word of the portrait agenda at or above the legibility floor',
    async () => {
      /*
       * The assertion this whole change exists for, and the one that bites.
       *
       * The floor is a CSS clamp that `transform: scale()` multiplies straight
       * through, so a scaled section can be drawn under it with nothing in the
       * stylesheet to complain and nothing clipped to look at. At the height
       * this layout used to have, 17 of these 28 runs were under it — the
       * smallest at 13.8px on a wall read from five to ten feet.
       */
      const { boxes } = await measureWallBoxes({ width: 1080, height: 1920 });
      const agenda = boxes.find((box) => box.kind === 'agenda');
      expect(agenda).toBeDefined();
      expect(agenda!.runs.length, 'the agenda drew some words').toBeGreaterThan(8);

      const under = agenda!.runs.filter((run) => run.font < FLOOR_PX);
      expect(
        under.length,
        `${under.length} of ${agenda!.runs.length} runs in the agenda are below the ${FLOOR_PX}px floor:\n` +
          describeRuns(under),
      ).toBe(0);
    },
    SLOW,
  );

  it(
    'keeps the calendars\u2019 own colours on the portrait month grid',
    async () => {
      /*
       * The floor the portrait rebalance stops at, and the reason it does not
       * simply keep going.
       *
       * A month cell paints a calendar's colour only on an event *row* — a dot
       * on a timed one, a rule down an all-day one. Below about 0.38 of the
       * portrait height there is no room for a row under the date number, so
       * every busy cell collapses to a date and a "+N" and the grid stops
       * saying *whose* day is busy, which is most of what a family wall is for.
       * Measured, a household with a rota loses all three of its colours at
       * 0.35 and 0.36 and keeps them at 0.38 — deterministically, three runs
       * each way — and this household has a rota, so it is that harder case.
       *
       * Asserted on the computed paint rather than on the row's class: a row
       * the trim pass has hidden still carries every class it was built with
       * and puts no colour on the glass. That distinction is this repository's
       * oldest measurement lesson and it is exactly the failure being guarded.
       */
      const { monthColours } = await measureWallBoxes({ width: 1080, height: 1920 });

      const hex = (colour: string): string => {
        const parsed = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
        if (parsed === null) return colour;
        return (
          '#' +
          [1, 2, 3].map((index) => Number(parsed[index]).toString(16).padStart(2, '0')).join('').toUpperCase()
        );
      };
      const stored = new Set(
        (wall.db.prepare('SELECT color FROM calendar_sources').all() as { color: string }[]).map((row) =>
          row.color.toUpperCase(),
        ),
      );
      const drawn = new Set(monthColours.map(hex));

      expect(
        monthColours.length,
        'the portrait month grid painted no calendar colour at all — its cells have no room for a row',
      ).toBeGreaterThan(0);
      /*
       * Every colour on the glass is one of the household's. Deliberately not
       * "all three of them": which calendars keep a row is a fact about which
       * days this fixture fills and which of them the rota shades, not about
       * the height — and the height is what this asserts. The number that
       * matters is the one above, because the failure being guarded takes it to
       * exactly zero. `browser-source-colours.test.ts` makes the stronger claim
       * about all three, on a household with no rota.
       */
      for (const colour of drawn) {
        expect(stored.has(colour), `the month painted ${colour}, which is no calendar's colour`).toBe(true);
      }
    },
    SLOW,
  );

  it(
    'cuts no event title out of the landscape agenda',
    async () => {
      /*
       * Landscape's own fault, and a different one. Stacked at the foot of a
       * 26%-wide column, the agenda drew "Swimming lesson" as 35% of itself —
       * and a truncation that deep is not a shortened title, it is a different
       * string. Nothing here asserts a font size: landscape's scale factor is
       * pinned at 1.0 by the section's own width, so its type is a fact about
       * the canvas rather than about this box, and asserting on it would be
       * asserting on something no template can move.
       */
      const { boxes } = await measureWallBoxes({ width: 1920, height: 1080 });
      const agenda = boxes.find((box) => box.kind === 'agenda');
      expect(agenda).toBeDefined();

      const titles = agenda!.runs.filter((run) => run.where === 'dr-ev-title');
      expect(titles.length, 'the agenda drew some event titles').toBeGreaterThan(3);

      const cut = titles.filter((run) => run.cut);
      expect(cut.length, `${cut.length} landscape agenda titles are cut off:\n${describeRuns(cut)}`).toBe(0);
    },
    SLOW,
  );
});
