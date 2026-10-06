import { readXml, type XmlNode } from '../../xml/read.js';
import { clean } from '../weather/alerts.js';

/**
 * Reading a news feed (plan item M5.5): RSS 2.0, RSS 1.0 (RDF) and Atom, the
 * three a household will meet, through the shared narrow XML reader — no DTD,
 * no entity expansion beyond the built-ins, depth capped (`xml/read.ts`).
 *
 * **What comes out is a headline, a link and a time, and nothing else.** No
 * summary, no picture and no markup: a headline is a stranger's sentence on
 * the household's wall, so it is reduced to plain text, stripped of control
 * and bidi characters by the same `clean` a weather warning goes through, and
 * capped. The link is kept only when it is an absolute `http` or `https`
 * address, because it is drawn as a QR code for a phone to open and nothing
 * else; the wall never makes it a link (rule three, and the plan's own line).
 *
 * **One bad item costs that item, never the feed** — the first row of
 * CLAUDE.md's table. An item with no title is skipped; an unreadable date is
 * no date; a link that is not a web address is no link. Only a document that
 * is not a feed at all is refused, with a sentence that says which.
 */

/** More than a wall shows; fewer than a feed's whole archive. */
export const MAX_FEED_ITEMS = 30;
/** A headline, not a paragraph. */
export const MAX_HEADLINE = 200;
/** A link longer than this is not one a phone needs to be handed. */
export const MAX_LINK = 2000;
/** An Atom entry's XHTML title can nest; a multistatus cannot, and refuses at 20. */
const FEED_DEPTH = 64;

const ATOM = 'http://www.w3.org/2005/Atom';
const RSS1 = 'http://purl.org/rss/1.0/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DC = 'http://purl.org/dc/elements/1.1/';

export interface FeedItem {
  /** The feed's own id for the item (`guid`, Atom `id`), else its link, else its title. */
  readonly id: string;
  readonly title: string;
  readonly link?: string;
  readonly publishedAt?: number;
}

export interface Feed {
  /** The feed's own name, cleaned, for when the household gives it none. */
  readonly title?: string;
  readonly items: readonly FeedItem[];
}

export type FeedErrorCode = 'web-page' | 'refused' | 'not-a-feed' | 'no-headlines';

export type FeedResult =
  | { readonly ok: true; readonly feed: Feed }
  | { readonly ok: false; readonly code: FeedErrorCode; readonly message: string };

const NONE = '';

function children(node: XmlNode, namespace: string, localName: string): XmlNode[] {
  return node.children.filter((child) => child.qname.namespace === namespace && child.qname.localName === localName);
}

function first(node: XmlNode, namespace: string, localName: string): XmlNode | undefined {
  return children(node, namespace, localName)[0];
}

/** Every piece of character data at and under a node, in document order. */
function allText(node: XmlNode): string {
  if (node.children.length === 0) return node.text;
  return node.text + node.children.map(allText).join(' ');
}

/**
 * HTML's commonest named references, for a title that arrives HTML-escaped.
 *
 * Not an entity mechanism: each expands to one character and names nothing,
 * as the XML built-ins do. They are here because a headline written as HTML —
 * an Atom `type="html"` title, or an RSS title escaped twice — still carries
 * them after the XML layer has decoded its own, and "Fish &amp; chips" is not
 * what anybody wrote. Anything not in this table is left as written.
 */
const HTML_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return HTML_REFERENCES[name] ?? whole;
  });
}

/**
 * A headline as plain text: markup removed, HTML references decoded once,
 * then the same cleaning and cap a weather warning gets.
 */
export function headlineText(raw: string): string | undefined {
  const plain = decodeHtml(raw.replace(/<[^>]*>/g, ' '));
  const cleaned = clean(plain, MAX_HEADLINE);
  return cleaned === null || cleaned === NONE ? undefined : cleaned;
}

/** An absolute web address, or nothing: the only thing a QR code on a wall may carry. */
export function webLink(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === NONE || text.length > MAX_LINK || /\s/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== NONE || url.password !== NONE) return undefined;
  return url.href;
}

function when(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === NONE) return undefined;
  const at = Date.parse(raw.trim());
  return Number.isFinite(at) ? at : undefined;
}

function item(fields: {
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly link: string | undefined;
  readonly at: string | undefined;
}): FeedItem | undefined {
  const title = fields.title === undefined ? undefined : headlineText(fields.title);
  if (title === undefined) return undefined;
  const link = webLink(fields.link);
  const publishedAt = when(fields.at);
  const id = (fields.id ?? '').trim() || link || `${title}|${fields.at ?? ''}`;
  return {
    id: id.slice(0, MAX_LINK),
    title,
    ...(link === undefined ? {} : { link }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

function rss2(channel: XmlNode): FeedItem[] {
  const out: FeedItem[] = [];
  for (const entry of children(channel, NONE, 'item')) {
    const guid = first(entry, NONE, 'guid');
    const permalink = guid !== undefined && guid.attributes['isPermaLink'] !== 'false' ? guid.text : undefined;
    const read = item({
      id: guid?.text,
      title: first(entry, NONE, 'title')?.text,
      link: first(entry, NONE, 'link')?.text ?? permalink,
      at: first(entry, NONE, 'pubDate')?.text ?? first(entry, DC, 'date')?.text,
    });
    if (read !== undefined) out.push(read);
  }
  return out;
}

function rss1(root: XmlNode): FeedItem[] {
  const out: FeedItem[] = [];
  for (const entry of children(root, RSS1, 'item')) {
    const read = item({
      id: entry.attributes['rdf:about'],
      title: first(entry, RSS1, 'title')?.text,
      link: first(entry, RSS1, 'link')?.text,
      at: first(entry, DC, 'date')?.text,
    });
    if (read !== undefined) out.push(read);
  }
  return out;
}

/** An Atom title or link, read the way Atom says: by `type` and by `rel`. */
function atomTitle(node: XmlNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  // `xhtml` carries its markup as elements; `html` and `text` as text.
  return node.attributes['type'] === 'xhtml' ? allText(node) : node.text;
}

function atomLink(entry: XmlNode): string | undefined {
  const links = children(entry, ATOM, 'link');
  const alternate = links.find((link) => (link.attributes['rel'] ?? 'alternate') === 'alternate');
  return alternate?.attributes['href'];
}

function atom(root: XmlNode): FeedItem[] {
  const out: FeedItem[] = [];
  for (const entry of children(root, ATOM, 'entry')) {
    const read = item({
      id: first(entry, ATOM, 'id')?.text,
      title: atomTitle(first(entry, ATOM, 'title')),
      link: atomLink(entry),
      at: first(entry, ATOM, 'published')?.text ?? first(entry, ATOM, 'updated')?.text,
    });
    if (read !== undefined) out.push(read);
  }
  return out;
}

/**
 * Read a feed, or say plainly why it is not one.
 *
 * A web page is told apart from a broken feed before parsing, because it is
 * the commonest wrong address a household pastes — the site's front page
 * rather than its feed — and "that is a web page" names the fix where "not
 * well-formed XML" names nothing.
 */
export function readFeed(text: string): FeedResult {
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!doctype\s+html|<html[\s>])/i.test(text)) {
    return {
      ok: false,
      code: 'web-page',
      message:
        'That address is a web page, not a feed. Look on the site for a link marked RSS or Feed, and paste that.',
    };
  }
  const parsed = readXml(text, { maxDepth: FEED_DEPTH, undeclaredPrefixes: 'keep' });
  if (!parsed.ok) {
    return parsed.error.code === 'doctype-refused' || parsed.error.code === 'entity-refused'
      ? {
          ok: false,
          code: 'refused',
          message:
            'That feed uses an XML feature this wall does not read, for safety (a DOCTYPE or an entity it ' +
            'would have to look up). Most sites offer another feed; try their Atom feed if they have one.',
        }
      : {
          ok: false,
          code: 'not-a-feed',
          message: 'That address answered with something that is not a feed. Check it is the feed’s own address.',
        };
  }
  const root = parsed.root;
  let title: string | undefined;
  let items: FeedItem[];
  if (root.qname.namespace === NONE && root.qname.localName === 'rss') {
    const channel = first(root, NONE, 'channel');
    if (channel === undefined) return notAFeed();
    title = first(channel, NONE, 'title')?.text;
    items = rss2(channel);
  } else if (root.qname.namespace === RDF && root.qname.localName === 'RDF') {
    const channel = first(root, RSS1, 'channel');
    title = channel === undefined ? undefined : first(channel, RSS1, 'title')?.text;
    items = rss1(root);
  } else if (root.qname.namespace === ATOM && root.qname.localName === 'feed') {
    title = atomTitle(first(root, ATOM, 'title'));
    items = atom(root);
  } else {
    return notAFeed();
  }
  if (items.length === 0) {
    return {
      ok: false,
      code: 'no-headlines',
      message: 'That feed has no headlines in it right now. It may be empty, or every item may be missing a title.',
    };
  }
  const name = title === undefined ? undefined : headlineText(title);
  return {
    ok: true,
    feed: { ...(name === undefined ? {} : { title: name.slice(0, 60) }), items: items.slice(0, MAX_FEED_ITEMS) },
  };
}

function notAFeed(): FeedResult {
  return {
    ok: false,
    code: 'not-a-feed',
    message: 'That address answered with XML that is not a news feed. Check it is the feed’s own address.',
  };
}
