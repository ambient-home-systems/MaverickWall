import { readFeed } from '../news/feed.js';
import { readXml, type XmlNode } from '../../xml/read.js';

/**
 * What a recipe's request answers with, read into the plain tree its
 * selectors walk (plan item M7.9).
 *
 * A recipe's selectors are dotted paths into JSON, so a feed and an XML
 * document are turned into JSON here, once, before anything selects from
 * them. Nothing in the recipe language changes to read them: `items` in a
 * feed and `rss.channel.item` in a document are paths like any other.
 *
 * Both are read by the narrow XML reader the news screen and CalDAV share
 * (`xml/read.ts`): no DTD, no entity beyond the five built-ins, nesting
 * capped. A feed goes through the news screen's own parser, so RSS 2.0,
 * RSS 1.0 and Atom all come out as one shape and one bad item costs that item.
 */

export type SourceFormat = 'json' | 'feed' | 'xml';

export type BodyRead = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly why: string };

/** How deep an XML document may nest before it is refused: a feed's own limit. */
const XML_DEPTH = 64;

/** Read a fetched body in the format the recipe named. Never throws. */
export function readBody(format: SourceFormat, text: string): BodyRead {
  if (format === 'feed') return feedBody(text);
  if (format === 'xml') return xmlBody(text);
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, why: 'did not return JSON' };
  }
}

/*
 * A feed's headlines as `{ title, items: [{ title, link, published, id }] }`,
 * newest as the feed lists them. `published` is an ISO instant, which `date`,
 * `time` and a `time` sort all read. A feed with nothing in it is an empty
 * list rather than a failure, so a recipe's `empty` words say so and the wall
 * does not keep yesterday's headlines.
 */
function feedBody(text: string): BodyRead {
  const read = readFeed(text);
  if (!read.ok) {
    if (read.code === 'no-headlines') return { ok: true, body: { items: [] } };
    return { ok: false, why: 'did not return a feed' };
  }
  return {
    ok: true,
    body: {
      ...(read.feed.title !== undefined ? { title: read.feed.title } : {}),
      items: read.feed.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.link !== undefined ? { link: item.link } : {}),
        ...(item.publishedAt !== undefined ? { published: new Date(item.publishedAt).toISOString() } : {}),
      })),
    },
  };
}

/*
 * An XML document as a tree of plain values, keyed by local name:
 *
 *   - an element with no attributes and no children is its text;
 *   - any other element is an object: its attributes under `_attr`, its own
 *     text under `_text`, and each kind of child under that child's name —
 *     one child is the child, more than one is a list of them in order;
 *   - the root is one key, so `<rss>` is reached as `rss`.
 *
 * A name keeps the characters a selector can say (letters, digits and `_`);
 * any other becomes `_`, so `xml:lang` is `xml_lang`. Objects have no
 * prototype, so an element called `__proto__` is an ordinary key.
 *
 * One child and many are different shapes, which is what makes a document
 * readable as `rss.channel.title` rather than `rss[0].channel[0].title[0]`.
 * The cost is a list of one, so an element object is marked, and a `for`
 * that lands on one marked element reads it as a list of one.
 */
const XML_ELEMENT = Symbol('xml element');

function xmlBody(text: string): BodyRead {
  const read = readXml(text, { maxDepth: XML_DEPTH, undeclaredPrefixes: 'keep' });
  if (!read.ok) return { ok: false, why: 'did not return XML a recipe can read' };
  const out = Object.create(null) as Record<string, unknown>;
  out[keyOf(read.root.qname.localName)] = elementValue(read.root);
  return { ok: true, body: out };
}

function keyOf(name: string): string {
  const key = name.replace(/[^A-Za-z0-9_]/g, '_');
  return key === '' ? '_' : key;
}

function elementValue(node: XmlNode): unknown {
  // The reader has already left out namespace declarations, which nobody reads.
  const attributes = Object.entries(node.attributes);
  const text = node.text.trim();
  if (attributes.length === 0 && node.children.length === 0) return text;
  const out = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(out, XML_ELEMENT, { value: true });
  for (const child of node.children) {
    const key = keyOf(child.qname.localName);
    const value = elementValue(child);
    if (!(key in out)) out[key] = value;
    // An element's value is never a list, so a list here is repeats already gathered.
    else if (Array.isArray(out[key])) (out[key] as unknown[]).push(value);
    else out[key] = [out[key], value];
  }
  if (attributes.length > 0) {
    const attr = Object.create(null) as Record<string, string>;
    for (const [name, value] of attributes) attr[keyOf(name)] = value;
    out['_attr'] = attr;
  }
  if (text !== '') out['_text'] = text;
  return out;
}

/** Is this one element of an XML document, which a `for` reads as a list of one? */
export function isXmlElement(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { [XML_ELEMENT]?: true })[XML_ELEMENT] === true
  );
}
