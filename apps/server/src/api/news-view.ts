/**
 * How a News widget reads its config (plan item M5.5), for the wall, the
 * editor's preview and an e-paper panel alike. Transcribed between the markers
 * into `apps/display/src/news-view.ts` and held character for character by
 * `transcription-parity.test.ts`, for the reason every pair on that seam is.
 *
 * A widget shows the headlines of the feeds it names (all of them when it
 * names none), newest first, as a list or one at a time. In the one-at-a-time
 * view the headline on show is chosen by the clock, not by a counter, so two
 * walls showing the same feeds show the same headline and a wall that lost the
 * server keeps turning through the headlines it has. A panel never turns: it
 * shows one picture for up to an hour, so it draws the newest.
 */

/* news-view:begin */
export type NewsMode = 'list' | 'one';

export interface NewsHeadlineLike {
  readonly key: string;
  readonly feed: string;
  readonly source: string;
  readonly title: string;
  readonly at?: number;
  readonly link?: string;
}

/** The headlines-at-a-time sizes a widget may ask for, in seconds; absent is a minute. */
export const NEWS_ROTATE_SECONDS: readonly number[] = [30, 60, 300];

function setting(config: unknown, key: string): unknown {
  return typeof config === 'object' && config !== null ? (config as Record<string, unknown>)[key] : undefined;
}

/** A list, or one headline at a time. */
export function newsMode(config: unknown): NewsMode {
  return setting(config, 'mode') === 'one' ? 'one' : 'list';
}

/** The headlines this widget shows: those of the feeds it names, or all. */
export function newsShown<T extends NewsHeadlineLike>(headlines: readonly T[], config: unknown): T[] {
  const feeds = setting(config, 'newsFeeds');
  if (!Array.isArray(feeds) || feeds.length === 0) return [...headlines];
  return headlines.filter((headline) => feeds.indexOf(headline.feed) >= 0);
}

/** Whether a part is drawn: the source, the time and the code are on unless switched off. */
export function newsShows(config: unknown, key: 'showSource' | 'showTime' | 'showQr'): boolean {
  return setting(config, key) !== false;
}

/** How long each headline stays in the one-at-a-time view. */
export function newsRotateMs(config: unknown): number {
  const seconds = setting(config, 'rotateSeconds');
  return (typeof seconds === 'number' && NEWS_ROTATE_SECONDS.indexOf(seconds) >= 0 ? seconds : 60) * 1000;
}

/** Which of `count` headlines is on show at `now`. */
export function newsIndexAt(count: number, now: number, config: unknown): number {
  if (count <= 0) return 0;
  return Math.floor(now / newsRotateMs(config)) % count;
}
/* news-view:end */
