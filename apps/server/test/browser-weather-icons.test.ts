/**
 * The forecast's Meteocons pictures, measured on a real wall (plan item M5.9).
 *
 * The shipped Classic seed with the London capture in it, paired and drawn in
 * a real Chromium at 1080x1920, the way every forecast look is measured
 * (`browser-weather-looks.ts`):
 *
 *  1. **Absent is the drawn set**: a forecast nobody has touched draws the
 *     drawn glyphs and asks for no picture at all.
 *  2. **A chosen set is bundled artwork in the glyph's own box**: every day's
 *     picture is an `<img>` on this origin under `/assets/meteocons/<set>/`,
 *     that loaded, that is the day's sky, and whose rectangle is the drawn
 *     glyph's to the pixel — so choosing a set moves nothing on the wall.
 *  3. **The Today card and the range rows** wear the set too: the card's
 *     picture is now's sky, the hours wear their own hour's, and a list holds
 *     still.
 *  4. **A picture moves whole, within its scope (MQ7)**: by keyframes this
 *     stylesheet declares, locked to the wall clock, resuming across a real
 *     redraw, and still for a device that asks for reduced motion — never by
 *     anything in the SVG, which the server's own test holds to carrying none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import { SIZES, measureScreen, setWeather, weatherWall, type WeatherWall } from './browser-weather-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

let ww: WeatherWall;

beforeAll(async () => {
  ww = await weatherWall({ hours: true });
}, SLOW);

afterAll(async () => {
  await ww?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** The daytime picture each sky wears — `meteoconFor` in the display, written out by hand. */
const DAY_PICTURE: Readonly<Record<string, string>> = {
  clear: 'clear-day',
  'mostly-clear': 'mostly-clear-day',
  'partly-cloudy': 'partly-cloudy-day',
  cloudy: 'cloudy',
  fog: 'fog-day',
  drizzle: 'drizzle',
  rain: 'rain',
  showers: 'partly-cloudy-day-rain',
  snow: 'snow',
  sleet: 'sleet',
  thunderstorm: 'thunderstorms-rain',
  wind: 'wind',
};

interface Drawn {
  readonly tag: string;
  readonly icon: string | null;
  readonly src: string | null;
  readonly origin: string;
  readonly loaded: boolean;
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly motion: string;
}

async function pictures(page: Page, id: string, selector: string): Promise<Drawn[]> {
  await page.waitForFunction(
    ({ id, selector }) =>
      Array.from(document.querySelectorAll<HTMLImageElement>(`#wall .canvas .fw[data-widget-id="${id}"] ${selector}`))
        .every((node) => node.tagName !== 'IMG' || node.complete),
    { id, selector },
    { timeout: 20_000, polling: 50 },
  );
  return page.evaluate(
    ({ id, selector }) =>
      Array.from(document.querySelectorAll<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"] ${selector}`)).map(
        (node) => {
          const rect = node.getBoundingClientRect();
          const img = node as unknown as HTMLImageElement;
          return {
            tag: node.tagName,
            icon: node.getAttribute('data-icon'),
            src: node.getAttribute('src'),
            origin: node.tagName === 'IMG' ? new URL(img.currentSrc || img.src).origin : '',
            loaded: node.tagName === 'IMG' ? img.complete && img.naturalWidth > 0 : false,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            motion: getComputedStyle(node).animationName,
          };
        },
      ),
    { id, selector },
  );
}

describe('the picture set', () => {
  it(
    'is the drawn set when nobody has chosen, and asks for no picture',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, {});
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const drawn = await pictures(page, id, '.wx-ico');
        expect(drawn.length).toBeGreaterThan(0);
        expect(drawn.every((one) => one.tag === 'svg')).toBe(true);
        expect(await page.evaluate(() => document.querySelectorAll('img.wxi').length)).toBe(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  for (const set of ['fill', 'line'] as const) {
    it(
      `draws the ${set} pictures, bundled and loaded, each the day's sky, in the drawn glyph's own box`,
      async () => {
        measureScreen(ww, undefined);
        const size = SIZES[0]!;
        const id = ww.weather[size.orientation].id;

        await setWeather(ww, size.orientation, {});
        const glyphs = await (async () => {
          const { page, close } = await loadWallSettled(ww.link, size);
          try {
            return await pictures(page, id, '.wx-ico');
          } finally {
            await close();
          }
        })();

        await setWeather(ww, size.orientation, { icons: set });
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          // Held still, because a rectangle counts a transform and a picture
          // mid-sway is somewhere its layout box is not.
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const drawn = await pictures(page, id, '.wx-ico');
          const origin = await page.evaluate(() => location.origin);
          expect(drawn).toHaveLength(glyphs.length);
          drawn.forEach((one, index) => {
            const glyph = ww.days[index]?.glyph ?? '';
            const file = DAY_PICTURE[glyph];
            expect(file, `day ${index} has a sky the wall knows`).toBeDefined();
            expect(one.tag).toBe('IMG');
            expect(one.src).toBe(`/assets/meteocons/${set}/${file}.svg`);
            expect(one.icon).toBe(`${set}/${file}`);
            expect(one.origin).toBe(origin);
            expect(one.loaded, `${one.src} loaded`).toBe(true);
            // The glyph's box, to the pixel: choosing a set moves nothing.
            const was = glyphs[index]!.rect;
            expect(Math.abs(one.rect.x - was.x)).toBeLessThan(0.5);
            expect(Math.abs(one.rect.y - was.y)).toBeLessThan(0.5);
            expect(Math.abs(one.rect.w - was.w)).toBeLessThan(0.5);
            expect(Math.abs(one.rect.h - was.h)).toBeLessThan(0.5);
          });
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }

  it(
    'dresses the Today card in now’s sky and each hour in its own, and holds the hours and the range rows still',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, { variant: 'today', icons: 'fill' }, { h: 0.3 });
      let page: Page;
      let { page: today, close } = await loadWallSettled(ww.link, size);
      page = today;
      try {
        const [lede] = await pictures(page, id, '.wt-glyph');
        expect(lede?.tag).toBe('IMG');
        expect(lede?.loaded).toBe(true);
        expect(lede?.icon).toMatch(/^fill\//);
        const hours = await pictures(page, id, '.wt-hour-ico');
        expect(hours.length).toBeGreaterThan(0);
        for (const hour of hours) {
          expect(hour.tag).toBe('IMG');
          expect(hour.loaded).toBe(true);
          expect(hour.motion).toBe('none');
        }
      } finally {
        await close();
      }

      await setWeather(ww, size.orientation, { variant: 'range', icons: 'line' }, { h: 0.3 });
      ({ page: today, close } = await loadWallSettled(ww.link, size));
      page = today;
      try {
        const rows = await pictures(page, id, '.wr-ico');
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.tag).toBe('IMG');
          expect(row.icon).toMatch(/^line\//);
          expect(row.loaded).toBe(true);
          expect(row.motion).toBe('none');
        }
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

/** The night picture of each sky that has one; the rest are their daytime picture. */
const NIGHT_PICTURE: Readonly<Record<string, string>> = {
  'mostly-clear': 'mostly-clear-night',
  'partly-cloudy': 'partly-cloudy-night',
  fog: 'fog-night',
  showers: 'partly-cloudy-night-rain',
};

describe('the hours after dark', () => {
  it(
    'wear their own hour’s sky: a night hour its night picture, a clear night the moon',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, { variant: 'today', icons: 'fill' }, { h: 0.3 });
      // Into the evening: the harness pins eleven o'clock, when every hour on
      // the card is daylight and no test could tell a night picture from a day one.
      const evening = 7 * 3_600_000;
      ww.wall.shiftClock(evening);
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const cached = (
          JSON.parse(
            (ww.wall.db.prepare(`SELECT payload FROM weather_cache WHERE cache_key = 'openmeteo:hourly'`).get() as {
              payload: string;
            }).payload,
          ) as { hours: { at: number; end: number; glyph: string | null; isDay: boolean }[] }
        ).hours.filter((hour) => hour.end > ww.wall.now());
        const drawn = await pictures(page, id, '.wt-hour-ico');
        expect(drawn.length).toBeGreaterThan(0);
        const shown = cached.slice(0, drawn.length);
        // The premise: some of what is drawn is dark, or this proves nothing.
        expect(shown.some((hour) => !hour.isDay), 'an hour after sunset is on the card').toBe(true);
        drawn.forEach((one, index) => {
          const hour = shown[index]!;
          const glyph = hour.glyph ?? '';
          if (!hour.isDay && glyph === 'clear') {
            expect(one.icon).toMatch(/^fill\/moon-/);
            return;
          }
          const file = hour.isDay ? DAY_PICTURE[glyph] : (NIGHT_PICTURE[glyph] ?? DAY_PICTURE[glyph]);
          expect(one.icon, `hour ${index}, ${glyph} ${hour.isDay ? 'by day' : 'by night'}`).toBe(`fill/${file}`);
        });
      } finally {
        await close();
        ww.wall.shiftClock(-evening);
      }
    },
    SLOW,
  );
});

describe('in the editor', () => {
  it(
    'draws the pictures from a relative address, so they load under the admin’s base',
    async () => {
      measureScreen(ww, undefined);
      await setWeather(ww, 'portrait', { icons: 'fill' });
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await ww.wall.signIn(page);
        await page.goto(`${ww.wall.base}/admin/walls/${encodeURIComponent(ww.screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        const read = (): Promise<{ src: string | null; loaded: boolean }[]> =>
          page.evaluate(() =>
            Array.from(
              document.querySelector<HTMLElement>('.le-preview')?.shadowRoot?.querySelectorAll<HTMLImageElement>('img.wxi') ?? [],
            ).map((img) => ({ src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 })),
          );
        await page.waitForFunction(
          () => {
            const imgs = Array.from(
              document.querySelector<HTMLElement>('.le-preview')?.shadowRoot?.querySelectorAll<HTMLImageElement>('img.wxi') ?? [],
            );
            return imgs.length > 0 && imgs.every((img) => img.complete);
          },
          undefined,
          { timeout: 20_000, polling: 50 },
        );
        const drawn = await read();
        expect(drawn.length).toBeGreaterThan(0);
        for (const one of drawn) {
          expect(one.src).toMatch(/^assets\/meteocons\/fill\/[a-z-]+\.svg$/);
          expect(one.loaded, `${one.src} loaded`).toBe(true);
        }
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** `ICON_MOTION_MS` in `apps/display/src/weather-icons.ts`. */
const CYCLE_MS: Readonly<Record<string, number>> = { 'wxi-spin': 27_000, 'wxi-sway': 6_200 };
const TOLERANCE_MS = 300;

function around(a: number, b: number, cycle: number): number {
  const d = (((a - b) % cycle) + cycle) % cycle;
  return Math.min(d, cycle - d);
}

async function readPhase(
  page: Page,
  selector: string,
  mark = false,
): Promise<{ name: string; delay: string; running: number; phase: number | undefined; startTime: number | undefined; at: number }> {
  return page.evaluate(
    async ({ selector, mark }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`nothing on the wall matches ${selector}`);
      const running = node.getAnimations();
      await Promise.all(running.map((one) => one.ready));
      const first = running[0];
      const timing = first?.effect?.getComputedTiming();
      const local = typeof timing?.localTime === 'number' ? timing.localTime : undefined;
      const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
      if (mark) node.dataset['seen'] = '1';
      const at = document.timeline.currentTime;
      return {
        name: getComputedStyle(node).animationName,
        delay: getComputedStyle(node).animationDelay,
        running: running.filter((one) => one.playState === 'running').length,
        phase: local === undefined ? undefined : local - delay,
        startTime: typeof first?.startTime === 'number' ? first.startTime : undefined,
        at: typeof at === 'number' ? at : 0,
      };
    },
    { selector, mark },
  );
}

describe('a picture moves whole, within its scope', () => {
  it(
    'is locked to the wall clock and resumes across a real redraw',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, { icons: 'fill' });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const first = `#wall .canvas .fw[data-widget-id="${id}"] .wx-day:nth-child(1) img.wxi`;
        const before = await readPhase(page, first, true);
        const cycle = CYCLE_MS[before.name];
        expect(cycle, `the first picture moves by one of this stylesheet's loops, not ${before.name}`).toBeDefined();
        expect(before.running).toBe(1);
        expect(before.delay).toMatch(/^-\d/);

        // The next fifteen-second rebuild replaces the node; the new one resumes.
        await page.waitForFunction(
          (sel) => {
            const node = document.querySelector<HTMLElement>(sel);
            return node !== null && node.dataset['seen'] === undefined;
          },
          first,
          { timeout: 25_000, polling: 50 },
        );
        const after = await readPhase(page, first);
        expect(after.name).toBe(before.name);
        const expected = (before.phase as number) + (after.at - before.at);
        expect(around(after.phase as number, expected, cycle as number)).toBeLessThan(TOLERANCE_MS);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is still for a device that asks for reduced motion',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, { icons: 'fill' });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const picture = `#wall .canvas .fw[data-widget-id="${id}"] img.wxi`;
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const still = await readPhase(page, picture);
        expect(still.running).toBe(0);
        expect(still.name).toBe('none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect(CYCLE_MS[(await readPhase(page, picture)).name]).toBeDefined();
      } finally {
        await close();
      }
    },
    SLOW,
  );
});
