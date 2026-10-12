/**
 * The status card and the sparklines (plan items M6.8 and M6.10), transcribed
 * from `apps/server/src/api/status-card.ts`, which is the spec. The block
 * between the markers is held character for character by
 * `transcription-parity.test.ts`: the display bundle has no bundler and the
 * server cannot import it, and a wall and a panel deciding a card's subject,
 * its progress or whether it has finished differently would be one stored
 * config drawn two ways.
 */

/* status-card:begin */
/** What a status card or a sparkline reads of one reading. */
export interface StatusReading {
  /** The handle a widget names it by; absent from a server older than P1.3. */
  readonly key?: string | undefined;
  readonly value: string;
  readonly unit?: string | null | undefined;
  /** A light's brightness, a fan's speed or a blind's position, 0-100. */
  readonly level?: number | undefined;
  /** The last day as half-hour means, oldest first (M6.10). */
  readonly series?: readonly (number | null)[] | undefined;
}

/** The most readings a card draws beside its subject. */
export const STATUS_DETAILS = 4;

export interface StatusParts<R extends StatusReading> {
  readonly subject: R;
  readonly details: readonly R[];
  /** How far along, 0-100, or absent for a card with no progress to show. */
  readonly progress?: number;
  /** Whether the subject says the words the household chose for "finished". */
  readonly done: boolean;
}

function statusConfig(config: unknown): Readonly<Record<string, unknown>> {
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

/**
 * How far along a reading is, out of a hundred: its own level where it has one,
 * else its number where its unit is a per-cent sign. Refused rather than
 * clamped outside 0-100, the tile's rule: a washer at 140% is an integration
 * being wrong, and a full bar would say it had finished.
 */
export function percentOf(reading: StatusReading | undefined): number | undefined {
  if (reading === undefined) return undefined;
  if (typeof reading.level === 'number' && reading.level >= 0 && reading.level <= 100) return reading.level;
  if (reading.unit !== '%') return undefined;
  // The figure the words lead with: a wall joins the unit on ("45 %"), a
  // panel does not ("45"), and both are forty-five.
  const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(reading.value);
  const number = match === null ? NaN : Number(match[1]);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : undefined;
}

/**
 * Whether a reading says the card's finished words — compared as the wall
 * writes them, ignoring case and the space around them, so "complete" and
 * "Complete" are one answer. No words chosen is never finished.
 */
export function isDone(reading: StatusReading, config: unknown): boolean {
  const words = statusConfig(config)['doneState'];
  if (typeof words !== 'string' || words.trim() === '') return false;
  return reading.value.trim().toLowerCase() === words.trim().toLowerCase();
}

/**
 * The card's parts from the house's readings (`all`) and the ones the widget
 * shows (`shown`, its `readings` applied): the subject it names by handle, or
 * else the first it shows; up to four of the others it shows; the progress
 * reading it names, or else the subject's own; and whether it has finished.
 * Nothing to show is no card.
 */
export function statusParts<R extends StatusReading>(
  all: readonly R[],
  shown: readonly R[],
  config: unknown,
): StatusParts<R> | undefined {
  const c = statusConfig(config);
  const named = typeof c['subject'] === 'string' ? all.find((r) => r.key === c['subject']) : undefined;
  const subject = named ?? shown[0];
  if (subject === undefined) return undefined;
  const progressReading = typeof c['progress'] === 'string' ? all.find((r) => r.key === c['progress']) : undefined;
  const details = shown.filter((r) => r !== subject && r !== progressReading).slice(0, STATUS_DETAILS);
  const progress = percentOf(progressReading ?? subject);
  return { subject, details, ...(progress === undefined ? {} : { progress }), done: isDone(subject, config) };
}

/**
 * A series as heights from 0 (the day's least) to 1 (its most), `null` where it
 * has none — or nothing at all for a series with fewer than two numbers, which
 * is a dot rather than a line. A flat day is drawn level through the middle,
 * so "nothing changed" reads as a line and not as an empty box.
 */
export function sparkHeights(series: readonly (number | null)[] | undefined): (number | null)[] | undefined {
  if (series === undefined) return undefined;
  const numbers = series.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length < 2) return undefined;
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return series.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return high === low ? 0.5 : (value - low) / (high - low);
  });
}

/**
 * The runs of a series to draw as lines, split where it has no number: each
 * run a list of [index, height]. A run of one point is kept, so a lone half
 * hour between two gaps is still drawn as a dot.
 */
export function sparkRuns(heights: readonly (number | null)[]): (readonly [number, number])[][] {
  const runs: (readonly [number, number])[][] = [];
  let run: (readonly [number, number])[] = [];
  heights.forEach((height, index) => {
    if (height === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push([index, height]);
  });
  if (run.length > 0) runs.push(run);
  return runs;
}
/* status-card:end */
