import type { EmojiKey } from './emoji.js';

/**
 * The advice line (plan item P5.1, the forecast's `playful` look): one thing
 * worth knowing before going out, in plain words with a picture.
 *
 * "Umbrella day", "Coat weather", "Windy", "Sunscreen", "Shorts weather" — the
 * five the plan names, each a threshold on a figure the forecast already
 * carries. It is a sentence a household reads rather than a number they
 * compare, which is the whole of why it is worth a line: a 62% rain chance is
 * something to work out, and an umbrella is the conclusion.
 *
 * **Pure, with no DOM**, for the reason `widget-options.ts`, `ink.ts` and
 * `weather-scale.ts` are: the renderer builds nodes and does no thinking, and
 * there is no DOM in this package's tests. `weather-advice.test.ts` is a table,
 * so every threshold is read against its own boundary in both unit systems.
 *
 * ## Units, and why each threshold is stated twice
 *
 * A forecast arrives in Celsius and km/h or in Fahrenheit and mph, depending on
 * the household's setting and the provider (NWS always answers in Fahrenheit).
 * **Every threshold is written in both systems as a number a household would
 * say** rather than converted at run time, because a household reading "Coat
 * weather" should be able to check it against the figure on the same wall:
 * 10°C and 50°F, 24°C and 75°F, 30 km/h and 19 mph.
 *
 * Two of those pairs are not exact conversions, and that is stated rather than
 * hidden. 75°F is 23.9°C, so on an imperial wall "Shorts weather" arrives a
 * tenth of a degree sooner than on a metric one — the plan's own pair. 19 mph
 * is 30.6 km/h, the nearest whole mph at or above 30 km/h, so the imperial rule
 * is never the one that calls a calmer day windy. 50°F is 10°C exactly.
 *
 * **A figure without its unit fires nothing.** A temperature whose scale the
 * day did not say, or a wind speed on a panel that carried no units (a server
 * older than P3.1), is not compared against either threshold: guessing the unit
 * of 24 is how a wall tells a household in a 24°F frost to wear shorts.
 */

/** Each piece of advice, by the rule that raises it. */
export type AdviceKey = 'umbrella' | 'coat' | 'windy' | 'sunscreen' | 'shorts';

export interface Advice {
  readonly key: AdviceKey;
  /** The words drawn, for somebody standing in a kitchen. */
  readonly words: string;
  /** The bundled picture beside them — a key into `emoji.ts`, never a code point. */
  readonly emoji: EmojiKey;
}

/**
 * What one day holds, in whatever units it arrived in. Every figure is
 * optional, and a rule whose figure is absent does not fire.
 */
export interface AdviceInput {
  /** Chance of rain, percent. */
  readonly precipChance?: number;
  /** The day's forecast high. */
  readonly high?: number;
  readonly tempUnit?: 'C' | 'F';
  /** The UV index — a scale of its own, the same in both systems. */
  readonly uv?: number;
  /** The wind speed. */
  readonly wind?: number;
  readonly windUnit?: 'km/h' | 'mph';
}

/**
 * The plan's thresholds, in both systems. `at least` for everything but the
 * coat, which is a high *below* its figure.
 */
export const ADVICE_THRESHOLDS = {
  /** Rain chance at least this, percent. */
  umbrella: 50,
  /** A high below this. */
  coat: { C: 10, F: 50 },
  /** Wind at least this. */
  windy: { 'km/h': 30, mph: 19 },
  /** A UV index at least this: "high" on the WHO scale. */
  sunscreen: 6,
  /** A high at least this. */
  shorts: { C: 24, F: 75 },
} as const;

/**
 * The words and the picture for each rule, in the order they are **kept**.
 *
 * The order is what the one line says when several apply, and it is the order
 * they change what somebody takes out of the door: wet first, then cold, then
 * wind, then sun, then a nicety. A 60% chance of rain on a 26° day is an
 * umbrella day that also happens to be warm, not a shorts day that might rain.
 * The coat and the shorts can never both apply, since one is a high below 10°C
 * and the other at or above 24°C.
 */
export const ADVICE: Readonly<Record<AdviceKey, Omit<Advice, 'key'>>> = {
  umbrella: { words: 'Umbrella day', emoji: 'umbrella-with-rain-drops' },
  coat: { words: 'Coat weather', emoji: 'coat' },
  windy: { words: 'Windy', emoji: 'wind' },
  sunscreen: { words: 'Sunscreen', emoji: 'sunscreen' },
  shorts: { words: 'Shorts weather', emoji: 'shorts' },
};

/** The rules in the order a line keeps them. */
export const ADVICE_ORDER: readonly AdviceKey[] = ['umbrella', 'coat', 'windy', 'sunscreen', 'shorts'];

/** A finite number, or undefined — a figure a server could not supply is not zero. */
function figure(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Whether each rule fires on this input. */
function fires(key: AdviceKey, input: AdviceInput): boolean {
  switch (key) {
    case 'umbrella': {
      const chance = figure(input.precipChance);
      return chance !== undefined && chance >= ADVICE_THRESHOLDS.umbrella;
    }
    case 'coat': {
      const high = figure(input.high);
      return high !== undefined && input.tempUnit !== undefined && high < ADVICE_THRESHOLDS.coat[input.tempUnit];
    }
    case 'windy': {
      const wind = figure(input.wind);
      return wind !== undefined && input.windUnit !== undefined && wind >= ADVICE_THRESHOLDS.windy[input.windUnit];
    }
    case 'sunscreen': {
      const uv = figure(input.uv);
      return uv !== undefined && uv >= ADVICE_THRESHOLDS.sunscreen;
    }
    case 'shorts': {
      const high = figure(input.high);
      return high !== undefined && input.tempUnit !== undefined && high >= ADVICE_THRESHOLDS.shorts[input.tempUnit];
    }
  }
}

/** Every piece of advice this day raises, most pressing first. Empty is a day with nothing to say. */
export function adviceFor(input: AdviceInput): readonly Advice[] {
  return ADVICE_ORDER.filter((key) => fires(key, input)).map((key) => ({ key, ...ADVICE[key] }));
}

/**
 * The one line a forecast draws, or undefined when the day calls for nothing.
 *
 * One, rather than a list, because the line is a glance: "Umbrella day ·
 * Sunscreen · Windy" is a sentence to read, and the first of them is the one
 * that decides what somebody takes with them. A day that calls for nothing
 * draws no line at all — "Nothing to note" would be a line spent saying so.
 */
export function adviceLine(input: AdviceInput): Advice | undefined {
  return adviceFor(input)[0];
}
