import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_FEED_ITEMS, headlineText, readFeed, webLink } from '../src/modules/news/feed.js';
import { readXml } from '../src/xml/read.js';

/**
 * Reading a news feed (plan item M5.5), against real bytes first.
 *
 * `fixtures/news/real/` holds six feeds captured on 6 October 2026, unedited:
 * RSS 2.0 from BBC News, NPR, Hacker News and NASA, Atom from this
 * repository's own releases, and RSS 1.0 (RDF) from Slashdot. NASA's is the
 * one that matters most here: every article is embedded whole, `<!DOCTYPE
 * html>` and `&nbsp;` included, inside CDATA — the CalDAV reader refuses a
 * DOCTYPE anywhere in the bytes and would have refused NASA's news outright.
 * Then the documents a stranger could send, each refused or reduced.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const real = (name: string): string => readFileSync(join(HERE, 'fixtures', 'news', 'real', name), 'utf8');

describe('real feeds', () => {
  const cases = [
    ['bbc-news.rss.xml', 'BBC News', 30],
    ['npr-news.rss.xml', 'NPR Topics: News', 10],
    ['hacker-news.rss.xml', 'Hacker News: Front Page', 20],
    ['nasa-breaking.rss.xml', 'NASA', 10],
    ['github-releases.atom.xml', 'Release notes from MaverickWall', 10],
    ['slashdot.rdf.xml', 'Slashdot', 15],
  ] as const;

  for (const [file, title, count] of cases) {
    it(`reads ${file}: its name, every headline, a web link and a time on each`, () => {
      const read = readFeed(real(file));
      expect(read.ok, read.ok ? '' : read.message).toBe(true);
      if (!read.ok) return;
      expect(read.feed.title).toBe(title);
      expect(read.feed.items).toHaveLength(Math.min(count, MAX_FEED_ITEMS));
      for (const item of read.feed.items) {
        expect(item.title.length).toBeGreaterThan(0);
        expect(item.title).not.toMatch(/[<>]|&[a-z]+;/);
        expect(item.link).toMatch(/^https:\/\//);
        expect(Number.isFinite(item.publishedAt)).toBe(true);
      }
    });
  }

  it('reads the first headline of each as the site wrote it', () => {
    const first = (file: string) => {
      const read = readFeed(real(file));
      return read.ok ? read.feed.items[0] : undefined;
    };
    expect(first('npr-news.rss.xml')).toEqual({
      id: 'https://www.npr.org/2026/10/06/nx-s1-5992819/france-student-protests-schools',
      title: "France's police fire tear gas and water cannons as school protests sweep the country",
      link: 'https://www.npr.org/2026/10/06/nx-s1-5992819/france-student-protests-schools',
      publishedAt: Date.parse('Tue, 06 Oct 2026 14:05:44 -0400'),
    });
    expect(first('github-releases.atom.xml')?.title).toBe('v0.84.0');
    expect(first('github-releases.atom.xml')?.link).toBe(
      'https://github.com/ambient-home-systems/MaverickWall/releases/tag/v0.84.0',
    );
  });
});

describe('what a stranger could send', () => {
  const rss = (items: string, head = ''): string =>
    `<?xml version="1.0"?>${head}<rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;

  it('refuses a DOCTYPE in the prolog, and with it any entity it declares', () => {
    const bomb = rss(
      '<item><title>&lol;</title></item>',
      '<!DOCTYPE rss [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>',
    );
    const read = readFeed(bomb);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe('refused');
    expect(readXml(bomb, { maxDepth: 64 }).ok).toBe(false);
  });

  it('refuses an entity nobody declared, rather than passing it through', () => {
    const read = readFeed(rss('<item><title>Fish &xxe; chips</title></item>'));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe('refused');
  });

  it('reads a DOCTYPE inside CDATA as the text it is', () => {
    const read = readFeed(
      rss('<item><title>Hello</title><description><![CDATA[<!DOCTYPE html><p>&nbsp;</p>]]></description></item>'),
    );
    expect(read.ok).toBe(true);
  });

  it('says a web page is a web page', () => {
    for (const page of ['<!DOCTYPE html><html><body>Hi</body></html>', '<html lang="en"><head></head></html>']) {
      const read = readFeed(page);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.code).toBe('web-page');
        expect(read.message).toContain('RSS');
      }
    }
  });

  it('costs one bad item that item, never the feed', () => {
    const read = readFeed(
      rss(
        '<item><title>First</title><link>https://example.com/1</link></item>' +
          '<item><description>No title at all</description></item>' +
          '<item><title>Third</title><link>javascript:alert(1)</link><pubDate>not a date</pubDate></item>',
      ),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.feed.items.map((item) => item.title)).toEqual(['First', 'Third']);
    // A link that is not a web address is no link, and a date that is not one no date.
    expect(read.feed.items[1]).toEqual({ id: 'Third|not a date', title: 'Third' });
  });

  it('reduces a headline to plain text: no markup, no controls, no bidi override', () => {
    // After the XML layer has decoded its own: an HTML-escaped title still says `&amp;`.
    expect(headlineText('<b>Bold</b> &amp; <i>brave</i>')).toBe('Bold & brave');
    expect(headlineText('Price ‮evil‬ rises')).toBe('Price evil rises');
    expect(headlineText('Line one\nline two')).toBe('Line one line two');
    expect(headlineText('x'.repeat(500))?.length).toBeLessThanOrEqual(200);
    expect(headlineText('   ')).toBeUndefined();
  });

  it('keeps only an absolute http or https link with no credentials in it', () => {
    expect(webLink('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(webLink('http://example.com/')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '/relative', 'https://user:pw@example.com/', 'ftp://x/']) {
      expect(webLink(bad), bad).toBeUndefined();
    }
  });

  it('reads Atom by its own rules: the alternate link, and an XHTML title as its words', () => {
    const read = readFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>' +
        '<entry><id>tag:1</id><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hello <b>world</b></div></title>' +
        '<link rel="enclosure" href="https://example.com/file.mp3"/><link href="https://example.com/post"/>' +
        '<updated>2026-10-06T12:00:00Z</updated></entry></feed>',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.feed.items[0]).toEqual({
      id: 'tag:1',
      title: 'Hello world',
      link: 'https://example.com/post',
      publishedAt: Date.UTC(2026, 9, 6, 12),
    });
  });

  it('reads a prefix nobody declared rather than refusing the feed over it', () => {
    const read = readFeed(rss('<item><title>Pictured</title><media:thumbnail url="x"/></item>'));
    expect(read.ok).toBe(true);
  });

  it('says an empty feed is empty, and XML that is not a feed is not one', () => {
    const empty = readFeed(rss(''));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('no-headlines');
    const other = readFeed('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe('not-a-feed');
  });

  it('refuses nesting past its cap', () => {
    const deep = rss(`<item><title>${'<b>'.repeat(70)}x${'</b>'.repeat(70)}</title></item>`);
    expect(readFeed(deep).ok).toBe(false);
  });
});
