/**
 * The forecast's `range` look, measured (plan item P5.1, "iOS 10-day").
 *
 * RFC 014 §4.2's rule, as every designed look carries it: a real paired wall,
 * the shipped Classic seed with three family calendars, at 1080x1920 and
 * 1920x1080, on a wall nobody has measured and on one set to a 32" television
 * read from 1.2 metres — and the forecast is **the captured London answer**
 * (`browser-weather-looks.ts` says how it is seeded), so the bars are drawn from
 * a real week's highs, lows and rain chances.
 *
 *  1. **Nothing clipped, nothing belted, tabular figures, role sizes.** Every
 *     run and picture sits inside the box and no `nowrap` run is cut, read as
 *     `scrollWidth` against `clientWidth`; the belt had nothing to hide, which
 *     is what says the tier and the day count were chosen right rather than
 *     rescued; every figure is `tabular-nums` as computed; and on the measured
 *     wall the temperatures and the name are the event role and the rain chance
 *     the scaffold's, to the px the page itself resolves those roles to.
 *  2. **The bar is the week's scale.** Each day's window runs from its low to
 *     its high on one scale — the coldest reading of the whole forecast at the
 *     track's left and the warmest at its right — read off the drawn rects and
 *     held to the real numbers, not to anything the renderer stamped. Every
 *     row's ramp is the track's own width and position, which is what makes a
 *     temperature one colour on every row, and it is painted from the theme's
 *     four `--temp-*` tokens as the page computes them.
 *  3. **Now is a dot on today's bar**, at the current reading's place on the
 *     scale, and nowhere else; with no current reading, there is no dot.
 *  4. **What a narrow box gives up, in order**: the rain chance first, then the
 *     glyph, and never the bar or its numbers; a shorter box gives up days
 *     from the bottom and keeps the scale.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  SIZES,
  WALLS,
  measureScreen,
  readForecastBox,
  roleSizes,
  setWeather,
  tokenColours,
  wallName,
  weatherWall,
  type WeatherWall,
} from './browser-weather-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

let ww: WeatherWall;

beforeAll(async () => {
  ww = await weatherWall();
}, SLOW);

afterAll(async () => {
  await ww?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface RangeRow {
  readonly name: string;
  readonly track: readonly [number, number];
  readonly fill: readonly [number, number] | undefined;
  readonly ramp: readonly [number, number] | undefined;
  readonly rampImage: string;
  readonly now: number | undefined;
  readonly fonts: Record<string, number>;
  readonly cells: Record<string, number>;
}

async function readRows(page: Page, widgetId: string): Promise<RangeRow[]> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error('no forecast box');
    const span = (el: Element | null): [number, number] | undefined => {
      if (el === null) return undefined;
      const r = el.getBoundingClientRect();
      return [r.left, r.right];
    };
    return Array.from(box.querySelectorAll<HTMLElement>('.wr-row'))
      .filter((row) => row.style.display !== 'none')
      .map((row) => {
        const bar = row.querySelector('.wr-bar');
        const ramp = row.querySelector<HTMLElement>('.wr-ramp');
        const dot = row.querySelector('.wr-now');
        const fonts: Record<string, number> = {};
        const cells: Record<string, number> = {};
        for (const cls of ['wr-name', 'wr-lo', 'wr-hi', 'wr-rain']) {
          const cell = row.querySelector(`.${cls}`);
          if (cell !== null) fonts[cls] = parseFloat(getComputedStyle(cell).fontSize);
        }
        for (const cls of ['wr-name', 'wr-ico', 'wr-rain', 'wr-lo', 'wr-bar', 'wr-hi']) {
          cells[cls] = row.querySelectorAll(`.${cls}`).length;
        }
        const d = dot?.getBoundingClientRect();
        return {
          name: row.querySelector('.wr-name')?.textContent ?? '',
          track: span(bar) as [number, number],
          fill: span(row.querySelector('.wr-fill')),
          ramp: span(ramp),
          rampImage: ramp === null ? '' : getComputedStyle(ramp).backgroundImage,
          now: d === undefined ? undefined : (d.left + d.right) / 2,
          fonts,
          cells,
        };
      });
  }, widgetId);
}

/** The week's scale from the real numbers: every high and low, and the current reading. */
function expectedScale(withCurrent: boolean): { min: number; max: number } {
  const values = ww.days.flatMap((day) => [day.low, day.high]);
  if (withCurrent) values.push(ww.currentTemp);
  return { min: Math.min(...values), max: Math.max(...values) };
}

describe('the range look on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `draws a week of bars on one scale, clipped nowhere, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(ww, preset);
          const id = ww.weather[size.orientation].id;
          // Classic's own forecast box, then the same box grown to hold the week.
          for (const resize of [undefined, { h: 0.3 }]) {
            await setWeather(ww, size.orientation, { variant: 'range' }, resize);
            const { page, close } = await loadWallSettled(ww.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${resize === undefined ? 'seed box' : 'tall box'}`;
              const box = await readForecastBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              expect(box.numerals.length, `${where}: no figures drawn`).toBeGreaterThan(0);
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');

              const rows = await readRows(page, id);
              expect(rows.length, where).toBe(box.items);
              expect(rows.length, `${where} drew no day`).toBeGreaterThanOrEqual(1);
              if (resize !== undefined) expect(rows.length, `${where}: the week does not fit a box this tall`).toBe(5);

              // 2. One scale, the whole forecast's, whatever the box drew.
              const scale = expectedScale(true);
              const colours = await tokenColours(page, id, ['--temp-cold', '--temp-cool', '--temp-warm', '--temp-hot']);
              rows.forEach((row, i) => {
                const day = ww.days[i]!;
                const [left, right] = row.track;
                const at = (value: number): number => left + ((value - scale.min) / (scale.max - scale.min)) * (right - left);
                expect(row.fill, `${where} ${row.name} has no bar`).toBeDefined();
                expect(Math.abs(row.fill![0] - at(day.low)), `${where} ${row.name}'s bar starts`).toBeLessThanOrEqual(1);
                expect(Math.abs(row.fill![1] - at(day.high)), `${where} ${row.name}'s bar ends`).toBeLessThanOrEqual(1);
                // Every row's ramp is one track wide and sits on the track.
                expect(Math.abs(row.ramp![0] - left), `${where} ${row.name}'s ramp is not the track's`).toBeLessThanOrEqual(1);
                expect(Math.abs(row.ramp![1] - right), `${where} ${row.name}'s ramp is not the track's`).toBeLessThanOrEqual(1);
                for (const [token, colour] of Object.entries(colours)) {
                  expect(row.rampImage, `${where} ${row.name}'s ramp lacks ${token}`).toContain(colour);
                }
              });

              // 3. Now, on today's bar and no other.
              expect(rows[0]!.now, `${where}: no dot on today`).toBeDefined();
              const [left, right] = rows[0]!.track;
              const expectedNow = left + ((ww.currentTemp - scale.min) / (scale.max - scale.min)) * (right - left);
              expect(Math.abs(rows[0]!.now! - expectedNow), `${where}: the dot is not at ${ww.currentTemp}°`).toBeLessThanOrEqual(1);
              for (const row of rows.slice(1)) expect(row.now, `${where}: a dot on ${row.name}`).toBeUndefined();

              // 1. Role sizes, on a wall whose roles are set.
              const roles = await roleSizes(page);
              if (preset !== undefined) {
                for (const row of rows) {
                  expect(row.fonts['wr-name'], `${where} ${row.name}'s name`).toBeCloseTo(roles['event']!, 1);
                  expect(row.fonts['wr-lo'], `${where} ${row.name}'s low`).toBeCloseTo(roles['event']!, 1);
                  expect(row.fonts['wr-hi'], `${where} ${row.name}'s high`).toBeCloseTo(roles['event']!, 1);
                  if (row.fonts['wr-rain'] !== undefined) {
                    expect(row.fonts['wr-rain'], `${where} ${row.name}'s rain chance`).toBeCloseTo(roles['scaffold']!, 1);
                  }
                }
              } else {
                expect(roles['event'], 'an unmeasured wall resolved a role').toBeUndefined();
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

describe('what a range gives up, and what it keeps', () => {
  it(
    'gives up the rain chance first, then the glyph, and never the bar or its numbers',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      const seen: { w: number; rungs: string; cells: Record<string, number>; bar: number; em: number }[] = [];
      for (const w of [0.9, 0.6, 0.45, 0.36, 0.3, 0.25]) {
        await setWeather(ww, size.orientation, { variant: 'range' }, { w, h: 0.3 });
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          const box = await readForecastBox(page, id);
          expect(box.clipped, `at w=${w}`).toEqual([]);
          expect(box.belted, `at w=${w}`).toBe(0);
          const rows = await readRows(page, id);
          seen.push({
            w,
            rungs: box.rungs ?? '',
            cells: rows[0]!.cells,
            bar: rows[0]!.track[1] - rows[0]!.track[0],
            em: rows[0]!.fonts['wr-hi'] ?? 0,
          });
        } finally {
          await close();
        }
      }
      const has = (one: (typeof seen)[number], cls: string): boolean => (one.cells[cls] ?? 0) > 0;
      // The widest box draws every column; every box draws the bar and both numbers.
      expect(has(seen[0]!, 'wr-rain') && has(seen[0]!, 'wr-ico'), JSON.stringify(seen[0])).toBe(true);
      for (const one of seen) {
        for (const cls of ['wr-name', 'wr-lo', 'wr-bar', 'wr-hi']) expect(has(one, cls), `${cls} at w=${one.w}`).toBe(true);
      }
      // The rain chance goes before the glyph, and neither comes back as the box narrows.
      const lostRain = seen.findIndex((one) => !has(one, 'wr-rain'));
      const lostGlyph = seen.findIndex((one) => !has(one, 'wr-ico'));
      expect(lostRain, 'no width gave up the rain chance').toBeGreaterThan(0);
      expect(lostGlyph, 'no width gave up the glyph').toBeGreaterThan(lostRain);
      for (const one of seen.slice(lostRain)) expect(has(one, 'wr-rain'), `rain back at w=${one.w}`).toBe(false);
      for (const one of seen.slice(lostGlyph)) expect(has(one, 'wr-ico'), `glyph back at w=${one.w}`).toBe(false);
      // Above the table's floor the bar keeps the length `RANGE_TIERS` budgets
      // for it (4ch, about 1.6em of the temperature): the widths are asked of
      // the room *beside the name*, and a tier read off the whole box keeps a
      // column the name has already spent the room for, shortening the bar.
      for (const one of seen.filter((entry) => has(entry, 'wr-ico'))) {
        expect(one.bar, `the bar at w=${one.w} is ${one.bar}px against ${one.em}px type`).toBeGreaterThanOrEqual(1.5 * one.em);
      }
      // And the stamp says so, rung for rung.
      expect(seen[lostRain]!.rungs).toBe('bar low high glyph');
      expect(seen[lostGlyph]!.rungs).toBe('bar low high');
    },
    SLOW,
  );

  it(
    'gives up days from the bottom in a shorter box, on the same scale',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      const read = async (h: number): Promise<RangeRow[]> => {
        await setWeather(ww, size.orientation, { variant: 'range' }, { h });
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          return await readRows(page, id);
        } finally {
          await close();
        }
      };
      const tall = await read(0.3);
      const short = await read(0.07);
      expect(tall.length).toBe(5);
      expect(short.length).toBeGreaterThanOrEqual(1);
      expect(short.length).toBeLessThan(tall.length);
      // The days it kept are the first ones, and each bar is where it was in the
      // tall box: fewer rows is not a different scale.
      // As fractions of the track, because the track's own width is allowed to
      // move: the rain column is as wide as the widest chance drawn, and "26%"
      // on a fifth day is wider than "3%" on the second.
      const along = (row: RangeRow, x: number): number => (x - row.track[0]) / (row.track[1] - row.track[0]);
      short.forEach((row, i) => {
        expect(row.name).toBe(tall[i]!.name);
        expect(along(row, row.fill![0])).toBeCloseTo(along(tall[i]!, tall[i]!.fill![0]), 2);
        expect(along(row, row.fill![1])).toBeCloseTo(along(tall[i]!, tall[i]!.fill![1]), 2);
      });
    },
    SLOW,
  );

  it(
    'draws no dot when there is no current reading',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setWeather(ww, size.orientation, { variant: 'range' }, { h: 0.3 });
      const saved = ww.wall.db.prepare(`SELECT * FROM weather_cache WHERE cache_key = 'openmeteo:current'`).get();
      ww.wall.db.prepare(`DELETE FROM weather_cache WHERE cache_key = 'openmeteo:current'`).run();
      try {
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          const rows = await readRows(page, ww.weather[size.orientation].id);
          expect(rows.every((row) => row.now === undefined)).toBe(true);
          // And the scale is the forecast's own again, without the reading in it.
          const scale = expectedScale(false);
          const row = rows[0]!;
          const at = (value: number): number => row.track[0] + ((value - scale.min) / (scale.max - scale.min)) * (row.track[1] - row.track[0]);
          expect(Math.abs(row.fill![1] - at(ww.days[0]!.high))).toBeLessThanOrEqual(1);
        } finally {
          await close();
        }
      } finally {
        const row = saved as Record<string, unknown>;
        ww.wall.db
          .prepare('INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(row['id'], row['provider'], row['cache_key'], row['payload'], row['fetched_at'], row['expires_at']);
      }
    },
    SLOW,
  );
});
