import { describe, expect, it } from 'vitest';

import { newsFrom } from '../src/viewmodel.js';
import { newsIndexAt, newsMode, newsRotateMs, newsShown, newsShows } from '../src/news-view.js';

/**
 * The News widget's model and its reading of a config (plan item M5.5). The
 * wall draws a stranger's link as a QR code, so it refuses one that is not a
 * web address even after the server already has: one hop is not trusted.
 */
const headline = (over: Record<string, unknown> = {}) => ({
  key: 'nh-aaaaaaaaaaaa',
  feed: 'nf-aaaaaaaaaaaa',
  source: 'Local News',
  title: 'Library opens late',
  at: 1_790_000_000_000,
  link: 'https://example.com/a',
  ...over,
});

describe('newsFrom', () => {
  it('reads a headline, and drops a link that is not a web address', () => {
    expect(newsFrom({ headlines: [headline()] })).toEqual([headline()]);
    for (const link of ['javascript:alert(1)', 'data:text/html,x', 'https://x y', 'x'.repeat(2001)]) {
      expect(newsFrom({ headlines: [headline({ link })] })[0]?.link, link).toBeUndefined();
    }
  });

  it('leaves out what does not have the shape, rather than drawing it', () => {
    expect(newsFrom({ headlines: [headline({ key: 'not-a-key' }), headline({ title: 7 }), 'x', null] })).toEqual([]);
    expect(newsFrom(undefined)).toEqual([]);
    expect(newsFrom({ headlines: 'x' })).toEqual([]);
  });
});

describe('a News widget’s config, read', () => {
  it('is a list unless it asks for one at a time, and turns every minute unless told', () => {
    expect(newsMode({})).toBe('list');
    expect(newsMode({ mode: 'one' })).toBe('one');
    expect(newsRotateMs({})).toBe(60_000);
    expect(newsRotateMs({ rotateSeconds: 300 })).toBe(300_000);
    expect(newsRotateMs({ rotateSeconds: 7 })).toBe(60_000);
  });

  it('turns by the clock, one headline a period, round and round', () => {
    const at = (now: number) => newsIndexAt(4, now, { rotateSeconds: 30 });
    expect([0, 30_000, 60_000, 90_000, 120_000].map(at)).toEqual([0, 1, 2, 3, 0]);
    expect(at(29_999)).toBe(0);
    expect(newsIndexAt(0, 1_000, {})).toBe(0);
  });

  it('shows the feeds it names, or all of them, and each part unless switched off', () => {
    const two = [headline(), headline({ key: 'nh-bbbbbbbbbbbb', feed: 'nf-bbbbbbbbbbbb' })];
    expect(newsShown(two, {})).toHaveLength(2);
    expect(newsShown(two, { newsFeeds: ['nf-bbbbbbbbbbbb'] }).map((one) => one.feed)).toEqual(['nf-bbbbbbbbbbbb']);
    expect(newsShows({}, 'showQr')).toBe(true);
    expect(newsShows({ showQr: false }, 'showQr')).toBe(false);
  });
});
