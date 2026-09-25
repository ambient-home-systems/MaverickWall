/**
 * The forecast's `colour` look, measured (plan item P5.1).
 *
 * The strip, painted: each sky in its condition colours (`--wx-*`) and each
 * temperature tinted on the temperature scale (`--temp-*`). RFC 014 §4.2's
 * rule, as `browser-weather-range` carries it — a real paired Classic wall with
 * three family calendars, at 1080x1920 and 1920x1080, unmeasured and on a 32"
 * television read from 1.2 metres, drawing the captured London forecast.
 *
 *  1. **Nothing clipped, nothing belted, tabular figures, role sizes.** As the
 *     range file asks them. `COLOUR_TIERS` is held to the drawing by the belt
 *     count: a rung set lower than what it draws needs would leave the belt a
 *     row to hide, and that is what goes red.
 *  2. **A sky is two colours.** Every part of every drawn glyph is filled with
 *     its own token as the page computes it — the cloud `--wx-cloud`, the rain
 *     `--wx-rain` — and a rainy sky's two parts are two different colours on
 *     the glass. Read off each `<path>`'s computed `fill`, never its class.
 *  3. **A temperature is the colour of its tone.** Each number's computed
 *     colour is the `--temp-*` token of the stop nearest it, worked out here
 *     from the number the wall drew and the anchors the plan states (0, 10, 20
 *     and 30 °C) — not from the tone the renderer stamped, which would be the
 *     renderer agreeing with itself.
 *  4. **Everything else is the strip.** On a wall nobody has measured the
 *     name and the temperatures are the strip's own sizes, so the look moves
 *     colour and the glyph and nothing more; and the strip beside it on the
 *     same wall carries no part and no tone at all.
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

const PART_TOKEN: Readonly<Record<string, string>> = {
  'gl-sun': '--wx-sun',
  'gl-bolt': '--wx-sun',
  'gl-cloud': '--wx-cloud',
  'gl-wind': '--wx-cloud',
  'gl-rain': '--wx-rain',
  'gl-snow': '--wx-snow',
  'gl-fog': '--wx-fog',
  'gl-storm': '--wx-storm',
};

/** The stop nearest a Celsius temperature, from the plan's own anchors. */
function toneOf(celsius: number): string {
  const anchors: readonly (readonly [string, number])[] = [['cold', 0], ['cool', 10], ['warm', 20], ['hot', 30]];
  let best = anchors[0]!;
  for (const one of anchors) if (Math.abs(celsius - one[1]) < Math.abs(celsius - best[1])) best = one;
  return best[0];
}

interface ColourReading {
  readonly parts: readonly { readonly glyph: number; readonly cls: string; readonly fill: string }[];
  readonly temps: readonly { readonly text: string; readonly colour: string; readonly size: number; readonly low: boolean }[];
  readonly names: readonly number[];
  readonly marked: number;
}

async function readColour(page: Page, widgetId: string): Promise<ColourReading> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (box === null) throw new Error('no forecast box');
    const parts: { glyph: number; cls: string; fill: string }[] = [];
    Array.from(box.querySelectorAll('svg.gl-parts')).forEach((svg, glyph) => {
      for (const path of Array.from(svg.querySelectorAll('path'))) {
        parts.push({ glyph, cls: path.getAttribute('class') ?? '', fill: getComputedStyle(path).fill });
      }
    });
    // Each number the wall drew: the high (a text node or a span) and the low.
    const temps: { text: string; colour: string; size: number; low: boolean }[] = [];
    for (const temp of Array.from(box.querySelectorAll<HTMLElement>('.wx-temp'))) {
      // The strip writes the high as the row's own text and the low in a span;
      // the colour look puts each in a span. Both are read, in order.
      for (const node of Array.from(temp.childNodes)) {
        const own = node.nodeType === Node.TEXT_NODE ? temp : (node as Element);
        const text = (node.textContent ?? '').trim();
        if (text === '') continue;
        temps.push({
          text,
          colour: getComputedStyle(own).color,
          size: parseFloat(getComputedStyle(own).fontSize),
          low: (node as Element).classList?.contains('lo') === true || (own === temp && temp.classList.contains('lo')),
        });
      }
    }
    return {
      parts,
      temps,
      names: Array.from(box.querySelectorAll('.wx-name')).map((one) => parseFloat(getComputedStyle(one).fontSize)),
      marked: box.querySelectorAll('.gl-parts, [data-tone]').length,
    };
  }, widgetId);
}

describe('the colour look on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `paints the strip, clipped nowhere, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(ww, preset);
          const id = ww.weather[size.orientation].id;
          for (const resize of [undefined, { h: 0.2 }]) {
            await setWeather(ww, size.orientation, { variant: 'colour' }, resize);
            const { page, close } = await loadWallSettled(ww.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${resize === undefined ? 'seed box' : 'tall box'}`;
              const box = await readForecastBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');

              const drawn = await readColour(page, id);
              const tokens = await tokenColours(page, id, [
                ...new Set(Object.values(PART_TOKEN)),
                '--temp-cold', '--temp-cool', '--temp-warm', '--temp-hot',
              ]);

              // 2. Every part its own token; a rainy sky two colours.
              const rungs = (box.rungs ?? '').split(' ');
              if (rungs.includes('icon')) {
                expect(drawn.parts.length, `${where}: no painted glyph`).toBeGreaterThan(0);
                for (const part of drawn.parts) {
                  const token = PART_TOKEN[part.cls];
                  expect(token, `${where}: a part named ${part.cls}`).toBeDefined();
                  expect(part.fill, `${where} ${part.cls}`).toBe(tokens[token!]);
                }
                const glyphs = new Set(drawn.parts.map((part) => part.glyph));
                const twoTone = [...glyphs].filter(
                  (glyph) => new Set(drawn.parts.filter((part) => part.glyph === glyph).map((part) => part.fill)).size > 1,
                );
                expect(twoTone.length, `${where}: no sky drew in two colours`).toBeGreaterThan(0);
              }

              // 3. Every number the colour of the stop nearest it.
              if (rungs.includes('high')) {
                expect(drawn.temps.length, `${where}: no temperature`).toBeGreaterThan(0);
                for (const temp of drawn.temps) {
                  const value = parseInt(temp.text, 10);
                  expect(Number.isFinite(value), `${where}: "${temp.text}"`).toBe(true);
                  expect(temp.colour, `${where} "${temp.text}"`).toBe(tokens[`--temp-${toneOf(value)}`]);
                }
              }

              // 1. Role sizes on a measured wall; 4. the strip's own on one that is not.
              const roles = await roleSizes(page);
              if (preset !== undefined) {
                for (const temp of drawn.temps) expect(temp.size, `${where} "${temp.text}"`).toBeCloseTo(roles['event']!, 1);
                for (const name of drawn.names) expect(name, `${where} a day's name`).toBeCloseTo(roles['scaffold']!, 1);
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

describe('the colour look is the strip, painted', () => {
  it(
    'draws the strip’s own sizes on an unmeasured wall, and leaves the strip itself unpainted',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      const read = async (config: Record<string, unknown>): Promise<ColourReading> => {
        await setWeather(ww, size.orientation, config);
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          return await readColour(page, id);
        } finally {
          await close();
        }
      };
      const strip = await read({});
      const colour = await read({ variant: 'colour' });
      expect(strip.marked, 'the strip carries a painted part or a tone').toBe(0);
      expect(colour.marked).toBeGreaterThan(0);
      expect(colour.names).toEqual(strip.names);
      expect(colour.temps.map((one) => [one.text, one.size, one.low])).toEqual(
        strip.temps.map((one) => [one.text, one.size, one.low]),
      );
      // And the numbers are the strip's, in the strip's own quieter low: only
      // the colour changed, never which number is the loud one.
      expect(colour.temps.some((one) => one.low)).toBe(true);
    },
    SLOW,
  );
});
