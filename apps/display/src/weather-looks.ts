import type { EmojiKey } from './emoji.js';
import type { GlyphKey } from './glyphs.js';
import type { AdviceInput } from './weather-advice.js';
import type { CurrentWeatherModel, HourlyWeatherModel, WeatherDayModel, WeatherUnitsModel } from './viewmodel.js';
import { DISPLAY_LOCALE } from './viewmodel.js';

/**
 * The decisions behind the forecast's `today` and `playful` looks (plan item
 * P5.1), as data.
 *
 * `render.ts` builds nodes and does no thinking, and there is no DOM in this
 * package's tests — so which sky a reading is drawn on, what moves across it,
 * which picture a day wears, what the Today card says when there is no reading
 * to call "now", and what an hour is called are all answered here, pure, and
 * `weather-looks.test.ts` reads them without a browser. The same seam
 * `widget-options.ts`, `weather-scale.ts` and `inspector.ts` sit at.
 */

/**
 * The six skies a Today card is drawn on, each a gradient the theme supplies
 * (`--sky-<kind>-top`, `-bottom` and `-ink`, from `paletteTokens` in
 * `theme.ts`): clear day blue, clear night indigo, cloudy grey, rain slate,
 * snow pale, storm deep violet — the plan's six, one per token set.
 */
export const SKY_KINDS = ['day', 'night', 'cloud', 'rain', 'snow', 'storm'] as const;
export type SkyKind = (typeof SKY_KINDS)[number];

/**
 * Which sky a reading is drawn on.
 *
 * **Only a sky with the sun in it follows the clock.** Clear, mostly clear and
 * partly cloudy are day blue by day and night indigo after dark, because what
 * a household sees out of the window then is the dark; an overcast, wet, snowy
 * or stormy sky is its weather's colour at any hour, since the weather is what
 * that sky is about. Wind is a clear sky that moves, and fog is a cloud that
 * sits on the ground. A reading with no glyph at all — a sky nothing matched,
 * or a newer server's key this bundle has never heard of — draws the plain
 * day or night sky rather than guessing at weather it was not told.
 */
export function skyFor(glyph: GlyphKey | undefined, isDay: boolean): SkyKind {
  switch (glyph) {
    case 'cloudy':
    case 'fog':
      return 'cloud';
    case 'drizzle':
    case 'rain':
    case 'showers':
      return 'rain';
    case 'snow':
    case 'sleet':
      return 'snow';
    case 'thunderstorm':
      return 'storm';
    default:
      return isDay ? 'day' : 'night';
  }
}

/**
 * What moves across a Today card, per condition — the plan's four: the sun
 * glows, clouds drift, rain streaks and snow falls.
 *
 * A clear night has none, deliberately: the four are what a sky is doing, and
 * a still dark sky is doing nothing — a twinkle would be motion invented for
 * its own sake on a screen somebody may be trying to sleep beside. A storm is
 * its rain, and never a flash: an opacity strobe across a whole card is the one
 * effect on a wall that could be a photosensitivity hazard, and it is not worth
 * the drama. Wind and fog drift, as cloud does. Every one of them is still
 * under reduced motion and with the wall's Motion switch off (`display.css`'s
 * scoped block, held by `motion.test.ts`), where the elements it draws are a
 * still picture of the same sky.
 */
export type SkyMotion = 'glow' | 'drift' | 'rain' | 'snow' | 'none';

export function skyMotion(glyph: GlyphKey | undefined, isDay: boolean): SkyMotion {
  switch (glyph) {
    case 'clear':
    case 'mostly-clear':
      return isDay ? 'glow' : 'none';
    case 'partly-cloudy':
    case 'cloudy':
    case 'fog':
    case 'wind':
      return 'drift';
    case 'drizzle':
    case 'rain':
    case 'showers':
    case 'thunderstorm':
      return 'rain';
    case 'snow':
    case 'sleet':
      return 'snow';
    default:
      return 'none';
  }
}

/**
 * How many of each moving thing a card draws, and where, as shares of the
 * card. Fixed rather than random, so two redraws of one wall place every drop
 * in the same spot — a card whose rain moved about on every tick would read as
 * a broken renderer before it read as rain — and few, because an old tablet
 * bolted to a wall composites every one of them on every frame (P4.3 caps the
 * count). `left` and `top` are percentages of the card.
 */
export const SKY_PARTICLES: Readonly<Record<'drift' | 'rain' | 'snow', readonly { readonly left: number; readonly top: number }[]>> = {
  drift: [
    { left: 8, top: 10 },
    { left: 52, top: 46 },
  ],
  rain: [
    { left: 6, top: 12 }, { left: 17, top: 58 }, { left: 28, top: 30 }, { left: 39, top: 74 },
    { left: 50, top: 8 }, { left: 61, top: 50 }, { left: 72, top: 22 }, { left: 83, top: 66 },
    { left: 93, top: 38 },
  ],
  snow: [
    { left: 7, top: 20 }, { left: 19, top: 64 }, { left: 31, top: 36 }, { left: 44, top: 82 },
    { left: 56, top: 14 }, { left: 68, top: 56 }, { left: 80, top: 28 }, { left: 91, top: 72 },
  ],
};

/**
 * One cycle of each, in milliseconds — stated here and nowhere else, because
 * `motion.ts` computes the phase from it and a second copy is how the two would
 * drift. Each is chosen for how the weather moves — a slow glow, a slower
 * drift, quick rain and unhurried snow — and then held to one rule about the
 * tick: none may divide it closely enough that a restart on the fifteen-second
 * redraw would land near where a continuous loop is, since that would hide the
 * fault from a household and from a test alike. Snow was 7 seconds, a restart
 * only a seventh of a cycle out, and is 6.5 (`weather-looks.test.ts` holds the
 * rule: at least a quarter of a cycle, for every one of them).
 */
export const SKY_MOTION_MS: Readonly<Record<Exclude<SkyMotion, 'none'>, number>> = {
  glow: 9_000,
  drift: 48_000,
  rain: 1_200,
  snow: 6_500,
};

/**
 * One bob of a `playful` picture — up a little and back, gently — and how far
 * apart two neighbouring columns are in it, so a strip of five does not bob in
 * step like a row of soldiers. The offset is an eighth of the cycle rather
 * than anything random, for `SKY_PARTICLES`' reason: every redraw puts every
 * picture in the same place in its bob.
 *
 * 4.2 seconds, and one thing about the number is not taste: it does not divide
 * the fifteen-second tick. A cycle that did (5 seconds, 3, 7.5) would put a
 * restarted bob exactly where a continuous one is, so the one fault this
 * mechanism exists to prevent would be invisible to a household and to
 * `browser-weather-playful`'s continuity check alike. 15,000 mod 4,200 is
 * 2,400, which a restart would miss by 1.8 seconds either way — more than a
 * quarter of a cycle, the bar every sky cycle above clears as well.
 */
export const PLAYFUL_BOB_MS = 4_200;
export const PLAYFUL_BOB_STEP_MS = 525;

/**
 * The bundled picture a `playful` day wears — the plan's seven, plus cloud for
 * an overcast day, which the seven have no picture for.
 *
 * By *day*, never by the hour: a playful column is a day of the forecast, and a
 * day's weather has a sun in it whatever the time. A key this bundle has no
 * picture for draws none (`emojiNode`'s rule), so an unknown sky is a column
 * with its name and numbers and a gap, never a broken image.
 */
export function emojiForGlyph(glyph: GlyphKey | undefined): EmojiKey | undefined {
  switch (glyph) {
    case 'clear':
      return 'sun';
    case 'mostly-clear':
    case 'partly-cloudy':
      return 'partly-cloudy-day';
    case 'cloudy':
      return 'cloud';
    case 'fog':
      return 'fog';
    case 'drizzle':
    case 'rain':
    case 'showers':
      return 'cloud-with-rain';
    case 'snow':
    case 'sleet':
      return 'snowflake';
    case 'thunderstorm':
      return 'thunderstorm';
    case 'wind':
      return 'wind';
    default:
      return undefined;
  }
}

/** One of the next hours, as the Today card draws it. */
export interface TodayHour {
  /** "Now" for the hour that has begun, then "14" or "2 pm" in the wall's own clock. */
  readonly label: string;
  readonly glyph: GlyphKey | undefined;
  readonly temp: string;
}

/** One of the days after today, as the Today card's one line draws it. */
export interface TodayNextDay {
  readonly name: string;
  readonly high: string;
  readonly low: string;
}

/**
 * The Today card, as data: what it says, in the order it is kept.
 *
 * `mode` is the half worth reading. **`now`** is a current reading recent
 * enough to call now (the server's ninety minutes, and the wall's own again —
 * `weatherFrom`), and its temperature is the lede. **`forecast`** is every
 * other case — no reading, a stale one, a provider with none — and the lede is
 * today's high with its low beside it (P3.4): the card goes on saying
 * something true rather than drawing a dash where "now" should be, and it does
 * not present a morning's forecast as the afternoon's temperature.
 */
export interface TodayCard {
  readonly mode: 'now' | 'forecast';
  /** The big reading: now's temperature, or today's high. */
  readonly lede: string;
  /** In `forecast` mode, today's low, drawn as the lede's quieter partner. */
  readonly ledeLow: string | undefined;
  readonly glyph: GlyphKey | undefined;
  readonly sky: SkyKind;
  readonly motion: SkyMotion;
  /** In `now` mode, today's high and low, "22°" and "13°"; undefined without a today. */
  readonly high: string | undefined;
  readonly low: string | undefined;
  /** The provider's own words: "Mainly clear", "Light rain". */
  readonly condition: string | undefined;
  /** "Feels like 18°", in `now` mode, when the provider said. */
  readonly feels: string | undefined;
  readonly hours: readonly TodayHour[];
  readonly days: readonly TodayNextDay[];
}

export interface TodayCardInput {
  readonly days: readonly WeatherDayModel[];
  readonly current: CurrentWeatherModel | undefined;
  readonly hourly: readonly HourlyWeatherModel[];
  /** The wall's own today, `YYYY-MM-DD`; undefined when the manifest had none. */
  readonly todayDate: string | undefined;
  readonly now: number;
  readonly timezone: string;
  readonly hour12: boolean;
}

/** "22°", or undefined — a number without its unit, the way iOS writes a range. */
function bare(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : `${Math.round(value)}°`;
}

/**
 * The day a card calls today: the one dated today, or — for a forecast cached
 * before days carried dates — the first, since a forecast begins with today.
 * A first day dated *another* day is not today: a wall redrawing a forecast it
 * saved yesterday must not call yesterday's high today's.
 */
export function todayOf(days: readonly WeatherDayModel[], todayDate: string | undefined): WeatherDayModel | undefined {
  const dated = todayDate === undefined ? undefined : days.find((day) => day.date === todayDate);
  if (dated !== undefined) return dated;
  const first = days[0];
  return first !== undefined && first.date === undefined ? first : undefined;
}

/**
 * An hour's name on the card, in the wall's own zone and clock: "14" on a
 * twenty-four-hour wall and "2 pm" on a twelve-hour one, iOS's two forms.
 */
export function hourLabel(at: number, timezone: string, hour12: boolean): string {
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: timezone, hour: 'numeric', hour12 }).format(new Date(at));
}

/** The Today card for this forecast, or undefined when there is nothing true to say. */
export function todayCard(input: TodayCardInput): TodayCard | undefined {
  const today = todayOf(input.days, input.todayDate);
  const current = input.current;
  const after = today === undefined ? input.days : input.days.slice(input.days.indexOf(today) + 1);
  const days: TodayNextDay[] = after.map((day) => ({
    name: day.name,
    high: bare(day.highValue) ?? '—',
    low: bare(day.lowValue) ?? '—',
  }));
  const hours: TodayHour[] = input.hourly.map((hour) => ({
    label: hour.at <= input.now && input.now < hour.at + 60 * 60_000
      ? 'Now'
      : hourLabel(hour.at, input.timezone, input.hour12),
    glyph: hour.glyph,
    temp: hour.temp,
  }));

  if (current !== undefined) {
    return {
      mode: 'now',
      lede: current.temp,
      ledeLow: undefined,
      glyph: current.glyph,
      sky: skyFor(current.glyph, current.isDay),
      motion: skyMotion(current.glyph, current.isDay),
      high: bare(today?.highValue),
      low: bare(today?.lowValue),
      condition: current.condition ?? today?.summary,
      feels: current.feelsLike === undefined ? undefined : `Feels like ${current.feelsLike}`,
      hours,
      days,
    };
  }

  // No reading to call now: today's high is the lede and its low rides beside
  // it. With no today either, there is nothing on this card that is true.
  const high = bare(today?.highValue);
  if (today === undefined || high === undefined) return undefined;
  // Whether it is dark is the next hour's word when the provider sent one; a
  // card with no hours takes the daytime sky rather than inventing a night.
  const isDay = input.hourly[0]?.isDay ?? true;
  return {
    mode: 'forecast',
    lede: high,
    ledeLow: bare(today.lowValue),
    glyph: today.glyph,
    sky: skyFor(today.glyph, isDay),
    motion: skyMotion(today.glyph, isDay),
    high: undefined,
    low: undefined,
    condition: today.summary,
    feels: undefined,
    hours,
    days,
  };
}

/**
 * What the advice line reads for today (`weather-advice.ts`): the day's own
 * figures, and the current reading's UV and wind where the day has none —
 * NWS publishes no daily UV, and a household whose UV is 7 right now should
 * not be told nothing because the day's column is empty. Units come from the
 * panel, and a temperature's scale from the day itself when the panel said
 * none; a figure whose unit nobody said is left out, so its rule cannot fire.
 */
export function adviceInput(
  today: WeatherDayModel | undefined,
  current: CurrentWeatherModel | undefined,
  units: WeatherUnitsModel | undefined,
): AdviceInput {
  const tempUnit = units?.temp ?? today?.tempUnit;
  const uv = today?.uvMax ?? current?.uv;
  const wind = today?.windMax ?? current?.windSpeed;
  return {
    ...(today?.precipChance === undefined ? {} : { precipChance: today.precipChance }),
    ...(today?.highValue === undefined ? {} : { high: today.highValue }),
    ...(tempUnit === undefined ? {} : { tempUnit }),
    ...(uv === undefined ? {} : { uv }),
    ...(wind === undefined || units === undefined ? {} : { wind, windUnit: units.wind }),
  };
}
