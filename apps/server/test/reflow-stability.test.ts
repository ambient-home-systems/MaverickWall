/**
 * The wall's geometry is a function of its arrangement, not of its events.
 *
 * **This is the acceptance for e-ink partial refresh (RFC 006, phase 11) and it
 * belongs here because this is the phase that makes it true.** A panel that can
 * update part of a frame has to know which part moved, and it can only know
 * that if the frame's *boxes* stay put while their words change. An e-ink panel
 * that has to full-refresh on every draw flashes the whole screen every fifteen
 * minutes and eats a battery; one that can push a rectangle does not.
 *
 * Seven mechanisms in this renderer used to recompute geometry from content:
 *
 *  1. `fitToBox` — a section measured and given a `transform: scale()`, so one
 *     more event made every word on the widget smaller.
 *  2. `trimCellRows` — a month cell drew everything and hid what spilled.
 *  3. `fitAndTrimToDays` — a section scaled, then cut to whole days, then
 *     scaled again.
 *  4. the ladder drop loop — fit, ask whether it clipped, drop a rung, fit
 *     again.
 *  5. `weekColumnsFit` — seven columns or an agenda, from the box's width.
 *  6. the panel's note scale.
 *  7. the panel's `fit()`.
 *
 * The first four are gone: 2 went with the calendar's density tiers and 1, 3
 * and 4 with these. The fifth is a *boundary* rather than a scale — it reads
 * the box and never the content, so the same arrangement always answers the
 * same way. **The last two are the e-paper renderer's and are gone too**, which
 * they were not when this file was written: the note takes its rung from the
 * box and the tier now, `fit()` is held to the rectangle it was given, and the
 * second half of this file is where both are asked. So what is left on the wall
 * *and on the panel* is arithmetic over the box, and this is what says so.
 *
 * **Two walls, the same arrangement, different events.** Same template, same
 * panel, same viewport, same number of events on the same days — and every
 * title, every time and every calendar colour different. Every rectangle must
 * be identical to the hundredth of a pixel, and the glyphs inside them must
 * not be, or this file is comparing a wall with itself.
 *
 * **What it deliberately does not claim.** The two feeds have the same *shape*
 * — the same events on the same days — because that is what a wall redrawn
 * fifteen seconds later has, and it is the case partial refresh is for. A feed
 * with a different number of events on a day is a different arrangement of
 * rows and its geometry moves, which is correct: an agenda that ignored how
 * many events there are would be back to drawing six at every size. And the
 * titles are bounded in length: a title long enough to wrap gains its row a
 * line, which is the agenda's own wrap doing what it is for. Both boundaries
 * are stated here rather than hidden in the fixture, because the phase-11 work
 * has to know where the promise stops.
 *
 * Checked by breaking it: giving the second wall one extra event on one day
 * turns three of the rectangle assertions red (the agenda's days, its events
 * and its date columns) and leaves the month grid's alone, which is exactly the
 * shape the docstring above claims — a cell is `1fr` of a grid and does not
 * care how many events there are, and a day row is a stack of them and does.
 * Declaring `transform: scale(1)` on `.fw-content` turns the stylesheet scan
 * red.
 *
 * The panel's half was checked the same way and one of the three results is the
 * reason two of its assertions exist at all. Making an agenda row's `y` depend
 * on its title's length reddens the region comparison and the truncation
 * check. Restoring the note's per-sentence rung, and the header's step-down
 * against today's own date, redden **nothing** in the comparison — the fixture's
 * days are never empty and both frames share a date — and redden exactly the
 * two assertions written to ask them directly. A pair of frames that cannot see
 * a fix is a pair of frames that would have stayed green through it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type FeedEvent,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';
import { mountedSize, wallSizePreset } from '../src/wall-sizes.js';
import { addDays, type CivilDate } from '@maverick-wall/core';
import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { measureText } from '../src/epaper/font.js';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderScreenFrame } from '../src/epaper/frame.js';
import { panelMetrics, type PanelGeometry } from '../src/epaper/metrics.js';
import {
  drawAgendaBox,
  drawUpcomingBox,
  epaperBlocks,
  renderEpaper,
  type DrawnRegion,
  type RegionLog,
} from '../src/epaper/render.js';
import { typeTierFor } from '../src/epaper/type-tiers.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

process.env['TZ'] = 'UTC';

const SLOW = 300_000;

/**
 * One household's week, twice over, with nothing in common but its shape.
 *
 * Each entry is the same day, the same all-day-or-timed decision and the same
 * number of characters in a time; only the words differ, and they differ in
 * length as well as in content so this is not two walls drawing the same
 * string. Bounded to what one line of the agenda holds, for the reason the
 * docstring gives.
 */
const SHAPE: readonly {
  readonly day: number;
  readonly from?: string;
  readonly to?: string;
  /** Days covered, for the one multi-day event — the grid's span bar. */
  readonly days?: number;
}[] = [
  { day: 0, from: '0730', to: '0830' },
  { day: 0, from: '0915', to: '1000' },
  { day: 1, from: '0900', to: '1000' },
  { day: 1 },
  { day: 2, from: '1800', to: '2000' },
  { day: 3, from: '0830', to: '1600' },
  { day: 4, days: 8 },
  { day: 5, from: '1930', to: '2130' },
  { day: 6, from: '0900', to: '1100' },
  { day: 9, from: '1000', to: '1200' },
  { day: 12 },
  { day: 16, from: '1500', to: '1600' },
];

const WORDS_A = [
  'Swimming lesson', 'Assembly', 'Dentist', 'Bin day', 'Parents evening',
  'Museum trip', 'Half term', 'Book club', 'School photos', 'Planning review',
  'Grandma visits', 'Cake sale',
];
const WORDS_B = [
  'Piano', 'Registration', 'Optician', 'Recycling', 'Open evening',
  'Gallery outing', 'Reading week', 'Choir', 'Class picture', 'Budget meeting',
  'Uncle Tom stays', 'Bring and buy',
];

function feed(words: readonly string[], shift: number): readonly NamedFeed[] {
  const events: FeedEvent[] = SHAPE.map((slot, index) => ({
    title: words[index] ?? 'Something',
    day: slot.day,
    ...(slot.from === undefined ? {} : { from: slot.from, to: slot.to as string }),
    ...(slot.days === undefined ? {} : { days: slot.days }),
  }));
  // Two calendars, because the grid's colours and the agenda's rules are per
  // source and a one-feed wall cannot show a colour moving.
  return [
    { name: shift === 0 ? 'Family' : 'Household', events: events.slice(0, 7) },
    { name: shift === 0 ? 'School' : 'College', events: events.slice(7) },
  ];
}

interface Wall {
  readonly rects: Record<string, readonly string[]>;
  readonly words: readonly string[];
}

/** Every selector this file holds to the pixel: rows, cells and columns. */
const SELECTORS: Readonly<Record<string, string>> = {
  boxes: '.fw',
  monthCells: '.hz-cell',
  weekdayHeads: '.hz-head',
  spanBars: '.hz-span',
  agendaDays: '.day-row',
  agendaEvents: '.dr-ev',
  agendaDates: '.dr-when',
  forecastColumns: '.wx-day',
};

async function shapeOf(page: Page): Promise<Wall> {
  return page.evaluate((selectors: Record<string, string>) => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    const visible = (node: Element): boolean => {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return node.getBoundingClientRect().height > 0;
    };
    const rects: Record<string, string[]> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      rects[name] = [...document.querySelectorAll(`#wall .canvas ${selector}`)]
        .filter(visible)
        .map((node) => {
          const box = node.getBoundingClientRect();
          return `${round(box.x)} ${round(box.y)} ${round(box.width)} ${round(box.height)}`;
        });
    }
    const words = [...document.querySelectorAll('#wall .canvas .hz-rowtext, #wall .canvas .dr-ev-title, #wall .canvas .hz-spantext')]
      .filter(visible)
      .map((node) => (node.textContent ?? '').trim());
    return { rects, words };
  }, SELECTORS as Record<string, string>);
}

/** One wall, seeded and measured: install, equip, pair, size, draw, dispose. */
async function drawOne(calendars: readonly NamedFeed[]): Promise<Wall> {
  const home: Installation = await install({ calendars });
  try {
    equipHousehold(home.db, home.now());
    const link = await home.pairLink('Kitchen');
    const id = (
      home.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
    ).id;
    const preset = wallSizePreset('tv-32');
    if (preset === undefined) throw new Error('no tv-32 preset');
    const mounted = mountedSize(preset, 90);
    home.db
      .prepare(
        'UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?',
      )
      .run(mounted.widthMm, mounted.heightMm, preset.readAtMm, id);
    const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
    try {
      return await shapeOf(page);
    } finally {
      await close();
    }
  } finally {
    await home.dispose();
  }
}

let first: Wall;
let second: Wall;

describe('the same wall drawn with different events', () => {
  /*
   * The browser setup lives in here rather than at the top of the file, and
   * that is deliberate: the panel section below is pure and synchronous —
   * `renderEpaper` takes a manifest and a panel size and answers with a
   * framebuffer — so a machine with no Chromium on it should still be told
   * whether the e-paper frame keeps its rectangles still. A file-level
   * `beforeAll` would skip it along with the wall.
   */
  beforeAll(async () => {
    /*
     * Sequentially, and each installation is disposed before the next is made.
     * Two servers in one process put an offline banner on one of the two walls —
     * measured, and a banner is 76px of canvas, which is exactly the kind of
     * difference this file exists to notice and would have reported as a
     * renderer fault.
     */
    first = await drawOne(feed(WORDS_A, 0));
    second = await drawOne(feed(WORDS_B, 1));
  }, SLOW);

  afterAll(async () => {
    await shutDownBrowser();
  }, TEARDOWN);

  it('draws different words', () => {
    /*
     * The premise. Without it every identity below holds on two identical walls
     * and this file proves nothing — the shape of assertion this project keeps
     * finding it cannot turn red.
     */
    expect(first.words.length, 'the first wall drew no event names').toBeGreaterThan(5);
    expect(second.words.length, 'the second wall drew no event names').toBeGreaterThan(5);
    expect(
      second.words.join('|'),
      'the two walls drew the same words, so nothing below is being tested',
    ).not.toBe(first.words.join('|'));
  });

  for (const name of Object.keys(SELECTORS)) {
    it(`places every ${name} identically`, () => {
      const before = first.rects[name] ?? [];
      const after = second.rects[name] ?? [];
      expect(before.length, `the first wall drew no ${name}`).toBeGreaterThan(0);
      expect(
        after,
        `${name} moved when the events changed — the wall's geometry is being ` +
          'computed from its content, which is what stops an e-ink panel refreshing part of a frame',
      ).toEqual(before);
    });
  }
});

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER = join(HERE, '..', '..', 'display', 'src', 'render.ts');
const DENSITY = join(HERE, '..', '..', 'display', 'src', 'density.ts');

describe('the mechanisms that computed geometry from content', () => {
  /*
   * Four of the seven are gone, and this reads the source rather than the wall
   * because an absence is the one thing a measurement cannot show: a renderer
   * that still carries `fitToBox` and merely never calls it on this fixture
   * would pass every assertion above and fail the next arrangement somebody
   * drags.
   */
  it('no longer carries a scale-to-fit, a row trim or a drop loop', () => {
    const render = readFileSync(RENDER, 'utf8');
    const density = readFileSync(DENSITY, 'utf8');
    for (const gone of ['function fitToBox', 'function trimCellRows', 'function fitAndTrimToDays', 'function minScaleFor']) {
      expect(render, `${gone} is still declared`).not.toContain(gone);
    }
    for (const gone of ['MIN_CALENDAR_SCALE', 'MIN_CHORE_SCALE']) {
      expect(density, `${gone} is still declared`).not.toContain(`export const ${gone}`);
    }
  });

  it('draws no laid-out section through a transform', () => {
    /*
     * The stylesheet's half. `transform` survives on the wall for exactly two
     * things and neither is a section: the root's quarter-turn rotation
     * (`orientation.ts`), and centring a fixed overlay. A `scale()` on anything
     * that holds words is the mechanism this phase removed.
     */
    // Comments stripped first: this file's own history is written in them, and
    // a scan that reads a paragraph about the mechanism as the mechanism is a
    // scan that can never go green.
    const css = readFileSync(join(HERE, '..', '..', 'display', 'src', 'display.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const scales = [...css.matchAll(/transform:\s*[^;}]*scale\(/g)];
    expect(
      scales.map((match) => match[0]),
      'display.css declares a scale transform',
    ).toEqual([]);
    const render = readFileSync(RENDER, 'utf8');
    expect(render, 'the renderer writes a scale transform').not.toMatch(/style\.transform\s*=/);
  });
});

// ---------------------------------------------------------------------------
// The panel, which is where a partial refresh actually happens
// ---------------------------------------------------------------------------

/**
 * The wall's half of this file is what makes the *arrangement* stable; this is
 * the frame a panel is actually asked to push a rectangle of.
 *
 * `render.ts` states the contract at the top of the file:
 *
 *     Every drawn region is a rectangle whose position is a function of
 *     (panel size, tier) ONLY.
 *     Two frames at the same panel size and tier, with different events,
 *     have identical region rectangles.
 *     Only the ink inside a region may differ.
 *
 * **Pixels cannot settle that and it is worth saying why.** Two frames with
 * different words in the same row have different ink in it by definition, and a
 * row that *moved* looks, from the outside, exactly like a row whose first
 * letter happens to be a lowercase 'a'. So the renderer records where it drew
 * (`DrawnRegion`), at the site that does the drawing, from the same expression
 * that positions it — which is what makes comparing two logs a real test rather
 * than a circular one: a position computed from content moves the record along
 * with the ink. Nothing here compares a record against an independently
 * predicted value.
 *
 * Two mechanisms this phase had to fix before any of it was true, both named in
 * `render.ts`: the empty-state note picked its rung by measuring its own
 * sentence (so the two notes could take different rungs in the same box, and
 * rewording one moved a rectangle), and the header band stepped down to fit
 * *today's* date — a band that changes size at midnight, which is precisely the
 * boundary a panel most wants to partial-refresh across.
 *
 * `fit()` survives and is legitimate: truncating a title changes the ink inside
 * a rectangle and can never move its origin or its line height. The last block
 * below is what holds it to that.
 */
describe('the same panel frame drawn with different events', () => {
  const PANEL = { width: 800, height: 480 } as const;

  /** A day of the fixture: the same shape of events, different words. */
  function panelEvent(date: CivilDate, index: number, title: string, allDay: boolean): ManifestEvent {
    const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
    const at = (hour: number): number => Date.UTC(y as number, (m ?? 1) - 1, d ?? 1, hour, 0, 0);
    return {
      id: `${date}-${index}`, uid: `${date}-${index}`, title,
      startsAt: allDay ? at(0) : at(8 + index * 2),
      endsAt: allDay ? at(0) : at(9 + index * 2),
      allDay, sourceId: index % 2 === 0 ? 'family' : 'school',
      color: '#000', status: 'confirmed', continues: false,
    };
  }

  /**
   * The same thirty days twice over, with nothing in common but their shape.
   *
   * Same number of events on the same days, the same all-day decisions, and
   * every word different — including in *length*, so this is not one frame
   * compared with itself. Bounded to what one agenda line holds, for the reason
   * the wall's half of this file gives.
   */
  function panelManifest(words: readonly string[]): Manifest {
    const days: ManifestDay[] = [];
    for (let index = 0; index < 30; index++) {
      const date = addDays(PANEL_TODAY, index - 2);
      const count = 2 + (index % 3);
      const events: ManifestEvent[] = [];
      for (let i = 0; i < count; i++) {
        events.push(panelEvent(date, i, words[(index * 3 + i) % words.length] as string, (index + i) % 5 === 0));
      }
      days.push({ date, shifts: [], events });
    }
    return {
      timezone: 'UTC',
      generatedAt: Date.UTC(2026, 7, 13, 12),
      window: { from: days[0]?.date, to: days[days.length - 1]?.date },
      display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'monday' },
      days,
    } as unknown as Manifest;
  }

  const PANEL_TODAY: CivilDate = '2026-08-13';
  const PANEL_WORDS_A = [
    'Swimming lesson', 'Assembly', 'Dentist', 'Bin day', 'Parents evening',
    'Museum trip', 'Half term', 'Book club', 'School photos',
  ];
  const PANEL_WORDS_B = [
    'Piano', 'Registration', 'Optician', 'Recycling', 'Open evening',
    'Gallery outing', 'Reading week', 'Choir', 'Class picture',
  ];

  /** The same thirty days with nothing on any of them. */
  function emptyManifest(): Manifest {
    const days: ManifestDay[] = [];
    for (let index = 0; index < 30; index++) {
      days.push({ date: addDays(PANEL_TODAY, index - 2), shifts: [], events: [] });
    }
    return {
      timezone: 'UTC',
      generatedAt: Date.UTC(2026, 7, 13, 12),
      window: { from: days[0]?.date, to: days[days.length - 1]?.date },
      display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'monday' },
      days,
    } as unknown as Manifest;
  }

  /** One day's worth, so the header can be asked about a named date. */
  function dayManifest(today: CivilDate): Manifest {
    const days: ManifestDay[] = [];
    for (let index = 0; index < 30; index++) {
      days.push({ date: addDays(today, index - 2), shifts: [], events: [] });
    }
    return {
      timezone: 'UTC',
      generatedAt: Date.UTC(
        Number.parseInt(today.slice(0, 4), 10),
        Number.parseInt(today.slice(5, 7), 10) - 1,
        Number.parseInt(today.slice(8, 10), 10),
        12,
      ),
      window: { from: days[0]?.date, to: days[days.length - 1]?.date },
      display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'monday' },
      days,
    } as unknown as Manifest;
  }

  function frameOf(words: readonly string[]): { fb: Framebuffer; regions: RegionLog } {
    const regions: RegionLog = [];
    const fb = renderEpaper(buildEpaperModel(panelManifest(words)), PANEL, regions);
    return { fb, regions };
  }

  const key = (r: DrawnRegion): string => `${r.name} @ ${r.x},${r.y} ${r.w}x${r.h}`;
  const inkOf = (fb: Framebuffer): string => {
    let out = '';
    for (let y = 0; y < fb.height; y++) for (let x = 0; x < fb.width; x++) out += fb.get(x, y) ? '1' : '0';
    return out;
  };

  const a = frameOf(PANEL_WORDS_A);
  const b = frameOf(PANEL_WORDS_B);

  it('draws different frames, so nothing below is comparing one with itself', () => {
    expect(a.regions.length, 'the frame recorded no regions at all').toBeGreaterThan(50);
    expect(inkOf(b.fb), 'the two frames are identical').not.toBe(inkOf(a.fb));
  });

  it('places every drawn region identically', () => {
    expect(
      b.regions.map(key),
      "a region moved when the events changed — the panel's geometry is being computed from " +
        'its content, which is what stops an e-ink panel refreshing part of a frame',
    ).toEqual(a.regions.map(key));
  });

  it('records the regions a partial refresh would actually push', () => {
    // A guard on the *record* rather than on the frame: a log that quietly
    // stopped covering the grid would make the identity above vacuous for
    // everything it stopped covering.
    const names = new Set(a.regions.map((r) => r.name.split(':')[0] as string));
    for (const wanted of ['header', 'agenda', 'agenda-row', 'month', 'month-head', 'cell']) {
      expect(names, `nothing recorded a ${wanted} region`).toContain(wanted);
    }
  });

  it('keeps every region inside the panel it was drawn on', () => {
    for (const r of a.regions) {
      expect(r.x, key(r)).toBeGreaterThanOrEqual(0);
      expect(r.y, key(r)).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, key(r)).toBeLessThanOrEqual(PANEL.width);
      expect(r.y + r.h, key(r)).toBeLessThanOrEqual(PANEL.height);
    }
  });

  /*
   * `fit()` is the one content-dependent thing left in `epaper/render.ts`, and
   * the contract permits it on one condition: truncation may change the ink in
   * a rectangle and must never change the rectangle. The gutters are where a
   * failure would land — an untruncated title runs out of the agenda's box and
   * across the month grid, which is a fault this project has already shipped
   * once ("Nothing coming up" lying over the grid on a narrow column).
   */
  describe('a truncated title stays in the rectangle it was given', () => {
    const LONG = [
      'Year 6 trip to the Science Museum and the planetarium afterwards',
      "Grandma's eightieth birthday lunch at the garden centre",
      'Quarterly planning review with the whole department',
    ];

    const gutterInk = (fb: Framebuffer): number => {
      const m = panelMetrics(PANEL);
      const blocks = epaperBlocks(buildEpaperModel(panelManifest(LONG)).weeks.length, m);
      const gutterFrom = blocks.agenda.x + blocks.agenda.w;
      const gutterTo = blocks.month.x;
      let ink = 0;
      for (let y = m.headerHeight; y < PANEL.height; y++) {
        for (let x = gutterFrom; x < gutterTo; x++) if (fb.get(x, y)) ink += 1;
        // …and the panel's own outer inset, on both sides.
        for (let x = 0; x < m.margin; x++) if (fb.get(x, y)) ink += 1;
        for (let x = PANEL.width - m.margin; x < PANEL.width; x++) if (fb.get(x, y)) ink += 1;
      }
      return ink;
    };

    it('leaves the gutters and the margins clear however long the titles are', () => {
      // The premise: these titles genuinely do not fit, so `fit` is doing work.
      const m = panelMetrics(PANEL);
      expect(measureText(LONG[0] as string, { rung: m.body })).toBeGreaterThan(
        epaperBlocks(6, m).agenda.w,
      );
      expect(gutterInk(frameOf(LONG).fb)).toBe(0);
    });

    it('puts its rows in the same rectangles as a frame of short ones', () => {
      const long = frameOf(LONG);
      const short = frameOf(['Yoga', 'Bins', 'Choir']);
      expect(long.regions.map(key)).toEqual(short.regions.map(key));
    });
  });

  /*
   * The two mechanisms this phase repaired, each asked directly.
   *
   * **Neither is reachable from the comparison above and that is the point.**
   * The note only draws when a day is empty and the fixture's days never are;
   * the header's step-down only moves when the *date* changes and both frames
   * share one. A pair of frames that cannot see a fix is a pair of frames that
   * would have stayed green through it.
   */
  describe('the mechanisms that took a size from a string', () => {
    it('draws both empty-state notes at one rung in one box', () => {
      /*
       * The note used to pick its rung by measuring its own sentence, so
       * "Nothing on today" (16 characters) and "Nothing coming up" (17) could
       * take *different* rungs in the same box — and rewording either one would
       * have moved a rectangle. The box below is chosen to sit between them at
       * the body rung, which is the only width where the old code and the new
       * one disagree.
       */
      const m = panelMetrics(PANEL);
      const shorter = measureText('Nothing on today', { rung: m.body });
      const longer = measureText('Nothing coming up', { rung: m.body });
      const width = Math.floor((shorter + longer) / 2);
      expect(shorter, 'the two notes measure the same, so this box proves nothing').toBeLessThan(longer);
      expect(width).toBeGreaterThanOrEqual(shorter);
      expect(width).toBeLessThan(longer);

      const empty = buildEpaperModel(emptyManifest());
      const bandOf = (draw: (fb: Framebuffer) => void): number => {
        const fb = new Framebuffer(width + 40, 120);
        draw(fb);
        let rows = 0;
        for (let y = 0; y < 120; y++) {
          for (let x = 0; x < width + 40; x++) {
            if (fb.get(x, y)) { rows += 1; break; }
          }
        }
        return rows;
      };
      const box = { x: 0, y: 0, w: width, h: 120 };
      const today = bandOf((fb) => { drawAgendaBox(fb, empty, m, box); });
      const upcoming = bandOf((fb) => { drawUpcomingBox(fb, empty, m, box); });
      expect(today, 'a note drew nothing, so this compares two blanks').toBeGreaterThan(0);
      expect(upcoming, 'the two notes take different rungs in one box').toBe(today);
    });

    it('draws the header band at one size whatever today is called', () => {
      /*
       * The band stepped down until *today's* date fitted, so its type changed
       * size at midnight — a reflow at exactly the boundary a panel most wants
       * to partial-refresh across, and one no pair of frames from the same day
       * can see. "Wednesday 30 September" is the longest line this locale can
       * produce and "Friday 1 May" one of the shortest.
       */
      const dateRegion = (panel: PanelGeometry, today: CivilDate): DrawnRegion => {
        const log: RegionLog = [];
        renderEpaper(buildEpaperModel(dayManifest(today)), panel, log);
        return log.find((r) => r.name === 'header-date') as DrawnRegion;
      };
      /*
       * **On the narrow panel as well as the wide one, and the narrow one is
       * where it bites.** At 800x480 the band has 701px of budget and the
       * longest possible date needs 373, so nothing steps down and a test run
       * only there passes with the fault restored. A 2.9" panel has 221px of
       * budget: the longest date needs a rung and a half less than the
       * shortest, so a band sized to today's own words is two different bands.
       */
      for (const panel of [PANEL, { width: 296, height: 128 } as const]) {
        const longest = dateRegion(panel, '2026-09-30'); // WEDNESDAY 30 SEPTEMBER
        const shortest = dateRegion(panel, '2026-05-01'); // FRIDAY 1 MAY
        expect(longest, `no header-date region at ${panel.width}x${panel.height}`).toBeDefined();
        expect(key(shortest), `${panel.width}x${panel.height}`).toBe(key(longest));
      }
    });
  });

  /*
   * And the ETag, which is the only handle a dumb panel has on "did the
   * geometry change?". A tier change must move it — that is the one full
   * refresh the contract is allowed — and a change of nothing but event text
   * must not, or every frame is a full refresh and the contract buys nothing.
   */
  describe("the frame's ETag", () => {
    const screen = { panelWidth: 800, panelHeight: 480, panelColour: null, rotation: 0 };

    it('does not move when only the event text changes within a tier', () => {
      const one = renderScreenFrame(panelManifest(PANEL_WORDS_A), screen).etag;
      const two = renderScreenFrame(panelManifest(PANEL_WORDS_A), screen).etag;
      expect(two).toBe(one);
      // …and the ink genuinely differs between the two word sets, so the
      // assertion below is about the ETag rather than about two equal frames.
      expect(inkOf(b.fb)).not.toBe(inkOf(a.fb));
    });

    it('moves when the tier does', () => {
      /*
       * Two panels either side of E1's boundary with E2 — 696 and 697 pixels of
       * short side — on the same manifest. Nothing else about them differs but
       * one pixel of height, and the frame they draw is in a different face.
       */
      expect(typeTierFor(696).tier).toBe('E1');
      expect(typeTierFor(697).tier).toBe('E2');
      const manifest = panelManifest(PANEL_WORDS_A);
      const below = renderScreenFrame(manifest, { ...screen, panelWidth: 1000, panelHeight: 696 }).etag;
      const above = renderScreenFrame(manifest, { ...screen, panelWidth: 1000, panelHeight: 697 }).etag;
      expect(above).not.toBe(below);
    });

    it('carries the tier itself, not only something that implies it', () => {
      /*
       * The tier is a pure function of the panel's short side today, so it adds
       * no churn — and that is the point of asserting it rather than assuming
       * it. What it buys is the day the tier stops being a function of pixels
       * alone: the preimage moves with it, and no panel composites two layouts
       * onto one sheet. Checked by removing the tier from the preimage, which
       * leaves this red and every other assertion in the file green.
       */
      const preimage = readFileSync(join(HERE, '..', 'src', 'epaper', 'frame.ts'), 'utf8');
      const block = /const preimage = \[([\s\S]*?)\]\.join/.exec(preimage)?.[1] ?? '';
      expect(block, "the frame's ETag preimage does not read the type tier").toContain('typeTierFor');
    });
  });
});
