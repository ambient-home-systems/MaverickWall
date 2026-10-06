/**
 * A narrow XML reader, shared by CalDAV and news feeds — lifted out of
 * `caldav/multistatus.ts`, whose header is the argument for it and is worth
 * reading first (RFC 013 §6.8): the dangerous features of XML are ones this
 * reader does not implement rather than ones it disables. There is no DTD
 * machinery at all, so a declaration met as markup is refused; there is no
 * entity expansion beyond the five XML built-ins and numeric character
 * references, so any other `&name;` is refused; nesting is capped; and the
 * byte ceiling above all of it is the Fetcher's, enforced while streaming.
 *
 * Pure, never throws, and every refusal is a value with a sentence written
 * for a log or a diagnosis, never for a wall.
 *
 * Two things are the caller's to choose, and they are options rather than
 * forks of this file:
 *
 * - **How deep** a document may nest. A multistatus is six deep at its worst
 *   and refuses past 20; an Atom entry's XHTML content can be deeper than
 *   that, and a feed is read to 64.
 * - **What an undeclared prefix is.** A CalDAV server that writes one has
 *   written a document this reader cannot identify the elements of, so it is
 *   refused there. A feed often borrows `media:` or `dc:` without declaring
 *   it, and refusing a whole news feed over one thumbnail element is the fault
 *   the first row of CLAUDE.md's table is about; there a prefix nobody
 *   declared is read as a namespace named after itself, `media:`.
 */

/** A namespace and a local name: the only identity a prefix-choosing writer cannot change. */
export interface XmlName {
  readonly namespace: string;
  readonly localName: string;
}

export type XmlErrorCode =
  /** A `DOCTYPE`, or any other declaration, met as markup. */
  | 'doctype-refused'
  /** An entity reference that is not one of the five built-ins or a numeric one. */
  | 'entity-refused'
  /** Nesting past the caller's depth. */
  | 'too-deep'
  /** Not well-formed: an unclosed element, a mismatched tag, a truncated file. */
  | 'malformed'
  /** A prefix used but never declared, where the caller refuses one. */
  | 'undeclared-prefix';

export interface XmlFailure {
  readonly ok: false;
  readonly error: { readonly code: XmlErrorCode; readonly message: string };
}

export interface ReadXmlOptions {
  readonly maxDepth: number;
  /** `refuse` (the default) or `keep`: see the header. */
  readonly undeclaredPrefixes?: 'refuse' | 'keep';
}

function fail(code: XmlErrorCode, message: string): XmlFailure {
  return { ok: false, error: { code, message } };
}

/**
 * The five XML built-ins, and nothing else will ever be added to this table.
 *
 * Every one of them expands to a single character and none of them can name
 * anything — that is the whole distinction between these and the entity class
 * XXE lives in. An entity that is not here is a refusal, not a passthrough.
 */
const BUILT_IN_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * A character reference expands to one code point and cannot name a resource,
 * so it is resolved. The cap is what stops `&#x110000;` and a run of digits
 * long enough to be interesting: anything out of range is a refusal.
 */
function decodeCharacterReference(spec: string): string | undefined {
  const hex = spec.startsWith('x') || spec.startsWith('X');
  const digits = hex ? spec.slice(1) : spec;
  if (digits.length === 0 || digits.length > 8) return undefined;
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return undefined;
  const code = Number.parseInt(digits, hex ? 16 : 10);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
  // Surrogates are not characters; a document naming one is malformed rather
  // than merely odd, and `String.fromCodePoint` would happily produce a lone
  // one that then poisons every string it is concatenated into.
  if (code >= 0xd800 && code <= 0xdfff) return undefined;
  return String.fromCodePoint(code);
}

/**
 * Resolve entity references in text, refusing anything that is not built in.
 *
 * The refusal is the feature. A reader that passed `&xxe;` through as the
 * literal text `&xxe;` would be quietly reporting a document it did not
 * understand, and a household's calendar name is not where that gets noticed.
 */
function decodeText(raw: string): { ok: true; text: string } | { ok: false; name: string } {
  if (!raw.includes('&')) return { ok: true, text: raw };

  let out = '';
  let index = 0;
  while (index < raw.length) {
    const amp = raw.indexOf('&', index);
    if (amp === -1) {
      out += raw.slice(index);
      break;
    }
    out += raw.slice(index, amp);
    const semi = raw.indexOf(';', amp);
    // A bare `&` with no terminator is not a reference at all. Refused rather
    // than kept: well-formed XML does not contain one, and a document that does
    // is a document written by something we should not be guessing at.
    if (semi === -1 || semi === amp + 1) return { ok: false, name: '&' };
    const name = raw.slice(amp + 1, semi);
    if (name.startsWith('#')) {
      const decoded = decodeCharacterReference(name.slice(1));
      if (decoded === undefined) return { ok: false, name: `&${name};` };
      out += decoded;
    } else {
      const builtIn = BUILT_IN_ENTITIES[name];
      if (builtIn === undefined) return { ok: false, name: `&${name};` };
      out += builtIn;
    }
    index = semi + 1;
  }
  return { ok: true, text: out };
}

interface OpenTag {
  readonly name: string;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly selfClosing: boolean;
  /** Index just past the `>`. */
  readonly end: number;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9._:]/;

/**
 * Read one start tag, including its attributes.
 *
 * Hand-written rather than a regular expression for one reason that is worth a
 * line: an attribute value may contain `>`, and every regex anybody writes for
 * a tag stops at the first one.
 *
 * **Names are ASCII**, which is narrower than XML allows and is stated rather
 * than discovered. Every element and attribute name in DAV:, CalDAV and
 * calendarserver.org is ASCII, and a server inventing a non-ASCII one gets a
 * `malformed` rather than a silent misreading. That is the honest failure and
 * it is the *correctness* risk §6.8 names — this reader is narrow, and where it
 * is too narrow it should say so rather than guess. Widening it is a change to
 * two character classes; nothing else here assumes ASCII.
 *
 * There is deliberately no cap on attributes per element: the byte ceiling
 * above already bounds them, and a second limit is a second number to get
 * wrong.
 */
function readStartTag(xml: string, from: number): OpenTag | undefined {
  let index = from + 1;
  let name = '';
  if (index >= xml.length || !NAME_START.test(xml[index] ?? '')) return undefined;
  while (index < xml.length && NAME_CHAR.test(xml[index] ?? '')) {
    name += xml[index];
    index++;
  }

  const attributes: { name: string; value: string }[] = [];
  for (;;) {
    while (index < xml.length && /\s/.test(xml[index] ?? '')) index++;
    if (index >= xml.length) return undefined;
    const ch = xml[index];
    if (ch === '>') return { name, attributes, selfClosing: false, end: index + 1 };
    if (ch === '/') {
      if (xml[index + 1] !== '>') return undefined;
      return { name, attributes, selfClosing: true, end: index + 2 };
    }
    if (!NAME_START.test(ch ?? '')) return undefined;

    let attrName = '';
    while (index < xml.length && NAME_CHAR.test(xml[index] ?? '')) {
      attrName += xml[index];
      index++;
    }
    while (index < xml.length && /\s/.test(xml[index] ?? '')) index++;
    if (xml[index] !== '=') return undefined;
    index++;
    while (index < xml.length && /\s/.test(xml[index] ?? '')) index++;
    const quote = xml[index];
    if (quote !== '"' && quote !== "'") return undefined;
    index++;
    const close = xml.indexOf(quote, index);
    if (close === -1) return undefined;
    attributes.push({ name: attrName, value: xml.slice(index, close) });
    index = close + 1;
  }
}

interface Frame {
  readonly qname: XmlName;
  /** Prefix → namespace, as declared at or above this element. */
  readonly namespaces: Readonly<Record<string, string>>;
  /** Where this element's content starts, for `raw`. */
  readonly contentStart: number;
  text: string;
  /** The element's own accumulated data, for the props builder. */
  readonly node: XmlNode;
}

export interface XmlNode {
  readonly qname: XmlName;
  readonly attributes: Readonly<Record<string, string>>;
  text: string;
  /** The untrimmed character data, kept only while the element stays a leaf. */
  raw: string;
  readonly children: XmlNode[];
}

function resolve(
  raw: string,
  namespaces: Readonly<Record<string, string>>,
  keepUndeclared = false,
): XmlName | { readonly undeclared: string } {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    // No prefix: the default namespace, which may legitimately be none.
    return { namespace: namespaces[''] ?? '', localName: raw };
  }
  const prefix = raw.slice(0, colon);
  const namespace = namespaces[prefix];
  // A prefix nobody declared is read as a namespace of its own name where the
  // caller asked for that (see `ReadXmlOptions`), and refused otherwise.
  if (namespace === undefined) return keepUndeclared ? { namespace: `${prefix}:`, localName: raw.slice(colon + 1) } : { undeclared: prefix };
  return { namespace, localName: raw.slice(colon + 1) };
}

/**
 * Parse a document into a tree of elements, or refuse it.
 *
 * One pass, no backtracking, and every refusal is a value. Comments and
 * processing instructions are skipped; CDATA is taken literally, which is what
 * it means; a `DOCTYPE` never reaches here because the caller refuses one
 * first.
 */
export function readXml(
  xml: string,
  options: ReadXmlOptions,
): { readonly ok: true; readonly root: XmlNode } | XmlFailure {
  const stack: Frame[] = [];
  let root: XmlNode | undefined;
  let index = 0;

  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt === -1) break;

    if (stack.length > 0) {
      const decoded = decodeText(xml.slice(index, lt));
      if (!decoded.ok) {
        return fail(
          'entity-refused',
          `The document uses the entity ${decoded.name}, and this reader resolves only the five ` +
            `XML built-ins. Nothing is expanded and nothing is fetched.`,
        );
      }
      stack[stack.length - 1]!.text += decoded.text;
    }

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      if (close === -1) return fail('malformed', 'A comment is never closed.');
      index = close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      if (close === -1) return fail('malformed', 'A CDATA section is never closed.');
      if (stack.length > 0) stack[stack.length - 1]!.text += xml.slice(lt + 9, close);
      index = close + 3;
      continue;
    }
    /*
     * Any other `<!` is a declaration — `DOCTYPE`, `ENTITY`, `ELEMENT` — and
     * this reader has no machinery for one, so it refuses rather than skips.
     * Only here, where it is markup: inside a CDATA section or a comment it is
     * text, which is where real feeds carry it (NASA's articles are whole HTML
     * pages, `DOCTYPE` and all, inside `content:encoded`).
     */
    if (xml.startsWith('<!', lt)) {
      return fail(
        'doctype-refused',
        'The document declares a DOCTYPE. This reader refuses one outright rather than parsing it ' +
          'and declining to expand it, so that it has no entity machinery to get wrong.',
      );
    }
    if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt + 2);
      if (close === -1) return fail('malformed', 'A processing instruction is never closed.');
      index = close + 2;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      const close = xml.indexOf('>', lt);
      if (close === -1) return fail('malformed', 'A closing tag is never closed.');
      const name = xml.slice(lt + 2, close).trim();
      const frame = stack.pop();
      if (frame === undefined) return fail('malformed', `Closing tag <\/${name}> closes nothing.`);
      const expected = resolve(name, frame.namespaces, options.undeclaredPrefixes === 'keep');
      if ('undeclared' in expected) {
        return fail('undeclared-prefix', `The prefix "${expected.undeclared}:" is never declared.`);
      }
      if (
        expected.namespace !== frame.qname.namespace ||
        expected.localName !== frame.qname.localName
      ) {
        return fail(
          'malformed',
          `Closing tag <\/${name}> does not match the open element {${frame.qname.namespace}}` +
            `${frame.qname.localName}.`,
        );
      }
      frame.node.text = frame.text;
      frame.node.raw = xml.slice(frame.contentStart, lt);
      index = close + 1;
      continue;
    }

    const tag = readStartTag(xml, lt);
    if (tag === undefined) {
      /*
       * Two different faults reach here and they want different remedies, so
       * they are told apart by whether the tag is ever closed. A document that
       * simply stops inside `<d:sta` is a truncated download; one with a `>` a
       * few characters along is a tag this reader could not read, which is a
       * dialect question. `diagnose-source` prints whichever sentence it gets.
       */
      return xml.indexOf('>', lt) === -1
        ? fail('malformed', 'The document ends inside a tag — it is truncated.')
        : fail('malformed', 'A start tag could not be read.');
    }

    const inherited = stack.length > 0 ? stack[stack.length - 1]!.namespaces : {};
    let namespaces = inherited;
    for (const attribute of tag.attributes) {
      if (attribute.name === 'xmlns') {
        namespaces = { ...namespaces, '': attribute.value };
      } else if (attribute.name.startsWith('xmlns:')) {
        namespaces = { ...namespaces, [attribute.name.slice(6)]: attribute.value };
      }
    }

    const qname = resolve(tag.name, namespaces, options.undeclaredPrefixes === 'keep');
    if ('undeclared' in qname) {
      return fail('undeclared-prefix', `The prefix "${qname.undeclared}:" is never declared.`);
    }

    const attributes: Record<string, string> = {};
    for (const attribute of tag.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
      const decoded = decodeText(attribute.value);
      if (!decoded.ok) {
        return fail(
          'entity-refused',
          `An attribute uses the entity ${decoded.name}, and this reader resolves only the five ` +
            `XML built-ins.`,
        );
      }
      attributes[attribute.name] = decoded.text;
    }

    const node: XmlNode = { qname, attributes, text: '', raw: '', children: [] };
    if (stack.length === 0) {
      if (root !== undefined) {
        return fail('malformed', 'The document has more than one root element.');
      }
      root = node;
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }

    if (!tag.selfClosing) {
      if (stack.length + 1 > options.maxDepth) {
        return fail('too-deep', `The document nests more than ${options.maxDepth} elements deep.`);
      }
      stack.push({ qname, namespaces, contentStart: tag.end, text: '', node });
    }
    index = tag.end;
  }

  if (stack.length > 0) {
    // What a truncated download looks like. Named rather than reported as a
    // generic parse failure, because "the response stopped mid-document" and
    // "this server speaks a dialect we do not read" want different remedies.
    return fail(
      'malformed',
      `The document ends inside <${stack[stack.length - 1]!.qname.localName}> — it is truncated.`,
    );
  }
  if (root === undefined) return fail('malformed', 'The document has no elements in it.');
  return { ok: true, root };
}

