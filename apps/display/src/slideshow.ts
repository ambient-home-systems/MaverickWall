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

/**
 * What happens between two photos (plan item M3.6): a cut, a crossfade, or a
 * crossfade with each photo slowly zooming while it shows. `cut` is the
 * absence, so a slideshow that was hanging before this changes nothing until
 * somebody asks; and a wall with motion off — its own switch, or a device
 * asking for less — cuts whatever is stored.
 */
export type SlideMotion = 'cut' | 'fade' | 'zoom';

export interface SlideConfig {
  readonly seconds: SlideSeconds;
  readonly order: SlideOrder;
  readonly motion: SlideMotion;
}

/** The interval, order and motion a widget stored, read defensively: anything else is the default. */
export function slideConfig(config: Record<string, unknown>): SlideConfig {
  const seconds = config['slideSeconds'];
  const motion = config['slideMotion'];
  return {
    seconds: (SLIDE_SECONDS as readonly unknown[]).includes(seconds) ? (seconds as SlideSeconds) : DEFAULT_SLIDE_SECONDS,
    order: config['slideOrder'] === 'shuffle' ? 'shuffle' : 'in-order',
    motion: motion === 'fade' || motion === 'zoom' ? motion : 'cut',
  };
}

/** How long the next photo takes to fade in, ending exactly at the swap. */
export const FADE_MS = 2_000;

/**
 * When the current photo's swap is, on the wall clock: the end of the step it
 * belongs to. The fade starts `FADE_MS` before it, and each photo's zoom runs
 * from the start of its own fade to the end of the next one — so the photo
 * drawn underneath after a redraw is at exactly the scale it was on top before.
 */
export function slideTiming(nowMs: number, seconds: number): { readonly swapAtMs: number; readonly intervalMs: number } {
  const intervalMs = seconds * 1000;
  return { swapAtMs: (Math.floor(nowMs / intervalMs) + 1) * intervalMs, intervalMs };
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

/**
 * Portrait pairing (plan item M3.7): in a wide box, two portrait photos share
 * it side by side rather than each one sitting in the middle of a landscape
 * box with the sides wasted.
 *
 * A *frame* is what the box shows at once: one photo, or two portraits. The
 * album is grouped into frames one round at a time, in that round's order: a
 * landscape photo — or one whose shape the server does not know yet — is a
 * frame on its own, and a portrait takes the next portrait after it as its
 * partner, which then does not show again that round. An odd portrait out
 * shows alone.
 *
 * The number of frames in a round does not depend on the order — every
 * landscape is one and every two portraits are one — so the step-to-round
 * arithmetic `slideAt` does still works, and every wall with a wide box agrees
 * which pair is up.
 */
export type SlideFrame = readonly [string] | readonly [string, string];

/** The narrowest box, width over height, that two portraits share: below it each would be a sliver. */
export const PAIR_MIN_ASPECT = 1.2;

export function pairFrames(photos: readonly string[], portraits: ReadonlySet<string>): SlideFrame[] {
  const frames: SlideFrame[] = [];
  const taken = new Set<number>();
  photos.forEach((photo, index) => {
    if (taken.has(index)) return;
    if (!portraits.has(photo)) {
      frames.push([photo]);
      return;
    }
    const partner = photos.findIndex((other, at) => at > index && !taken.has(at) && portraits.has(other));
    if (partner === -1) {
      frames.push([photo]);
      return;
    }
    taken.add(partner);
    frames.push([photo, photos[partner] ?? photo]);
  });
  return frames;
}

/**
 * The frame on show at `nowMs`, and the one after it: `slideAt`, a frame at a
 * time. With no portraits it is exactly `slideAt`, one photo a frame.
 */
export function frameAt(
  photos: readonly string[],
  portraits: ReadonlySet<string>,
  nowMs: number,
  config: SlideConfig,
): { readonly current: SlideFrame; readonly next: SlideFrame } | undefined {
  if (photos.length === 0) return undefined;
  const known = photos.filter((photo) => portraits.has(photo)).length;
  const count = photos.length - Math.floor(known / 2);
  const step = Math.floor(nowMs / (config.seconds * 1000));
  const at = (k: number): SlideFrame => {
    const round = Math.floor(k / count);
    const frames = pairFrames(roundOrder(photos, config.order, round), portraits);
    return frames[k - round * count] ?? frames[0] ?? [photos[0] ?? ''];
  };
  return { current: at(step), next: at(step + 1) };
}

/** Whether two frames show the same photos, side for side. */
export function sameFrame(a: SlideFrame, b: SlideFrame): boolean {
  return a.length === b.length && a.every((photo, index) => photo === b[index]);
}
