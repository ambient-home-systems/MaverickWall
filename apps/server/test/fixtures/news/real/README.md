# Real news feeds

Captured on 6 October 2026 with `curl -sL`, unedited, for `news-feed.test.ts`
and `news.test.ts` (plan item M5.5). Real bytes rather than invented ones,
because every feed parser this project has shipped broke first on something
real.

| File | From | Shape | Why it is here |
| --- | --- | --- | --- |
| `bbc-news.rss.xml` | feeds.bbci.co.uk/news/rss.xml | RSS 2.0 | A large site's ordinary feed: 30 items, `&amp;` in links. |
| `npr-news.rss.xml` | feeds.npr.org/1001/rss.xml | RSS 2.0 | `&apos;` in titles, dates with a numeric offset. |
| `hacker-news.rss.xml` | hnrss.org/frontpage | RSS 2.0 | No XML declaration; links to other sites. |
| `nasa-breaking.rss.xml` | www.nasa.gov/rss/dyn/breaking_news.rss | RSS 2.0 | Each article embedded whole in CDATA, `<!DOCTYPE html>` and `&nbsp;` included — which a reader refusing a DOCTYPE anywhere in the bytes would refuse. |
| `github-releases.atom.xml` | github.com/ambient-home-systems/MaverickWall/releases.atom | Atom | This repository's own releases. |
| `slashdot.rdf.xml` | rss.slashdot.org/Slashdot/slashdotMain | RSS 1.0 (RDF) | The third shape, declared ISO-8859-1 and ASCII in practice. |

The Guardian's UK feed (485 KB, 139 items) was captured and read too, and is
not committed for its size.

**Not covered by any of these:** a feed whose bytes are genuinely not UTF-8.
The fetcher decodes every body as UTF-8, so such a feed draws a replacement
character where an accented letter was. That is a known limit, not a test gap
that passes.
