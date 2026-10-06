/**
 * How a Heading widget reads its config, transcribed from the server's
 * `api/heading.ts` (plan item M5.4), which says what each reading means and
 * why there are two copies. `transcription-parity.test.ts` holds them to each other.
 */

/* heading:begin */
export type HeadingSize = 'small' | 'medium' | 'large';
export type HeadingPlace = 'top' | 'middle' | 'bottom';

/** Every size, largest first: the order a heading that does not fit steps down. */
export const HEADING_SIZES: readonly HeadingSize[] = ['large', 'medium', 'small'];

function words(config: unknown, key: string): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const value = (config as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return (config as Record<string, unknown>)['uppercase'] === true ? value.toUpperCase() : value;
}

/** The size asked for: absent, and anything unknown, is medium. */
export function headingSize(config: unknown): HeadingSize {
  const size = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['textSize'] : undefined;
  return size === 'small' || size === 'large' ? size : 'medium';
}

/** The sizes this heading may be drawn at, the one asked for first. */
export function headingSizesFrom(config: unknown): readonly HeadingSize[] {
  return HEADING_SIZES.slice(HEADING_SIZES.indexOf(headingSize(config)));
}

/** Where the block sits in its box: absent is the middle. */
export function headingPlace(config: unknown): HeadingPlace {
  const place = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['valign'] : undefined;
  return place === 'top' || place === 'bottom' ? place : 'middle';
}

/** The heading line, as it is drawn. */
export function headingText(config: unknown): string | undefined {
  return words(config, 'text');
}

/** The second line under it, as it is drawn. */
export function headingSecond(config: unknown): string | undefined {
  return words(config, 'subtitle');
}

/**
 * Whether a rule is drawn: only when asked, and only with a heading to sit
 * under — a rule on its own is a line with nothing to separate.
 */
export function headingDivider(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  return (config as Record<string, unknown>)['divider'] === true && headingText(config) !== undefined;
}
/* heading:end */
