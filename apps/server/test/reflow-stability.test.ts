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
 * same way — and the last two are the e-paper renderer's, which this file does
 * not measure. So what is left on the wall is arithmetic over the box, and this
 * is what says so.
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

describe('the same wall drawn with different events', () => {
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
