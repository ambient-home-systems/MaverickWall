/**
 * The forecast's `playful` look, measured (plan item P5.1).
 *
 * RFC 014 §4.2's rule, as every designed look carries it: a real paired wall,
 * the shipped Classic seed with three family calendars, at 1080x1920 and
 * 1920x1080, on a wall nobody has measured and on a 32" television read from
 * 1.2 metres. The forecast is real: **the Washington capture, in Fahrenheit,
 * started on its third day** — the capture's own first two days are mild, and
 * its third is 76°F, which is the one real day in either capture that raises
 * advice ("Shorts weather", at 75°F and over). Starting the forecast there is
 * how a warm day is reached without writing a temperature nobody measured, and
 * `browser-weather-looks.ts` says so. The London capture, in Celsius, is the
 * other half: a real day on which no rule fires, so no line is drawn.
 *
 *  1. **Nothing clipped, nothing belted, tabular figures, role sizes** — the
 *     names, the temperatures and the advice are the event role on a measured
 *     wall.
 *  2. **The pictures are bundled artwork, never a character (decision D6).**
 *     Every picture is an `<img>` whose source is `/assets/emoji/<key>.svg` on
 *     this origin, that actually loaded, that names itself for a screen
 *     reader, and is the picture for that day's sky; and no emoji code point
 *     reaches the rendered text at all.
 *  3. **The advice line** says "Shorts weather" with its picture on the warm
 *     day, says nothing on the London day, says nothing when switched off, and
 *     is the first thing given up — before any rung of the ladder.
 *  4. **The pictures bob, within their scope**: each runs its keyframes locked
 *     to the wall clock, resumes where it was across a real redraw, and is
 *     still for a device that asks for reduced motion.
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
  wallName,
  weatherWall,
  type WeatherWall,
} from './browser-weather-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

let warm: WeatherWall;
let mild: WeatherWall;

beforeAll(async () => {
  warm = await weatherWall({ capture: 'dc', fromDay: 2 });
  mild = await weatherWall();
}, SLOW);

afterAll(async () => {
  await warm?.wall.dispose();
  await mild?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Picture {
  readonly src: string | null;
  readonly resolved: string;
  readonly alt: string;
  readonly loaded: boolean;
  readonly tag: string;
}

interface Playful {
  readonly days: readonly { readonly name: string; readonly picture: Picture | null; readonly temps: string }[];
  readonly advice: { readonly key: string | null; readonly words: string; readonly picture: Picture | null } | null;
  readonly adviceState: string | null;
  readonly rungs: string | null;
  readonly fonts: Record<string, number>;
  /** Every emoji code point in the box's rendered text: none, if every picture is artwork. */
  readonly codePoints: readonly string[];
  readonly origin: string;
}

async function readPlayful(page: Page, widgetId: string): Promise<Playful> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error('no forecast box');
    const picture = (node: Element | null): Picture | null =>
      node === null
        ? null
        : {
            src: node.getAttribute('src'),
            resolved: (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src,
            alt: node.getAttribute('alt') ?? '',
            loaded: (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0,
            tag: node.tagName,
          };
    const size = (sel: string): number | undefined => {
      const node = box.querySelector(sel);
      return node === null ? undefined : parseFloat(getComputedStyle(node).fontSize);
    };
    const fonts: Record<string, number> = {};
    for (const [name, sel] of [
      ['name', '.wp-name'],
      ['temp', '.wp-temp'],
      ['advice', '.wp-advice'],
    ] as const) {
      const value = size(sel);
      if (value !== undefined) fonts[name] = value;
    }
    const line = box.querySelector('.wp-advice');
    return {
      days: Array.from(box.querySelectorAll('.wp-day')).map((day) => ({
        name: day.querySelector('.wp-name')?.textContent ?? '',
        picture: picture(day.querySelector('.wp-emoji')),
        temps: day.querySelector('.wp-temp')?.textContent ?? '',
      })),
      advice:
        line === null
          ? null
          : {
              key: line.getAttribute('data-advice'),
              words: line.querySelector('.wp-advice-words')?.textContent ?? '',
              picture: picture(line.querySelector('.wp-advice-emoji')),
            },
      adviceState: box.getAttribute('data-advice'),
      rungs: box.getAttribute('data-rungs'),
      fonts,
      codePoints: Array.from((box.innerText ?? '').matchAll(/\p{Extended_Pictographic}/gu)).map((m) => m[0]),
      origin: location.origin,
    };
  }, widgetId);
}

/** Wait for every picture in the box to have finished loading, one way or the other. */
async function picturesSettled(page: Page, widgetId: string): Promise<void> {
  await page.waitForFunction(
    (id) => Array.from(document.querySelectorAll<HTMLImageElement>(`#wall .canvas .fw[data-widget-id="${id}"] img`)).every((img) => img.complete),
    widgetId,
    { timeout: 20_000, polling: 50 },
  );
}

/**
 * The pictures the Washington capture's days wear, from its third day: the
 * 26th and 28th are overcast (WMO 3) and the 27th light drizzle (WMO 53) —
 * `emojiForGlyph`'s table, which `weather-looks.test.ts` pins, applied to this
 * week's real skies.
 */
const WARM_PICTURES = ['cloud', 'cloud-with-rain', 'cloud'];

function expectArtwork(picture: Picture | null, key: string, origin: string, where: string): void {
  expect(picture, `${where}: no picture`).not.toBeNull();
  expect(picture!.tag, where).toBe('IMG');
  expect(picture!.src, where).toBe(`/assets/emoji/${key}.svg`);
  expect(new URL(picture!.resolved).origin, `${where}: fetched from another origin`).toBe(origin);
  expect(picture!.loaded, `${where}: ${key}.svg did not load`).toBe(true);
  expect(picture!.alt.length, `${where}: a picture with no name`).toBeGreaterThan(0);
}

describe('the playful look on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `draws its days with bundled pictures and today's advice, clipped nowhere, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(warm, preset);
          const id = warm.weather[size.orientation].id;
          for (const resize of [undefined, { h: 0.3 }]) {
            await setWeather(warm, size.orientation, { variant: 'playful' }, resize);
            const { page, close } = await loadWallSettled(warm.link, size);
            try {
              await picturesSettled(page, id);
              const where = `${wallName(preset)} ${size.width}x${size.height} ${resize === undefined ? 'seed box' : 'tall box'}`;
              const box = await readForecastBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');

              const drawn = await readPlayful(page, id);
              expect(drawn.days.length, where).toBeGreaterThan(0);
              expect(drawn.days[0]!.name, where).toBe('Today');
              // 2. Pictures are artwork, and the right artwork for each day.
              expect(drawn.codePoints, `${where}: an emoji reached the glass as a character`).toEqual([]);
              drawn.days.forEach((day, i) => {
                if (day.picture !== null) expectArtwork(day.picture, WARM_PICTURES[i]!, drawn.origin, `${where} ${day.name}`);
              });

              if (resize !== undefined) {
                // A tall box draws the whole ladder, pictures and all, and the advice.
                expect(drawn.rungs, where).toBe('name icon high low');
                for (const day of drawn.days) expect(day.picture, `${where} ${day.name}`).not.toBeNull();
                expect(drawn.days[0]!.temps, where).toBe(`${Math.round(warm.days[0]!.high)}° ${Math.round(warm.days[0]!.low)}°F`);
                // 3. The warm day's advice, in words and its own picture.
                expect(drawn.adviceState, where).toBe('shown');
                expect(drawn.advice?.key, where).toBe('shorts');
                expect(drawn.advice?.words, where).toBe('Shorts weather');
                expectArtwork(drawn.advice?.picture ?? null, 'shorts', drawn.origin, `${where} advice`);
              }

              // 1. Role sizes, on a wall whose roles are set.
              const roles = await roleSizes(page);
              if (preset !== undefined) {
                for (const name of ['name', 'temp', 'advice']) {
                  if (drawn.fonts[name] !== undefined) {
                    expect(drawn.fonts[name], `${where} ${name}`).toBeCloseTo(roles['event']!, 1);
                  }
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

describe('the advice line', () => {
  it(
    'says nothing on a real day that calls for nothing: London, 22°C, dry, a UV of 2.75 and a light wind',
    async () => {
      measureScreen(mild, undefined);
      const size = SIZES[0]!;
      const id = mild.weather[size.orientation].id;
      await setWeather(mild, size.orientation, { variant: 'playful' }, { h: 0.3 });
      const { page, close } = await loadWallSettled(mild.link, size);
      try {
        const drawn = await readPlayful(page, id);
        // The whole ladder is drawn, so the line would have had room.
        expect(drawn.rungs).toBe('name icon high low');
        expect(drawn.advice).toBeNull();
        expect(drawn.adviceState).toBe('none');
        // …and the pictures are the London week's: overcast, then drizzle.
        expect(drawn.days[0]!.picture?.src).toBe('/assets/emoji/cloud.svg');
        expect(drawn.days[1]!.picture?.src).toBe('/assets/emoji/cloud-with-rain.svg');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'says nothing when the household switched it off, on the day that would have',
    async () => {
      measureScreen(warm, undefined);
      const size = SIZES[0]!;
      const id = warm.weather[size.orientation].id;
      await setWeather(warm, size.orientation, { variant: 'playful', advice: false }, { h: 0.3 });
      const { page, close } = await loadWallSettled(warm.link, size);
      try {
        const drawn = await readPlayful(page, id);
        expect(drawn.rungs).toBe('name icon high low');
        expect(drawn.advice).toBeNull();
        expect(drawn.adviceState).toBe('none');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is the first thing given up: a box with room for the whole ladder and not the line keeps the ladder',
    async () => {
      measureScreen(warm, undefined);
      const size = SIZES[1]!;
      const id = warm.weather[size.orientation].id;
      const read = async (h: number): Promise<Playful> => {
        await setWeather(warm, size.orientation, { variant: 'playful' }, { h });
        const { page, close } = await loadWallSettled(warm.link, size);
        try {
          const box = await readForecastBox(page, id);
          expect(box.clipped, `at h=${h}`).toEqual([]);
          expect(box.belted, `at h=${h}`).toBe(0);
          return await readPlayful(page, id);
        } finally {
          await close();
        }
      };
      const roomy = await read(0.3);
      const tight = await read(0.2);
      expect(roomy.adviceState).toBe('shown');
      // The premise: the tighter box still draws every rung, so the line — and
      // only the line — is what it gave up.
      expect(tight.rungs).toBe('name icon high low');
      expect(tight.adviceState).toBe('given-up');
      expect(tight.advice).toBeNull();
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** `PLAYFUL_BOB_MS` in `apps/display/src/weather-looks.ts`. */
const BOB_MS = 4_200;
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
      const animations = node.getAnimations();
      await Promise.all(animations.map((one) => one.ready));
      const first = animations[0];
      const timing = first?.effect?.getComputedTiming();
      const local = typeof timing?.localTime === 'number' ? timing.localTime : undefined;
      const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
      if (mark) node.dataset['seen'] = '1';
      const at = document.timeline.currentTime;
      return {
        name: getComputedStyle(node).animationName,
        delay: getComputedStyle(node).animationDelay,
        running: animations.filter((one) => one.playState === 'running').length,
        phase: local === undefined ? undefined : local - delay,
        startTime: typeof first?.startTime === 'number' ? first.startTime : undefined,
        at: typeof at === 'number' ? at : 0,
      };
    },
    { selector, mark },
  );
}

describe('the pictures bob, within their scope', () => {
  it(
    'each bob is locked to the clock, a step behind its neighbour, and resumes across a real redraw',
    async () => {
      measureScreen(warm, undefined);
      const size = SIZES[0]!;
      const id = warm.weather[size.orientation].id;
      await setWeather(warm, size.orientation, { variant: 'playful' }, { h: 0.3 });
      const { page, close } = await loadWallSettled(warm.link, size);
      try {
        const nth = (i: number): string => `#wall .canvas .fw[data-widget-id="${id}"] .wp-day:nth-child(${i}) .wp-emoji`;
        const first = await readPhase(page, nth(1), true);
        const second = await readPhase(page, nth(2));
        expect(first.name).toBe('wp-bob');
        expect(first.running).toBe(1);
        expect(first.delay).toMatch(/^-\d/);
        // Neighbours are not in step: the strip moves as a wave.
        expect(around(first.phase as number, second.phase as number, BOB_MS)).toBeGreaterThan(TOLERANCE_MS);

        await page.waitForFunction(
          (sel) => {
            const node = document.querySelector<HTMLElement>(sel);
            return node !== null && node.dataset['seen'] === undefined;
          },
          nth(1),
          { timeout: 25_000, polling: 50 },
        );
        const after = await readPhase(page, nth(1));
        const gap = (after.startTime ?? 0) - (first.startTime ?? 0);
        expect(around(gap, 0, BOB_MS), `the redraw came ${gap.toFixed(0)}ms after the last`).toBeGreaterThan(1_000);
        const expected = (first.phase as number) + (after.at - first.at);
        expect(around(after.phase as number, expected, BOB_MS)).toBeLessThan(TOLERANCE_MS);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is still for a device that asks for reduced motion',
    async () => {
      measureScreen(warm, undefined);
      const size = SIZES[0]!;
      const id = warm.weather[size.orientation].id;
      await setWeather(warm, size.orientation, { variant: 'playful' }, { h: 0.3 });
      const { page, close } = await loadWallSettled(warm.link, size);
      try {
        const picture = `#wall .canvas .fw[data-widget-id="${id}"] .wp-emoji`;
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const still = await readPhase(page, picture);
        expect(still.running).toBe(0);
        expect(still.name).toBe('none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect((await readPhase(page, picture)).name).toBe('wp-bob');
      } finally {
        await close();
      }
    },
    SLOW,
  );
});
