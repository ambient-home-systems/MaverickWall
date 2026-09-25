/**
 * The countdown's `month` look — a small month with the target circled —
 * measured on a real wall (plan item P5.2, the second half).
 *
 * The shipped Classic wall with three family calendars, its forecast's box
 * made a countdown, at 1080x1920 and 1920x1080, on a wall nobody has measured
 * and on one set to a 32" television read from 1.2 metres:
 *
 *  1. **A form from the box, and nothing cut.** In Classic's own box — which
 *     cannot hold five rows of type at a size read from across a kitchen, and
 *     draws the count — in a tall box that holds the whole month, and in a
 *     narrow column: every run inside the box, the belt with nothing to do,
 *     the parts the tier names, every figure `tabular-nums`, and on the
 *     measured wall the squares and heads the scaffold and the label the lede.
 *  2. **The target is circled and today is marked**, read off what is painted:
 *     one square carries a ring in the page's own accent, and it is the
 *     target's; one carries a line under it, and it is today's, only when
 *     today is in the target's month.
 *  3. **In the household's own week.** With the week starting on a Monday the
 *     heads start "M" and the first of the month sits in the column the
 *     calendar's grid puts it in.
 *  4. **The grid's geometry is the target month's alone**: two walls whose
 *     count differs by a day draw every square at the same rectangle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  SIZES,
  WALLS,
  civilDate,
  countdownWall,
  fontSizeIn,
  measureScreen,
  picturesIn,
  readCountdownBox,
  roleSizes,
  setCountdown,
  wallName,
  type CountdownWall,
} from './browser-countdown-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 300_000;

let cw: CountdownWall;

beforeAll(async () => {
  cw = await countdownWall();
}, SLOW);

afterAll(async () => {
  await cw?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const BOXES: readonly { readonly name: string; readonly resize?: { readonly w?: number; readonly h?: number } }[] = [
  { name: "Classic's box" },
  { name: 'a tall box', resize: { w: 0.9, h: 0.45 } },
  { name: 'a narrow column', resize: { w: 0.18, h: 0.35 } },
];

async function partsOn(page: Page, id: string): Promise<string[]> {
  return page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] [data-part]`, (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset['part'] ?? ''),
  );
}

/** Every square of the grid as drawn: its words, what is painted on it, and where it is. */
async function readSquares(page: Page, id: string): Promise<{
  readonly heads: readonly string[];
  readonly squares: readonly { readonly text: string; readonly paint: string; readonly rect: readonly number[] }[];
  readonly accent: string;
  readonly ink: string;
}> {
  return page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-month`, (section) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    section.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.style.color = 'var(--ink)';
    const ink = getComputedStyle(probe).color;
    probe.remove();
    return {
      heads: Array.from(section.querySelectorAll('.cdm-head')).map((n) => n.textContent ?? ''),
      squares: Array.from(section.querySelectorAll<HTMLElement>('.cdm-day')).map((n) => {
        const r = n.getBoundingClientRect();
        return {
          text: n.textContent ?? '',
          paint: getComputedStyle(n).backgroundImage,
          rect: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100),
        };
      }),
      accent,
      ink,
    };
  });
}

describe('the mini month on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `takes a form from its box and cuts nothing, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(cw, preset);
          const id = cw.box[size.orientation].id;
          for (const { name, resize } of BOXES) {
            // A six-week month, the tallest a month can be: 1 January 2027 is a
            // Friday, so from a Sunday its thirty-one days need six rows.
            await setCountdown(cw, { variant: 'month', target: '2027-01-30', title: 'Summer holiday' }, resize);
            const { page, close } = await loadWallSettled(cw.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${name}`;
              const box = await readCountdownBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              expect(box.tier, `${where}: no tier stamped`).not.toBeNull();
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');
              const parts = await partsOn(page, id);
              expect([...new Set(parts)].sort(), where).toEqual((box.rungs ?? '').split(' ').sort());
              expect(parts, `${where}: the count is gone`).toContain('count');
              // Classic's box gives the grid up for the count; a tall box draws it all.
              if (name === "Classic's box") expect([...new Set(parts)], where).toEqual(['count']);
              if (name === 'a tall box') expect(box.tier, where).toBe('T3');
              if (preset !== undefined && parts.includes('grid')) {
                const roles = await roleSizes(page);
                expect(await fontSizeIn(page, id, '.cdm-day'), `${where}: squares`).toBeCloseTo(roles['scaffold']!, 1);
                if (parts.includes('heads')) {
                  expect(await fontSizeIn(page, id, '.cdm-head'), `${where}: heads`).toBeCloseTo(roles['scaffold']!, 1);
                }
                if (parts.includes('label')) {
                  expect(await fontSizeIn(page, id, '.cdm-label'), `${where}: label`).toBeCloseTo(roles['lede']!, 1);
                }
              }
            } finally {
              await close();
            }
          }
        },
        SLOW,
      );
    }
  }
});

describe('the target is circled, and today marked', () => {
  it(
    'rings the target’s square alone in the accent, and underlines today’s only in today’s own month',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      const now = cw.wall.now();
      const today = civilDate(now, 0);
      // A target in today's month, whichever day of it today is.
      const target = Number(today.slice(8, 10)) > 27 ? civilDate(now, -2) : civilDate(now, 1);
      for (const [when, day] of [[target, true], [civilDate(now, 45), false]] as const) {
        await setCountdown(cw, { variant: 'month', target: when, title: 'Holiday' }, { w: 0.9, h: 0.45 });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const read = await readSquares(page, id);
          const ringed = read.squares.filter((one) => one.paint.includes('radial-gradient'));
          expect(ringed.map((one) => one.text), `${when}: the ringed squares`).toEqual([String(Number(when.slice(8, 10)))]);
          // The ring is painted in the page's own accent.
          expect(ringed[0]!.paint, 'the ring is not the accent').toContain(read.accent);
          const marked = read.squares.filter((one) => one.paint.includes('linear-gradient'));
          if (day) {
            expect(marked.map((one) => one.text), `${when}: today's mark`).toEqual([String(Number(today.slice(8, 10)))]);
            expect(marked[0]!.paint, 'the mark is not the ink').toContain(read.ink);
          } else {
            expect(marked, `${when}: a mark on a month today is not in`).toEqual([]);
          }
          expect((await picturesIn(page, id)).codePoints).toEqual([]);
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );

  it(
    'lays the month out in the household’s own week, and says "Today!" on the day',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      // 1 October 2026 is a Thursday: the fourth column from a Monday, the fifth from a Sunday.
      for (const [weekStart, heads, lead] of [
        ['monday', ['M', 'T', 'W', 'T', 'F', 'S', 'S'], 3],
        ['sunday', ['S', 'M', 'T', 'W', 'T', 'F', 'S'], 4],
      ] as const) {
        cw.wall.db.prepare("UPDATE household_settings SET week_start = ? WHERE id = 'singleton'").run(weekStart);
        await setCountdown(cw, { variant: 'month', target: '2026-10-07', title: 'Holiday' }, { w: 0.9, h: 0.45 });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const read = await readSquares(page, id);
          expect(read.heads, weekStart).toEqual(heads);
          expect(read.squares.findIndex((one) => one.text === '1'), weekStart).toBe(lead);
          // Seven columns: the first of the month shares its row with the blanks before it.
          expect(read.squares[lead]!.rect[1]).toBe(read.squares[0]!.rect[1]);
        } finally {
          await close();
        }
      }
      cw.wall.db.prepare("UPDATE household_settings SET week_start = 'sunday' WHERE id = 'singleton'").run();

      await setCountdown(cw, { variant: 'month', target: civilDate(cw.wall.now(), 0), title: 'Holiday' }, { w: 0.9, h: 0.45 });
      const { page, close } = await loadWallSettled(cw.link, size);
      try {
        const num = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdm-num`, (n) => ({
          text: n.textContent,
          img: n.querySelector('img')?.getAttribute('src') ?? null,
        }));
        expect(num).toEqual({ text: 'Today!', img: '/assets/emoji/party-popper.svg' });
        // On the day the target is today: ringed and marked, the one square.
        const read = await readSquares(page, id);
        const both = read.squares.filter((one) => one.paint.includes('radial-gradient') && one.paint.includes('linear-gradient'));
        expect(both).toHaveLength(1);
        const box = await readCountdownBox(page, id);
        expect(box.clipped).toEqual([]);
        expect(box.belted).toBe(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the grid is the target month’s alone', () => {
  it(
    'draws every square at the same rectangle on two days, while the count moves',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[1]!;
      const id = cw.box[size.orientation].id;
      await setCountdown(cw, { variant: 'month', target: '2027-01-30', title: 'Holiday' }, { w: 0.9, h: 0.6 });
      const first = await loadWallSettled(cw.link, size);
      let before: Awaited<ReturnType<typeof readSquares>>;
      let countBefore: string | null;
      try {
        before = await readSquares(first.page, id);
        countBefore = await first.page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdm-num`, (n) => n.textContent);
      } finally {
        await first.close();
      }
      cw.wall.shiftClock(86_400_000);
      const second = await loadWallSettled(cw.link, size);
      try {
        const after = await readSquares(second.page, id);
        const countAfter = await second.page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdm-num`, (n) => n.textContent);
        expect(Number(countAfter), 'the count did not move a day').toBe(Number(countBefore) - 1);
        expect(after.squares.map((one) => one.rect)).toEqual(before.squares.map((one) => one.rect));
      } finally {
        await second.close();
        cw.wall.shiftClock(-86_400_000);
      }
    },
    SLOW,
  );
});
