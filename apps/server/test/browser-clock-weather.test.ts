/**
 * The clock's weather line, measured on a real wall (plan item M5.10).
 *
 * The shipped Classic seed with the London capture in its forecast cache, as
 * every forecast look is measured (`browser-weather-looks.ts`), and the
 * Classic clock set the way the editor sets it — the real `POST /admin/layout`.
 *
 *  1. **Absent is no line**: a clock nobody has touched draws no line and is
 *     not given the line's room.
 *  2. **The line says now, from the forecast the wall holds**: the current
 *     reading's temperature and the readings asked for, with the forecast's
 *     own picture set; and today's high and low when there is no reading.
 *  3. **Nothing is clipped, on any look**: the digits, the date lines and the
 *     weather line each fit across their box, the line ends inside the box,
 *     the analogue face sits above it, and its figures are tabular.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import { SIZES, measureScreen, weatherWall, type Orientation, type WeatherWall } from './browser-weather-looks.js';
import { readLayoutWidgets } from '../src/api/queries.js';

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

/** The Classic clock's id on a canvas. */
function clockId(orientation: Orientation): string {
  const row = readLayoutWidgets(ww.wall.db, ww.screenId, orientation).find((one) => one.type === 'clock');
  if (row === undefined) throw new Error(`Classic seeded no clock on the ${orientation} canvas`);
  return row.id;
}

/** Set the clock's config the way the editor does, with the whole canvas through the schema. */
async function setClock(
  orientation: Orientation,
  config: Record<string, unknown>,
  resize?: { readonly w: number },
): Promise<void> {
  const id = clockId(orientation);
  const widgets = readLayoutWidgets(ww.wall.db, ww.screenId, orientation).map((row) => {
    const merged = row.id === id ? config : { ...((row.config as Record<string, unknown> | null) ?? {}) };
    const clock = row.id === id;
    return {
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      // A narrower clock keeps its place and its height, and is drawn on top.
      w: clock && resize !== undefined ? resize.w : row.w,
      h: row.h,
      z: clock && resize !== undefined ? 100 : row.z,
      ...(Object.keys(merged).length > 0 ? { config: merged } : {}),
    };
  });
  const aspects = ww.wall.db
    .prepare('SELECT layout_aspect AS p, layout_landscape_aspect AS l FROM screens WHERE id = ?')
    .get(ww.screenId) as { p: number; l: number };
  const saved = await ww.wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: ww.screenId,
      orientation,
      mode: 'freeform',
      aspect: orientation === 'portrait' ? aspects.p : aspects.l,
      widgets,
    }),
  });
  expect(saved.status, `saving the clock ${JSON.stringify(config)}`).toBe(200);
}

interface ClockRead {
  readonly wx: boolean;
  readonly line: {
    readonly mode: string | null;
    readonly temp: string;
    readonly parts: readonly string[];
    readonly picture: { readonly tag: string; readonly src: string | null; readonly loaded: boolean } | null;
    readonly numeric: string;
  } | null;
  /** Every visible run in the clock box whose content is wider than its box, or that ends past the box. */
  readonly clipped: readonly string[];
  /** The analogue face's bottom and the line's top, when both are drawn. */
  readonly faceBottom: number | undefined;
  readonly lineTop: number | undefined;
}

async function readClock(page: Page, id: string): Promise<ClockRead> {
  await page.waitForFunction(
    (id) =>
      Array.from(document.querySelectorAll<HTMLImageElement>(`#wall .canvas .fw[data-widget-id="${id}"] img`)).every(
        (img) => img.complete,
      ),
    id,
    { timeout: 20_000, polling: 50 },
  );
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error(`no clock box ${id}`);
    const clock = box.querySelector<HTMLElement>('.fw-clock');
    const style = getComputedStyle(box);
    const outer = box.getBoundingClientRect();
    const bottom = outer.bottom - parseFloat(style.paddingBottom);
    const clipped: string[] = [];
    for (const node of Array.from(box.querySelectorAll<HTMLElement>('.clock, .today-date, .clk-day, .clk-date, .clk-wx-line'))) {
      const rect = node.getBoundingClientRect();
      if (node.scrollWidth > node.clientWidth + 1) clipped.push(`${node.className} is cut across`);
      if (rect.bottom > bottom + 1) clipped.push(`${node.className} ends ${(rect.bottom - bottom).toFixed(1)}px past the box`);
    }
    const lineNode = box.querySelector<HTMLElement>('.clk-wx-line');
    const pictureNode = lineNode?.querySelector('.clk-wx-ico') ?? null;
    const face = box.querySelector('.clk-face');
    return {
      wx: clock?.classList.contains('clk-wx') ?? false,
      line:
        lineNode === null
          ? null
          : {
              mode: lineNode.getAttribute('data-weather'),
              temp: lineNode.querySelector('.clk-wx-temp')?.textContent ?? '',
              parts: Array.from(lineNode.querySelectorAll('.clk-wx-part')).map((part) => part.textContent ?? ''),
              picture:
                pictureNode === null
                  ? null
                  : {
                      tag: pictureNode.tagName,
                      src: pictureNode.getAttribute('src'),
                      loaded:
                        pictureNode.tagName !== 'IMG' ||
                        ((pictureNode as HTMLImageElement).complete && (pictureNode as HTMLImageElement).naturalWidth > 0),
                    },
              numeric: getComputedStyle(lineNode.querySelector('.clk-wx-temp') as Element).fontVariantNumeric,
            },
      clipped,
      faceBottom: face === null ? undefined : face.getBoundingClientRect().bottom,
      lineTop: lineNode === null ? undefined : lineNode.getBoundingClientRect().top,
    };
  }, id);
}

describe('the clock’s weather line', () => {
  it(
    'is not drawn, and costs the clock nothing, until it is switched on',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setClock(size.orientation, {});
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const read = await readClock(page, clockId(size.orientation));
        expect(read.line).toBeNull();
        expect(read.wx).toBe(false);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  for (const size of SIZES) {
    it(
      `says now, with the readings asked for, and fits on every look at ${size.width}x${size.height}`,
      async () => {
        measureScreen(ww, undefined);
        const id = clockId(size.orientation);
        for (const variant of [undefined, 'stacked', 'analogue'] as const) {
          await setClock(size.orientation, {
            ...(variant === undefined ? {} : { variant }),
            showWeather: true,
            weatherReadings: ['humidity', 'wind', 'uv'],
          });
          const { page, close } = await loadWallSettled(ww.link, size);
          try {
            const read = await readClock(page, id);
            const look = variant ?? 'plain';
            expect(read.wx, look).toBe(true);
            expect(read.line?.mode, look).toBe('now');
            // The reading the cache holds, as the forecast widget would say it.
            expect(read.line?.temp, look).toBe(`${Math.round(ww.currentTemp)}°`);
            // London's capture carries all three.
            expect(read.line?.parts, look).toHaveLength(3);
            expect(read.line?.parts[0], look).toMatch(/^\d+%$/);
            expect(read.line?.parts[1], look).toMatch(/km\/h$/);
            expect(read.line?.parts[2], look).toMatch(/^UV \d+$/);
            expect(read.line?.picture?.tag, look).toBe('svg');
            expect(read.line?.numeric, look).toContain('tabular-nums');
            expect(read.clipped, look).toEqual([]);
            if (variant === 'analogue') {
              expect(read.faceBottom, 'the face sits above the line').toBeLessThanOrEqual((read.lineTop ?? 0) + 0.5);
            }
          } finally {
            await close();
          }
        }
      },
      SLOW,
    );
  }

  it(
    'shrinks a long line to a narrow box rather than cutting it',
    async () => {
      // A clock a fifth of the wall wide, carrying everything: the box where
      // the line's own length, and not its height, is what has to give.
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setClock(size.orientation, { showWeather: true, weatherReadings: ['humidity', 'wind', 'uv'] }, { w: 0.2 });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const read = await readClock(page, clockId(size.orientation));
        expect(read.line?.parts).toHaveLength(3);
        expect(read.clipped).toEqual([]);
      } finally {
        await close();
        await setClock(size.orientation, {});
      }
    },
    SLOW,
  );

  it(
    'wears the forecast’s picture set',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setClock(size.orientation, { showWeather: true, icons: 'fill' });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const read = await readClock(page, clockId(size.orientation));
        expect(read.line?.picture?.tag).toBe('IMG');
        expect(read.line?.picture?.src).toMatch(/^\/assets\/meteocons\/fill\/[a-z-]+\.svg$/);
        expect(read.line?.picture?.loaded).toBe(true);
        expect(read.line?.parts).toEqual([]);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'says today’s high and low when there is no reading for now',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setClock(size.orientation, { showWeather: true });
      const saved = ww.wall.db
        .prepare(`SELECT payload FROM weather_cache WHERE cache_key = 'openmeteo:current'`)
        .get() as { payload: string };
      ww.wall.db.prepare(`DELETE FROM weather_cache WHERE cache_key = 'openmeteo:current'`).run();
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const read = await readClock(page, clockId(size.orientation));
        expect(read.line?.mode).toBe('today');
        const today = ww.days[0]!;
        expect(read.line?.temp).toBe(`${Math.round(today.high)}° / ${Math.round(today.low)}°`);
      } finally {
        await close();
        ww.wall.db
          .prepare(
            `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
             VALUES ('openmeteocurrent', 'openmeteo', 'openmeteo:current', ?, ?, NULL)`,
          )
          .run(saved.payload, ww.wall.now());
      }
    },
    SLOW,
  );
});
