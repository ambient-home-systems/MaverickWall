/**
 * Where a temperature sits, as data (plan item P5.1): the arithmetic behind the
 * `range` and `colour` weather styles.
 *
 * Two questions, and they are asked of the same four anchors so the two styles
 * cannot come to disagree about what "warm" is:
 *
 *  - **`range`** draws each day's low-to-high as a bar on the *week's* own
 *    scale, filled cool to warm. The bar's position is relative (the week's
 *    coldest low is the left edge, its warmest high the right), but its
 *    **colour is absolute**: 20°C is the warm stop on every day of every week,
 *    so a cold week reads blue from across a kitchen and a hot one red, and two
 *    days with the same temperatures are the same colour wherever they sit.
 *    That is done with one ramp as wide as the whole track on every row, whose
 *    stops are placed where the anchors fall on this week's scale — outside it,
 *    often, which a CSS gradient accepts — and a window cut out of it for each
 *    day. So the ramp's geometry is the same on every row and only the window
 *    moves.
 *  - **`colour`** tints each temperature on the strip with the stop nearest it
 *    — a discrete tone, because a word is one colour and cannot be a ramp.
 *
 * **The anchors are 0, 10, 20 and 30 °C**, and 32, 50, 68 and 86 °F, which are
 * the same four temperatures. Cold is freezing, hot is a day nobody wants to be
 * in a kitchen; the two in between split the ordinary British and American year
 * roughly in thirds. Stated in both units rather than converted at runtime,
 * because a household reads the number on the wall and the table should be
 * checkable against it in their own scale.
 *
 * Pure, with no DOM, for the reason `widget-options.ts`, `ink.ts` and
 * `ladder.ts` are: there is no DOM in this package's tests, so a rule decided
 * inside a `createElement` call is a rule nothing can check.
 */

export type TempUnit = 'F' | 'C';
export type TempTone = 'cold' | 'cool' | 'warm' | 'hot';

/** The four stops, cold to hot, and the theme token each paints with. */
export const TEMP_TONES: readonly TempTone[] = ['cold', 'cool', 'warm', 'hot'];

export const TEMP_ANCHORS: Readonly<Record<TempUnit, readonly [number, number, number, number]>> = {
  C: [0, 10, 20, 30],
  F: [32, 50, 68, 86],
};

/** The token a tone paints with (`theme.ts`'s `paletteTokens`). */
export function toneToken(tone: TempTone): string {
  return `--temp-${tone}`;
}

/**
 * The unit a forecast's numbers are in: the first day that says, then the
 * panel's own `units`, then Celsius.
 *
 * Celsius last because a guess has to be one or the other and the anchors are
 * where the guess shows: read as Fahrenheit, an ordinary 18°C day is "cold".
 * Every provider this product has sends the day's unit, so the fallback is for
 * a cache written before it did.
 */
export function unitOf(
  days: readonly { readonly tempUnit?: TempUnit | undefined }[],
  panelUnit?: TempUnit,
): TempUnit {
  for (const day of days) if (day.tempUnit !== undefined) return day.tempUnit;
  return panelUnit ?? 'C';
}

/**
 * The stop nearest a temperature.
 *
 * Nearest rather than "at or above", so each tone owns the ten degrees around
 * its anchor: 14°C is cool and 16°C is warm, where a floor would call 19°C
 * cool and paint a mild afternoon the colour of a frost.
 */
export function tempTone(value: number, unit: TempUnit): TempTone {
  const anchors = TEMP_ANCHORS[unit];
  let best = 0;
  for (let i = 1; i < anchors.length; i++) {
    if (Math.abs(value - (anchors[i] as number)) < Math.abs(value - (anchors[best] as number))) best = i;
  }
  return TEMP_TONES[best] as TempTone;
}

/** The week's own scale: its coldest reading at the left, its warmest at the right. */
export interface WeekScale {
  readonly min: number;
  readonly max: number;
}

/**
 * The scale a set of days (and the current reading, when there is one) is
 * drawn on, or undefined when not one of them has a number.
 *
 * The current reading is included so the dot that marks it on today's bar is
 * never off the end of the track — an afternoon warmer than the forecast high
 * is exactly the reading worth marking. A week whose every number is the same
 * is widened by one degree each way, because a scale with no width puts every
 * bar at the left edge and divides by zero doing it.
 */
export function weekScale(
  days: readonly { readonly lowValue?: number | undefined; readonly highValue?: number | undefined }[],
  current?: number,
): WeekScale | undefined {
  const values: number[] = [];
  for (const day of days) {
    if (day.lowValue !== undefined) values.push(day.lowValue);
    if (day.highValue !== undefined) values.push(day.highValue);
  }
  if (values.length === 0) return undefined;
  if (current !== undefined && Number.isFinite(current)) values.push(current);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? { min: min - 1, max: max + 1 } : { min, max };
}

/** Where a value falls on the scale, as a percentage of the track, clamped to it. */
export function scalePercent(scale: WeekScale, value: number): number {
  const at = ((value - scale.min) / (scale.max - scale.min)) * 100;
  return Math.max(0, Math.min(100, round(at)));
}

/**
 * One day's bar: where it starts and how wide it is, both as percentages of
 * the track, or undefined when the day lacks either number.
 *
 * A low above the high is drawn the right way round rather than refused — the
 * reading is a provider's, and a bar that says "somewhere between these two" is
 * truer than a hole where a day was.
 */
export function barSpan(
  scale: WeekScale,
  low: number | undefined,
  high: number | undefined,
): { readonly left: number; readonly width: number } | undefined {
  if (low === undefined || high === undefined) return undefined;
  const a = scalePercent(scale, Math.min(low, high));
  const b = scalePercent(scale, Math.max(low, high));
  return { left: a, width: round(b - a) };
}

/**
 * Where each anchor falls on this week's scale, as a percentage of the track —
 * outside 0..100 whenever the week does not reach it, which is what keeps the
 * colour absolute. A CSS gradient places a stop at -140% as readily as at 40%.
 */
export function rampStops(scale: WeekScale, unit: TempUnit): readonly { readonly tone: TempTone; readonly at: number }[] {
  const anchors = TEMP_ANCHORS[unit];
  return TEMP_TONES.map((tone, i) => ({
    tone,
    at: round((((anchors[i] as number) - scale.min) / (scale.max - scale.min)) * 100),
  }));
}

/** The ramp as a `linear-gradient`, drawing from the theme's own four tokens. */
export function rampGradient(scale: WeekScale, unit: TempUnit): string {
  const stops = rampStops(scale, unit).map(({ tone, at }) => `var(${toneToken(tone)}) ${at}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * The ramp's box inside a day's window, so every row shows the same ramp.
 *
 * The window is `left`..`left + width` of the track; the ramp inside it has to
 * start `left` track-widths to its left and be one whole track wide, which in
 * the window's own percentages is `-left / width` and `100 / width`. A window
 * of no width (a day whose low is its high) is given the track's width itself,
 * because there is nothing in it to be wrong about and a division by zero is.
 */
export function rampWithin(span: { readonly left: number; readonly width: number }): {
  readonly left: number;
  readonly width: number;
} {
  if (!(span.width > 0)) return { left: -span.left, width: 100 };
  return { left: round((-span.left / span.width) * 100), width: round((100 / span.width) * 100) };
}

/** Two decimal places, so a percentage written into a style is short and stable. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
