/**
 * The default wall's proportions, measured on a real wall.
 *
 * Classic used to lose a third of itself to whitespace it did not need. Three
 * separate losses, all measured: an **inter-widget gutter** of 13.5–19.5% of the
 * canvas, because every box carried a 5% side margin *and* there was a gap
 * between boxes *and* the `.fw` padding every box already has; **intra-box
 * slack**, a shift badge floating in the middle of a box twice its size, left
 * over from `fitToBox`'s centred scale; and a **letterbox** of up to 6.3% on a
 * panel whose aspect did not match Classic's nominal 9:16 or 16:9. Measured, the
 * canvas carried 63.6% content at 1080x1920 and 66.2% at 1920x1080.
 *
 * All three are closed, and this file is the measurement that closes them:
 *
 *  - **The rectangles tile the canvas.** They share edges and reach the canvas
 *    edge, so the only gutter is the space between two boxes' *content* — twice
 *    the `.fw` padding, and nothing else. The stored boxes now cover the whole
 *    canvas, and the drawn content covers upwards of 80% of it in both
 *    orientations.
 *  - **The proportions were re-derived against the density tiers**, not against
 *    scale-to-fit and a 22px absolute floor, both of which are gone (`fitToBox`
 *    is deleted; the calendar reads the reader's own angle and each widget takes
 *    a *form* from its box). The split between the agenda and the month is now a
 *    fact about two tier decisions: the agenda keeps the height at which its
 *    smallest run clears the 22px floor on a wall nobody has measured (0.33 of
 *    the portrait height), and the month keeps enough to paint a colour in every
 *    busy cell (0.48). The old 0.38 colour cliff no longer binds — the numeral is
 *    demoted and the type is distance-derived — so the month at 0.48 clears it
 *    with room over.
 *  - **A screen whose panel facts are set is seeded at its panel's own aspect**
 *    (`classicSeed`), so there is no letterbox to lose a band to. Only at seed
 *    time, and never over an arrangement.
 *
 * So this file measures, all in a real browser against computed geometry and
 * computed font sizes — never against class names, because this project has
 * shipped a bug where the class was right and the pixels were wrong:
 *
 *  1. a display created through the real admin route is seeded with the tiled,
 *     tier-derived proportions, in both orientations;
 *  2. a wall that already arranged its own canvas is byte-identical across the
 *     boot backfill *and* the boot re-seed — this changes the seed for new
 *     canvases and nothing else, even the panel-aspect re-seed;
 *  3. a screen with no panel facts is seeded exactly as before;
 *  4. the agenda's drawn area exceeds the month's in landscape;
 *  5. every run in the portrait agenda clears the 22px floor, and no landscape
 *     title is cut;
 *  6. the portrait month still paints its calendars' colours — the floor the
 *     portrait split deliberately stops at;
 *  7. the drawn content covers at least 78% of the canvas in both orientations;
 *  8. a canvas seeded at a known panel's aspect fills the viewport;
 *  9. every widget box's content fills its box — the calendars to the reader's
 *     edge, and no box left the fitToBox dead band behind.
 *
 * (5) is the reason for the split and (6) is its limit. They pull in opposite
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
import { backfillClassic, panelCanvasAspects, reseedClassicForSetUp } from '../src/api/templates.js';
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { householdSetUp } from '../src/modules/index.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and several walls. */
const SLOW = 180_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

/** The 7.5" e-ink panel this file seeds a panel-aspect wall for (mm). */
const EINK_75 = { widthMm: 163, heightMm: 98, distanceMm: 600 } as const;

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  // `pairLink` is the real `POST /admin/screens`, which is where a new display
  // is seeded with Classic — so this exercises the seed rather than asserting
  // on the constant.
  link = await wall.pairLink('Kitchen');
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
  /** The painted content's bounding box, as a fraction of the box's own area. */
  readonly fill: number;
  /** The painted content's span on each axis, as a fraction of the box. */
  readonly fillW: number;
  readonly fillH: number;
  readonly runs: readonly Run[];
}

/**
 * Draw the paired wall at one size and measure every widget box on it.
 *
 * The settle (`loadWallSettled`) is not ceremony. `applyMonthTier` and the widget
 * tier pass measure once, synchronously, as their section is appended, and
 * nothing re-runs them — so on a cold context whose web fonts have not arrived
 * the wall settles on a form computed against fallback metrics and keeps it. The
 * second load has the fonts in the HTTP cache, which is the steady state a wall
 * that has been hanging for a while is actually in, and it is repeatable.
 */
async function measureWallBoxes(size: { readonly width: number; readonly height: number }): Promise<{
  readonly canvas: { readonly w: number; readonly h: number };
  readonly boxes: readonly Box[];
  readonly monthColours: readonly string[];
  /** The union of every box's painted content, as a fraction of the canvas. */
  readonly contentShare: number;
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

      /**
       * Whether an element puts ink on the glass: text, an image, a filled
       * background, or a visible border. A transparent wrapper that merely holds
       * its children is *not* ink — measuring one as filled is exactly how a
       * centred badge in a stretched container reads as full when it is not.
       */
      const paints = (element: Element): boolean => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const tag = element.tagName.toLowerCase();
        if (tag === 'img' || tag === 'svg' || tag === 'canvas') return true;
        for (const node of Array.from(element.childNodes)) {
          if (node.nodeType === 3 && (node.nodeValue ?? '').trim() !== '') return true;
        }
        const bg = style.backgroundColor;
        if (bg !== '' && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
          const colour = style.getPropertyValue(`border-${side.toLowerCase()}-color`);
          if (width > 0 && colour !== '' && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return true;
        }
        return false;
      };

      interface Rect { left: number; top: number; right: number; bottom: number }
      const rel = (r: DOMRect): Rect => ({
        left: r.left - canvasRect.left, top: r.top - canvasRect.top,
        right: r.right - canvasRect.left, bottom: r.bottom - canvasRect.top,
      });
      const area = (r: Rect): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

      /** The bounding box of everything a box paints, clamped to the box. */
      const paintedRect = (box: HTMLElement): Rect | null => {
        const frame = box.getBoundingClientRect();
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, any = false;
        box.querySelectorAll('*').forEach((el) => {
          if (!paints(el)) return;
          const rc = el.getBoundingClientRect();
          if (rc.width <= 0 || rc.height <= 0) return;
          any = true;
          l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
        });
        if (!any) return null;
        return rel(new DOMRect(
          Math.max(l, frame.left), Math.max(t, frame.top),
          Math.min(r, frame.right) - Math.max(l, frame.left),
          Math.min(b, frame.bottom) - Math.max(t, frame.top),
        ));
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

      const monthColours: string[] = [];
      document.querySelectorAll('.horizon .hz-rowdot, .horizon .hz-row.allday').forEach((node) => {
        const element = node as HTMLElement;
        if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') return;
        const style = getComputedStyle(element);
        monthColours.push(
          element.classList.contains('hz-rowdot') ? style.backgroundColor : style.borderLeftColor,
        );
      });

      const paintedRects: Rect[] = [];
      const boxes = Array.from(document.querySelectorAll('.canvas > .fw')).map((element) => {
        const box = element as HTMLElement;
        const rect = box.getBoundingClientRect();
        const inner = box.querySelector('.next, .horizon');
        const kind = box.classList.contains('fw-calendar')
          ? inner !== null && String(inner.className).split(/\s+/)[0] === 'next'
            ? 'agenda'
            : 'month'
          : (Array.from(box.classList).find((c) => c.startsWith('fw-') && c !== 'fw-fill')?.slice(3) ?? '?');
        const painted = paintedRect(box);
        if (painted !== null) paintedRects.push(painted);
        return {
          kind,
          w: rect.width,
          h: rect.height,
          area: rect.width * rect.height,
          fill: painted !== null && rect.width * rect.height > 0 ? area(painted) / (rect.width * rect.height) : 0,
          fillW: painted !== null && rect.width > 0 ? (painted.right - painted.left) / rect.width : 0,
          fillH: painted !== null && rect.height > 0 ? (painted.bottom - painted.top) / rect.height : 0,
          runs: runsIn(box),
        };
      });

      // Content share: the union of every box's painted rect, exhaustively (the
      // boxes barely overlap, but the union is exact and cheap either way).
      const W = canvasRect.width, H = canvasRect.height;
      const xs = [...new Set([0, W, ...paintedRects.flatMap((r) => [r.left, r.right])])].filter((x) => x >= 0 && x <= W).sort((a, b) => a - b);
      const ys = [...new Set([0, H, ...paintedRects.flatMap((r) => [r.top, r.bottom])])].filter((y) => y >= 0 && y <= H).sort((a, b) => a - b);
      let covered = 0;
      for (let i = 0; i < xs.length - 1; i++) for (let k = 0; k < ys.length - 1; k++) {
        const cell = { left: xs[i]!, right: xs[i + 1]!, top: ys[k]!, bottom: ys[k + 1]! };
        if (paintedRects.some((r) => r.left < cell.right && r.right > cell.left && r.top < cell.bottom && r.bottom > cell.top)) {
          covered += (cell.right - cell.left) * (cell.bottom - cell.top);
        }
      }

      return {
        canvas: { w: W, h: H },
        boxes,
        monthColours,
        contentShare: W * H > 0 ? covered / (W * H) : 0,
      };
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

/**
 * The fraction of the unit canvas a set of stored widget rects covers.
 *
 * The tiling assertion at the seed level: exhaustive, so it is exact for a
 * handful of boxes, and it is the union — two boxes that overlap are not counted
 * twice — so "covers 0.99" means the boxes reach every corner and share edges
 * rather than pile up in one.
 */
function coverage(widgets: readonly { x: number; y: number; w: number; h: number }[]): number {
  const xs = [...new Set([0, 1, ...widgets.flatMap((b) => [b.x, b.x + b.w])])].filter((x) => x >= 0 && x <= 1).sort((a, b) => a - b);
  const ys = [...new Set([0, 1, ...widgets.flatMap((b) => [b.y, b.y + b.h])])].filter((y) => y >= 0 && y <= 1).sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i < xs.length - 1; i++) for (let k = 0; k < ys.length - 1; k++) {
    const cell = { left: xs[i]!, right: xs[i + 1]!, top: ys[k]!, bottom: ys[k + 1]! };
    if (widgets.some((b) => b.x < cell.right && b.x + b.w > cell.left && b.y < cell.bottom && b.y + b.h > cell.top)) {
      covered += (cell.right - cell.left) * (cell.bottom - cell.top);
    }
  }
  return covered;
}

describe('the Classic seed', () => {
  it('seeds a new display with the tiled, tier-derived proportions', async () => {
    // A second display, created through the same admin route a household uses.
    const before = new Set((wall.db.prepare('SELECT id FROM screens').all() as { id: string }[]).map((r) => r.id));
    await wall.pairLink('Hall');
    const hall = (wall.db.prepare('SELECT id FROM screens').all() as { id: string }[])
      .map((r) => r.id)
      .find((id) => !before.has(id));
    expect(hall, 'the admin route created a display').toBeDefined();

    const areas: Record<string, { agenda: number; month: number }> = {};
    for (const orientation of ['portrait', 'landscape'] as const) {
      const widgets = readLayoutWidgets(wall.db, hall!, orientation);
      // The boxes tile the canvas: they share edges and reach every corner, so
      // no gutter band is left as dead wall. This is the seed-level statement of
      // the content-share measured on the drawn wall below.
      expect(
        coverage(widgets),
        `${orientation}: the seeded boxes cover ${(coverage(widgets) * 100).toFixed(1)}% of the canvas — they must tile it`,
      ).toBeGreaterThanOrEqual(0.98);

      const calendars = widgets.filter((widget) => widget.type === 'calendar');
      const agenda = calendars.find((widget) => (widget.config as { mode?: string } | undefined)?.mode === 'list');
      const month = calendars.find((widget) => (widget.config as { mode?: string } | undefined)?.mode !== 'list');
      expect(agenda, `${orientation} agenda`).toBeDefined();
      expect(month, `${orientation} month`).toBeDefined();
      // Area, not height: in landscape the two are columns rather than rows.
      areas[orientation] = { agenda: agenda!.w * agenda!.h, month: month!.w * month!.h };
    }

    // Landscape inverts outright: the agenda is the larger of the two.
    expect(
      areas['landscape']!.agenda,
      `landscape: agenda ${areas['landscape']!.agenda.toFixed(3)} vs month ${areas['landscape']!.month.toFixed(3)}`,
    ).toBeGreaterThan(areas['landscape']!.month);

    /*
     * Portrait stops at a peer rather than an anchor, so the claim here is about
     * the agenda's own size rather than about which box is bigger. 0.30 is the
     * height at which the agenda's smallest run reaches the 22px floor on a wall
     * nobody has measured (see the rendered floor assertion below — the two are
     * the same claim from two sides). The tiled seed gives it 0.33.
     */
    const portrait = readLayoutWidgets(wall.db, hall!, 'portrait')
      .filter((widget) => widget.type === 'calendar')
      .find((widget) => (widget.config as { mode?: string } | undefined)?.mode === 'list');
    expect(
      portrait!.h,
      `portrait: the agenda is ${portrait!.h} of the wall's height, below the 0.30 its type needs`,
    ).toBeGreaterThanOrEqual(0.3);
  }, SLOW);

  it('seeds a screen with no panel facts exactly as before', () => {
    /*
     * The Kitchen screen was paired with no panel facts, so it must be seeded at
     * the nominal aspects — the ones the template gallery offers and every wall
     * nobody has measured gets. This is the "with them null, behaviour is
     * unchanged" half of the letterbox change.
     */
    const kitchen = (wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }).id;
    for (const [orientation, aspect] of [['portrait', 0.5625], ['landscape', 1.7778]] as const) {
      const stored = wall.db
        .prepare(`SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?`)
        .get(kitchen) as { p: number; l: number };
      expect(orientation === 'portrait' ? stored.p : stored.l, `${orientation} aspect is nominal`).toBeCloseTo(aspect, 4);
    }
  });

  it('leaves a wall that arranged its own canvas byte-identical across the backfill and re-seed', () => {
    /*
     * The hard constraint, strengthened because this phase changes a seed: this
     * changes the seed for *new* canvases only, and neither the boot backfill nor
     * the boot re-seed — the one that now also adopts a panel's aspect — may
     * touch a canvas a household has arranged.
     */
    const dump = (): string =>
      JSON.stringify(wall.db.prepare('SELECT * FROM layout_widgets ORDER BY screen_id, orientation, id').all());

    /*
     * A wall the household *cleared* stays cleared (the one-shot flag's whole
     * job), and — new here — a wall with panel facts that the household then
     * *arranged* stays put across the panel-aspect re-seed.
     */
    const emptied = 'emptied-wall';
    const arranged = 'arranged-panel-wall';
    const at = Date.now();
    for (const id of [emptied, arranged]) {
      wall.db
        .prepare(`INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, id, `hash-${id}`, at, at, at);
    }
    // The arranged wall has panel facts *and* a canvas that is nobody's seed: one
    // box dragged off the tiling. It must survive both the backfill and the
    // re-seed untouched.
    wall.db.prepare(`UPDATE screens SET panel_width_mm=?, panel_height_mm=?, read_distance_mm=? WHERE id=?`)
      .run(EINK_75.widthMm, EINK_75.heightMm, EINK_75.distanceMm, arranged);
    // A deliberately non-seed arrangement, written through the real layout
    // writer: a single clock nudged off any tiling, at the nominal aspect, so it
    // prints as none of the seeds (nominal or panel) and must never be rewritten.
    for (const [orientation, aspect] of [['portrait', 0.5625], ['landscape', 1.7778]] as const) {
      replaceLayout(wall.db, arranged, orientation, {
        mode: 'freeform',
        aspect,
        widgets: [{ id: `aw-${orientation[0]}`, type: 'clock', x: 0.111, y: 0.222, w: 0.3, h: 0.1, z: 0 }],
        background: null,
      });
    }

    const before = dump();
    backfillClassic(wall.db, householdSetUp(wall.db));
    expect(dump(), 'with the flag set the backfill writes nothing at all').toBe(before);
    expect(readLayoutWidgets(wall.db, emptied, 'portrait'), 'a cleared wall stays cleared').toHaveLength(0);

    wall.db.prepare(`UPDATE household_settings SET layout_backfilled = 0 WHERE id = 'singleton'`).run();
    backfillClassic(wall.db, householdSetUp(wall.db));
    const afterBackfill = JSON.parse(dump()) as { screen_id: string | null }[];
    expect(
      JSON.stringify(afterBackfill.filter((row) => row.screen_id !== emptied)),
      'an arranged canvas is untouched even by a backfill allowed to seed',
    ).toBe(before);
    expect(
      (wall.db.prepare(`SELECT layout_backfilled AS f FROM household_settings WHERE id = 'singleton'`).get() as { f: number }).f,
      'the one-shot flag is set again',
    ).toBe(1);

    // And the re-seed, which is the path that adopts a panel aspect, also leaves
    // the arranged wall's two rows exactly where they are.
    const arrangedRows = (): string =>
      JSON.stringify(wall.db.prepare(`SELECT * FROM layout_widgets WHERE screen_id = ? ORDER BY orientation, id`).all(arranged));
    const arrangedBefore = arrangedRows();
    reseedClassicForSetUp(wall.db, householdSetUp(wall.db));
    expect(arrangedRows(), 'the panel-aspect re-seed does not touch an arranged wall').toBe(arrangedBefore);

    // Clean up so the drawn-wall measurements below see only the Kitchen wall.
    for (const id of [emptied, arranged]) wall.db.prepare('DELETE FROM screens WHERE id = ?').run(id);
    wall.db.prepare('DELETE FROM layout_widgets WHERE screen_id = ? OR screen_id = ?').run(emptied, arranged);
  });

  it('moves a still-seeded wall onto its panel aspect when the facts are entered', () => {
    /*
     * The other side of the guard above: a wall that is *provably still the one
     * we seeded* (nominal aspect, Classic's own boxes) is re-seeded at the panel
     * aspect once the household enters their panel size. That is the letterbox
     * fix reaching a wall created before the facts were known, and it is a
     * *re-seed* of an unarranged canvas — never a rewrite of an arrangement.
     */
    const before = new Set((wall.db.prepare('SELECT id FROM screens').all() as { id: string }[]).map((r) => r.id));
    // Pair a fresh screen (seeded nominal, no facts), then give it panel facts.
    return wall.pairLink('E-ink').then(() => {
      const panel = (wall.db.prepare('SELECT id FROM screens').all() as { id: string }[])
        .map((r) => r.id)
        .find((id) => !before.has(id))!;
      const nominal = wall.db.prepare(`SELECT layout_aspect AS p FROM screens WHERE id = ?`).get(panel) as { p: number };
      expect(nominal.p, 'seeded nominal before facts').toBeCloseTo(0.5625, 4);

      wall.db.prepare(`UPDATE screens SET panel_width_mm=?, panel_height_mm=?, read_distance_mm=? WHERE id=?`)
        .run(EINK_75.widthMm, EINK_75.heightMm, EINK_75.distanceMm, panel);
      reseedClassicForSetUp(wall.db, householdSetUp(wall.db));

      const after = wall.db.prepare(`SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?`).get(panel) as { p: number; l: number };
      const want = panelCanvasAspects(EINK_75.widthMm, EINK_75.heightMm)!;
      expect(after.p, 'portrait canvas now at the panel aspect').toBeCloseTo(want.portrait, 4);
      expect(after.l, 'landscape canvas now at the panel aspect').toBeCloseTo(want.landscape, 4);

      wall.db.prepare('DELETE FROM layout_widgets WHERE screen_id = ?').run(panel);
      wall.db.prepare('DELETE FROM screens WHERE id = ?').run(panel);
    });
  }, SLOW);
});

describe('the Classic wall, drawn', () => {
  it(
    'draws the agenda larger than the month in landscape',
    async () => {
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
    'keeps the calendars’ own colours on the portrait month grid',
    async () => {
      const { monthColours } = await measureWallBoxes({ width: 1080, height: 1920 });

      const hex = (colour: string): string => {
        const parsed = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
        if (parsed === null) return colour;
        return '#' + [1, 2, 3].map((index) => Number(parsed[index]).toString(16).padStart(2, '0')).join('').toUpperCase();
      };
      const stored = new Set(
        (wall.db.prepare('SELECT color FROM calendar_sources').all() as { color: string }[]).map((row) => row.color.toUpperCase()),
      );
      const drawn = new Set(monthColours.map(hex));

      expect(
        monthColours.length,
        'the portrait month grid painted no calendar colour at all — its cells have no room for a row',
      ).toBeGreaterThan(0);
      for (const colour of drawn) {
        expect(stored.has(colour), `the month painted ${colour}, which is no calendar's colour`).toBe(true);
      }
    },
    SLOW,
  );

  it(
    'cuts no event title out of the landscape agenda',
    async () => {
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

  it(
    'covers at least 78% of the canvas with content in both orientations',
    async () => {
      /*
       * The whole point of the tiling, measured on the drawn wall rather than on
       * the stored boxes: the union of every widget's *painted* content — not its
       * box — as a fraction of the canvas. Before, this was 63.6% at 1080x1920
       * and 66.2% at 1920x1080; a third of the wall was gutter, slack and
       * letterbox. The target is 78% and both orientations clear it comfortably.
       */
      for (const size of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }] as const) {
        const { contentShare } = await measureWallBoxes(size);
        expect(
          contentShare * 100,
          `${size.width}x${size.height}: content covers ${(contentShare * 100).toFixed(1)}% of the canvas, below 78%`,
        ).toBeGreaterThanOrEqual(78);
      }
    },
    SLOW,
  );

  it(
    'fills the viewport when the panel size is known',
    async () => {
      /*
       * The letterbox, closed at seed time. A 7.5" e-ink panel is 5:3, so
       * Classic's nominal 16:9 loses a 6.3% band top and bottom. Seed the canvas
       * at the panel's own aspect and the canvas fills the frame — not to the
       * last pixel, because millimetres and CSS pixels are two different rulers,
       * but to within a whisker of it.
       *
       * Driven through the real Reset-layout route on a screen that has facts, so
       * this is `classicSeed` on the path a household reaches.
       */
      const before = new Set((wall.db.prepare('SELECT id FROM screens').all() as { id: string }[]).map((r) => r.id));
      const panelLink = await wall.pairLink('Panel');
      const panel = (wall.db.prepare('SELECT id FROM screens').all() as { id: string }[])
        .map((r) => r.id)
        .find((id) => !before.has(id))!;
      wall.db.prepare(`UPDATE screens SET panel_width_mm=?, panel_height_mm=?, read_distance_mm=? WHERE id=?`)
        .run(EINK_75.widthMm, EINK_75.heightMm, EINK_75.distanceMm, panel);
      const reset = await wall.post(`/admin/displays/${panel}/reset-layout`, {});
      expect(reset.status, 'reset-layout redirected').toBe(302);

      try {
        for (const size of [{ width: 800, height: 480 }, { width: 480, height: 800 }] as const) {
          const { page, close } = await loadWallSettled(panelLink, size);
          try {
            const share = await page.evaluate((vp) => {
              const canvas = document.querySelector('.canvas') as HTMLElement;
              const rect = canvas.getBoundingClientRect();
              return ((rect.width * rect.height) / (vp.width * vp.height)) * 100;
            }, size);
            expect(
              share,
              `${size.width}x${size.height}: the panel-seeded canvas filled ${share.toFixed(1)}% of the viewport`,
            ).toBeGreaterThanOrEqual(99);
          } finally {
            await close();
          }
        }
      } finally {
        wall.db.prepare('DELETE FROM layout_widgets WHERE screen_id = ?').run(panel);
        wall.db.prepare('DELETE FROM screens WHERE id = ?').run(panel);
      }
    },
    SLOW,
  );

  it(
    'fills each widget box, the calendars to the reader’s edge',
    async () => {
      /*
       * The intra-box slack, closed — but the right statement of it is not one
       * threshold for every box, because two of the box's shapes are genuinely
       * different questions.
       *
       * **The calendars fill their box.** The month and the agenda are the
       * product ("the calendar is the product"), and where `fitToBox` centred a
       * scaled month at ~30% of its box, the tier fills it: both cover at least
       * 85% of their box's *area*, at the design size of each orientation. That is
       * the assertion that would have failed on the old scale-to-fit wall.
       *
       * **Every other box reaches its edge on at least one axis.** The fitToBox
       * fault was a section scaled small and centred, leaving dead space on
       * *both* axes — a shift badge at 55% of its box was ~74% on each side. A
       * forecast is a horizontal strip: it fills its box's *width* and is short,
       * which is the shape of a forecast and not a hole. A clock is a centred
       * readout whose element still spans its box's width. So the honest test for
       * these is that the painted content spans ≥85% of *one* axis — the widget
       * reaches its box in some direction rather than floating in the middle of
       * it. A regression to the centred-scale fault fills neither axis and fails
       * here; the aggregate content-share above is what proves the wall as a whole
       * carries no dead band.
       */
      for (const size of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }] as const) {
        const { boxes } = await measureWallBoxes(size);
        for (const box of boxes) {
          const where = `${size.width}x${size.height}: the ${box.kind} box (${Math.round(box.w)}x${Math.round(box.h)})`;
          if (box.kind === 'agenda' || box.kind === 'month') {
            expect(box.fill, `${where} is ${(box.fill * 100).toFixed(0)}% filled, below 85%`).toBeGreaterThanOrEqual(0.85);
            continue;
          }
          const axis = Math.max(box.fillW, box.fillH);
          expect(
            axis,
            `${where} spans only ${(box.fillW * 100).toFixed(0)}% wide and ${(box.fillH * 100).toFixed(0)}% tall — ` +
              `it floats in its box rather than reaching an edge`,
          ).toBeGreaterThanOrEqual(0.85);
        }
      }
    },
    SLOW,
  );
});
