/**
 * How a Heading widget reads its config (plan item M5.4), for the wall, the
 * editor's preview and an e-paper panel alike.
 *
 * A heading and an optional second line the household typed, an optional
 * picture from the drawn glyph set beside the heading, an optional rule
 * between the two, and where in its box the block sits. Read once, here, and
 * transcribed between the markers into `apps/display/src/heading.ts`;
 * `transcription-parity.test.ts` holds the two copies character for character —
 * the seam `qr-payload.ts` uses, for the reason it uses it: two renderers
 * reading one value two ways is this project's most repeated fault.
 *
 * **The text is the household's and is drawn as written** (Q9): no rewriting,
 * no stripping of what they typed, and in the theme's own face on the wall,
 * where a character the face lacks falls through to the device's font. The
 * one change is `uppercase`, applied here so both media capitalise alike. A
 * panel's ASCII alphabet is its own guard (`asciiTitle`), as it is for every
 * title.
 *
 * **Size is three of the wall's own roles, not a number**, so a heading can
 * never be a stat tile: small is the event role, medium the lede, and large
 * the clock's own capped size — nothing a household places is larger than the
 * clock already may be. The size chosen is the most it may be: where the
 * words do not fit the box at that size they step down a role, which is a
 * form chosen from the box and never a scale.
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
