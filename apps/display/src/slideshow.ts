/**
 * Which photo an album slideshow shows, and which comes next (plan item M5.12).
 *
 * A function of the corrected wall clock and nothing else, so every wall
 * showing the same album shows the same photo, and the redraw every fifteen
 * seconds cannot move it. That is the rule the rest of the wall's movement
 * follows (D7): nothing here keeps state between draws, so there is nothing a
 * rebuilt DOM can lose.
 *
 * Shuffled is a fresh order each time round the album, drawn from the album's
 * own photo names and how many times round it has been. Every photo still
 * shows once a round, and two walls agree on the order without asking each
 * other.
 *
 * Pure, with no DOM, for the reason `widget-options.ts` is.
 */

/** The intervals offered, in seconds: a minute, five, a quarter of an hour, an hour. */
export const SLIDE_SECONDS = [60, 300, 900, 3600] as const;
export type SlideSeconds = (typeof SLIDE_SECONDS)[number];
/** Five minutes, when the widget has not said: long enough to look at, short enough to notice. */
export const DEFAULT_SLIDE_SECONDS: SlideSeconds = 300;

export type SlideOrder = 'in-order' | 'shuffle';

export interface SlideConfig {
  readonly seconds: SlideSeconds;
  readonly order: SlideOrder;
}

/** The interval and order a widget stored, read defensively: anything else is the default. */
export function slideConfig(config: Record<string, unknown>): SlideConfig {
  const seconds = config['slideSeconds'];
  return {
    seconds: (SLIDE_SECONDS as readonly unknown[]).includes(seconds) ? (seconds as SlideSeconds) : DEFAULT_SLIDE_SECONDS,
    order: config['slideOrder'] === 'shuffle' ? 'shuffle' : 'in-order',
  };
}

/** FNV-1a over a string: small, stable everywhere, and plenty for ordering photos. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The album in the order of one round: as stored, or shuffled for that round. */
export function roundOrder(photos: readonly string[], order: SlideOrder, round: number): readonly string[] {
  if (order === 'in-order') return photos;
  return photos
    .map((name, index) => ({ name, index, key: hash(`${round}:${name}`) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.name);
}

/**
 * The photo on show at `nowMs`, and the one after it.
 *
 * The step counts from the epoch, so a wall booted at any moment lands on the
 * photo every other wall is showing. `next` is what to have decoded before the
 * swap: the same as `current` for an album of one.
 */
export function slideAt(
  photos: readonly string[],
  nowMs: number,
  config: SlideConfig,
): { readonly current: string; readonly next: string } | undefined {
  const count = photos.length;
  if (count === 0) return undefined;
  const step = Math.floor(nowMs / (config.seconds * 1000));
  const at = (k: number): string => {
    const round = Math.floor(k / count);
    const position = k - round * count;
    return roundOrder(photos, config.order, round)[position] ?? photos[0] ?? '';
  };
  return { current: at(step), next: at(step + 1) };
}
