/**
 * What an Environment widget shows, tile by tile (plan item M5.6), for the
 * wall, the editor's preview and an e-paper panel alike. Transcribed between
 * the markers into `apps/display/src/env-tiles.ts` and held character for
 * character by `transcription-parity.test.ts`.
 *
 * Every number comes from a reading the household already consented to: the
 * air quality from the second host that the Weather screen's switch turns on
 * (Q5), and the wind and sunlight from the forecast. A tile whose reading is
 * missing is not drawn — not a dash, not "n/a" — so a household outside
 * Europe, where pollen is not modelled, simply has no pollen tile. In Europe
 * a day with no pollen in the air says "None", because that is a fact.
 *
 * The words for UV are the WHO's bands. The pollen levels are a general guide
 * in grains per cubic metre — the thresholds that matter differ by plant and
 * by person — and the tile names the plant with the most in the air.
 */

/* env-tiles:begin */
export type EnvField = 'aqi' | 'pm25' | 'pm10' | 'ozone' | 'no2' | 'pollen' | 'uv' | 'solar' | 'wind';

/** Every field, in the order a widget draws them. */
export const ENV_FIELDS: readonly EnvField[] = ['aqi', 'pm25', 'pm10', 'ozone', 'no2', 'pollen', 'uv', 'solar', 'wind'];

/** What a widget nobody has touched shows. */
export const ENV_DEFAULT_FIELDS: readonly EnvField[] = ['aqi', 'pm25', 'pollen', 'uv', 'wind'];

export interface EnvInput {
  readonly air?: {
    readonly aqi: number;
    readonly scale: 'us' | 'eu';
    readonly label: string;
    readonly pm25?: number;
    readonly pm10?: number;
    readonly ozone?: number;
    readonly no2?: number;
    readonly uv?: number;
    readonly pollen?: Readonly<Record<string, number>>;
  };
  readonly windSpeed?: number;
  readonly windDir?: string;
  readonly windUnit?: string;
  readonly solar?: number;
  /** The forecast's UV, used when the air reading carries none. */
  readonly uv?: number;
}

export interface EnvTile {
  readonly key: EnvField;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  /** A category or a direction, said after the value. */
  readonly detail?: string;
}

/** The fields a widget shows, in the canonical order: the ones it names, or the default. */
export function envFields(config: unknown): EnvField[] {
  const raw = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['envFields'] : undefined;
  if (!Array.isArray(raw)) return [...ENV_DEFAULT_FIELDS];
  return ENV_FIELDS.filter((field) => raw.indexOf(field) >= 0);
}

/** The WHO's words for a UV index. */
export function uvWords(uv: number): string {
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

/** A general guide to a pollen count, grains/m³. */
export function pollenWords(grains: number): string {
  if (grains < 10) return 'Low';
  if (grains < 50) return 'Moderate';
  if (grains < 200) return 'High';
  return 'Very high';
}

const PLANT_NAMES: Readonly<Record<string, string>> = {
  alder: 'Alder',
  birch: 'Birch',
  grass: 'Grass',
  mugwort: 'Mugwort',
  olive: 'Olive',
  ragweed: 'Ragweed',
};

const MICROGRAMS = 'µg/m³';

/** The tiles to draw, in field order, each only where its reading exists. */
export function envTiles(input: EnvInput, config: unknown): EnvTile[] {
  const tiles: EnvTile[] = [];
  const air = input.air;
  const whole = (value: number): string => String(Math.round(value));
  for (const field of envFields(config)) {
    if (field === 'aqi' && air !== undefined) {
      tiles.push({ key: field, label: air.scale === 'eu' ? 'Air quality (EU)' : 'Air quality', value: whole(air.aqi), detail: air.label });
    } else if (field === 'pm25' && air?.pm25 !== undefined) {
      tiles.push({ key: field, label: 'PM2.5', value: whole(air.pm25), unit: MICROGRAMS });
    } else if (field === 'pm10' && air?.pm10 !== undefined) {
      tiles.push({ key: field, label: 'PM10', value: whole(air.pm10), unit: MICROGRAMS });
    } else if (field === 'ozone' && air?.ozone !== undefined) {
      tiles.push({ key: field, label: 'Ozone', value: whole(air.ozone), unit: MICROGRAMS });
    } else if (field === 'no2' && air?.no2 !== undefined) {
      tiles.push({ key: field, label: 'NO₂', value: whole(air.no2), unit: MICROGRAMS });
    } else if (field === 'pollen' && air?.pollen !== undefined) {
      let top: string | undefined;
      let most = 0;
      for (const plant of Object.keys(PLANT_NAMES)) {
        const grains = air.pollen[plant];
        if (typeof grains === 'number' && grains > most) {
          most = grains;
          top = plant;
        }
      }
      tiles.push(
        top === undefined
          ? { key: field, label: 'Pollen', value: 'None' }
          : { key: field, label: 'Pollen', value: PLANT_NAMES[top] as string, detail: pollenWords(most) },
      );
    } else if (field === 'uv') {
      const uv = air?.uv ?? input.uv;
      if (uv !== undefined) tiles.push({ key: field, label: 'UV', value: whole(uv), detail: uvWords(uv) });
    } else if (field === 'solar' && input.solar !== undefined) {
      tiles.push({ key: field, label: 'Sunlight', value: whole(input.solar), unit: 'W/m²' });
    } else if (field === 'wind' && input.windSpeed !== undefined) {
      tiles.push({
        key: field,
        label: 'Wind',
        value: whole(input.windSpeed),
        ...(input.windUnit === undefined ? {} : { unit: input.windUnit }),
        ...(input.windDir === undefined ? {} : { detail: input.windDir }),
      });
    }
  }
  return tiles;
}

/**
 * The same words in the panel's ASCII alphabet, where `asciiTitle` would
 * otherwise delete the µ, ³, ² and ₂ and leave "g/m" behind.
 */
export function envAscii(text: string): string {
  return text.replace(/µ/g, 'u').replace(/[³]/g, '3').replace(/[²₂]/g, '2');
}
/* env-tiles:end */
