import { describe, expect, it } from 'vitest';
import {
  ADVICE,
  ADVICE_ORDER,
  ADVICE_THRESHOLDS,
  adviceFor,
  adviceLine,
  type AdviceInput,
  type AdviceKey,
} from '../src/weather-advice.js';
import { EMOJI_KEYS } from '../src/emoji.js';

/**
 * The advice line's rules (plan item P5.1), as a table.
 *
 * Every threshold is read against its own boundary — the figure just under it,
 * the figure on it, and the figure just over it — **in both unit systems**,
 * because each is written twice as a number a household would say (10°C and
 * 50°F, 24°C and 75°F, 30 km/h and 19 mph) and a pair can only be checked by
 * checking both halves. Each row is one rule alone: every other figure is left
 * out, which is also what proves a rule fires on its own figure and nothing
 * else's.
 */

/** One row: a day's figures, and which rule — if any — they raise. */
type Row = readonly [label: string, input: AdviceInput, fires: AdviceKey | undefined];

const ROWS: readonly Row[] = [
  // Rain chance, a percent in both systems.
  ['49% rain', { precipChance: 49 }, undefined],
  ['50% rain', { precipChance: 50 }, 'umbrella'],
  ['100% rain', { precipChance: 100 }, 'umbrella'],

  // A coat: a high *below* 10°C or 50°F.
  ['a 9.9°C high', { high: 9.9, tempUnit: 'C' }, 'coat'],
  ['a 10°C high', { high: 10, tempUnit: 'C' }, undefined],
  ['a -4°C high', { high: -4, tempUnit: 'C' }, 'coat'],
  ['a 49.9°F high', { high: 49.9, tempUnit: 'F' }, 'coat'],
  ['a 50°F high', { high: 50, tempUnit: 'F' }, undefined],
  // The same number in the other system is the other side of the line: 12°F
  // is a frost and 12°C is a jumper day, so the unit is the whole question.
  ['a 12°F high', { high: 12, tempUnit: 'F' }, 'coat'],
  ['a 12°C high', { high: 12, tempUnit: 'C' }, undefined],

  // Wind, at least 30 km/h or 19 mph.
  ['29.9 km/h', { wind: 29.9, windUnit: 'km/h' }, undefined],
  ['30 km/h', { wind: 30, windUnit: 'km/h' }, 'windy'],
  ['18.9 mph', { wind: 18.9, windUnit: 'mph' }, undefined],
  ['19 mph', { wind: 19, windUnit: 'mph' }, 'windy'],
  // 25 is windy in mph and calm in km/h.
  ['25 mph', { wind: 25, windUnit: 'mph' }, 'windy'],
  ['25 km/h', { wind: 25, windUnit: 'km/h' }, undefined],

  // UV, one scale in both systems.
  ['UV 5.9', { uv: 5.9 }, undefined],
  ['UV 6', { uv: 6 }, 'sunscreen'],

  // Shorts: a high at least 24°C or 75°F.
  ['a 23.9°C high', { high: 23.9, tempUnit: 'C' }, undefined],
  ['a 24°C high', { high: 24, tempUnit: 'C' }, 'shorts'],
  ['a 74.9°F high', { high: 74.9, tempUnit: 'F' }, undefined],
  ['a 75°F high', { high: 75, tempUnit: 'F' }, 'shorts'],
  // 30 is shorts weather in Celsius and a frost in Fahrenheit.
  ['a 30°C high', { high: 30, tempUnit: 'C' }, 'shorts'],
  ['a 30°F high', { high: 30, tempUnit: 'F' }, 'coat'],
];

describe('each rule, at its own boundary, in both systems', () => {
  for (const [label, input, fires] of ROWS) {
    it(`${label} ${fires === undefined ? 'raises nothing' : `says ${ADVICE[fires].words}`}`, () => {
      expect(adviceFor(input).map((one) => one.key)).toEqual(fires === undefined ? [] : [fires]);
      expect(adviceLine(input)?.key).toBe(fires);
    });
  }
});

describe('a figure whose unit nobody said fires nothing', () => {
  /*
   * Guessing the unit of 24 is how a wall tells a household in a 24°F frost to
   * wear shorts. A server older than P3.1 sends no units, and a day may not
   * say its scale — both leave the temperature and the wind out of it.
   */
  it('reads no temperature without its scale', () => {
    expect(adviceFor({ high: 30 })).toEqual([]);
    expect(adviceFor({ high: -5 })).toEqual([]);
  });

  it('reads no wind without its unit', () => {
    expect(adviceFor({ wind: 90 })).toEqual([]);
  });

  it('reads nothing that is not a number', () => {
    expect(adviceFor({ precipChance: Number.NaN, uv: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(adviceFor({})).toEqual([]);
  });
});

describe('the one line, when several apply', () => {
  it('keeps them in the order they change what somebody takes out of the door', () => {
    // Rain, cold, wind, sun, then the nicety.
    expect(ADVICE_ORDER).toEqual(['umbrella', 'coat', 'windy', 'sunscreen', 'shorts']);
    const everything: AdviceInput = { precipChance: 80, high: 28, tempUnit: 'C', uv: 8, wind: 40, windUnit: 'km/h' };
    expect(adviceFor(everything).map((one) => one.key)).toEqual(['umbrella', 'windy', 'sunscreen', 'shorts']);
    expect(adviceLine(everything)?.words).toBe('Umbrella day');
    // A warm wet day is an umbrella day that is also warm, not a shorts day
    // that might rain.
    expect(adviceLine({ precipChance: 60, high: 26, tempUnit: 'C' })?.key).toBe('umbrella');
    expect(adviceLine({ high: 5, tempUnit: 'C', wind: 35, windUnit: 'km/h' })?.key).toBe('coat');
    expect(adviceLine({ uv: 7, high: 27, tempUnit: 'C' })?.key).toBe('sunscreen');
  });

  it('never says coat and shorts of one day', () => {
    for (const high of [-10, 0, 9.9, 10, 15, 23.9, 24, 35]) {
      for (const tempUnit of ['C', 'F'] as const) {
        const keys = adviceFor({ high, tempUnit }).map((one) => one.key);
        expect(keys.includes('coat') && keys.includes('shorts'), `${high}°${tempUnit}`).toBe(false);
      }
    }
  });
});

describe('the words and the pictures', () => {
  it('are the plan’s five, each with a bundled picture rather than a character', () => {
    expect(Object.fromEntries(ADVICE_ORDER.map((key) => [key, ADVICE[key].words]))).toEqual({
      umbrella: 'Umbrella day',
      coat: 'Coat weather',
      windy: 'Windy',
      sunscreen: 'Sunscreen',
      shorts: 'Shorts weather',
    });
    for (const key of ADVICE_ORDER) {
      // A key into the bundled set, which `emojiNode` draws as an <img> — never
      // a code point a tablet's own font would draw.
      expect(EMOJI_KEYS as readonly string[], key).toContain(ADVICE[key].emoji);
      expect(/[^\x20-\x7E]/.test(ADVICE[key].words), `${key}'s words carry a character outside ASCII`).toBe(false);
    }
  });

  it('states every temperature and wind threshold in both systems', () => {
    expect(Object.keys(ADVICE_THRESHOLDS.coat).sort()).toEqual(['C', 'F']);
    expect(Object.keys(ADVICE_THRESHOLDS.shorts).sort()).toEqual(['C', 'F']);
    expect(Object.keys(ADVICE_THRESHOLDS.windy).sort()).toEqual(['km/h', 'mph']);
    // The imperial wind is never the calmer of the two: 19 mph is 30.6 km/h.
    expect(ADVICE_THRESHOLDS.windy.mph * 1.609344).toBeGreaterThanOrEqual(ADVICE_THRESHOLDS.windy['km/h']);
    // And 50°F is 10°C exactly.
    expect(((ADVICE_THRESHOLDS.coat.F - 32) * 5) / 9).toBe(ADVICE_THRESHOLDS.coat.C);
  });
});
