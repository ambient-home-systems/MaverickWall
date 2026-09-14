/**
 * A reader for WebDAV `multistatus` documents, hand-rolled, and narrow on
 * purpose (RFC 013 §6.8).
 *
 * This project's own rule points both ways — *draw what nobody else supplies,
 * and use somebody else's work for what is already solved* — and XML parsing is
 * solved, so it is worth saying which side this lands on and why.
 *
 * The narrow argument: what is needed is not "parse XML", it is "read a handful
 * of known element paths out of a `D:multistatus`". That is the gap `qr.ts`,
 * `png.ts` and `font.ts` already sit in.
 *
 * The one that decides it: **XXE is the canonical WebDAV vulnerability**, and a
 * general parser has to be *configured* not to be vulnerable to it. A reader
 * with no concept of entities and a flat refusal of `DOCTYPE` cannot have XXE
 * at all. That inverts the usual instinct about hand-rolling a parser — here
 * the narrow thing is the safer thing, because the dangerous feature is one it
 * does not implement rather than one it disables. A reader that tolerated
 * `DOCTYPE` while declining to expand it would have the feature and a
 * mitigation, which is the thing somebody configures wrong two years later.
 *
 * So, in order of how much each is load-bearing:
 *
 * - **`DOCTYPE` is refused at the document**, before any parsing, on any
 *   occurrence anywhere in the bytes. Not "refused when it declares an entity",
 *   not "parsed and ignored".
 * - **There is no entity expansion of any kind.** The five XML built-ins
 *   (`&lt; &gt; &amp; &quot; &apos;`) and numeric character references are
 *   resolved because they are not entities in the dangerous sense — they expand
 *   to exactly one character and cannot name anything. Every other `&name;` is
 *   a refusal rather than a passthrough: a reader that hands `&xxe;` back as
 *   text has read a document it did not understand.
 * - **Prefixes come from the declarations.** `d:`, `D:`, `DAV:` and the default
 *   namespace all occur in the wild, and a reader that assumes one works
 *   against Nextcloud and fails against Apple. Props are keyed by (namespace,
 *   local name), which is the only identity that survives a server changing its
 *   mind about prefixes.
 * - **A depth cap**, above which the document is refused. The byte ceiling
 *   above *that* is the Fetcher's (`FETCH_LIMITS.dav`), which is enforced while
 *   streaming and is the thing standing between a hostile server and an
 *   unbounded read; this file re-states it rather than trusting a caller to
 *   have used the right one.
 *
 * Pure, no I/O, and in `apps/server` rather than in a package: rule one keeps
 * it out of the pure packages and there is nothing here `packages/calendar`
 * wants.
 *
 * **Verify it by parsing, never by reading.** That is `qr.ts`'s rule one file
 * along — its format bits satisfied every check a person can reason about and
 * produced a code no scanner would read. The tests here feed it whole documents
 * and read back what came out.
 */

/** A property value, keyed by namespace and local name. */
export interface DavProp {
  readonly namespace: string;
  readonly localName: string;
  /**
   * The element's text with descendant markup removed, trimmed.
   *
   * Empty for a structural property such as `resourcetype`, whose meaning is
   * in its children rather than in its text — read those from `children`.
   */
  readonly text: string;
  /**
   * Immediate element children, with their attributes.
   *
   * `resourcetype` is the reason this exists: a calendar collection is
   * identified by `<C:calendar/>` *inside* it, which has no text at all, and a
   * reader that only carried text could not tell a calendar from an address
   * book. `supported-calendar-component-set` is the reason the attributes come
   * with them — its answer is `<C:comp name="VEVENT"/>`, where the whole value
   * is an attribute.
   */
  readonly children: readonly DavElement[];
  /**
   * This element's character data, **and only for an element that has no
   * element children**.
   *
   * `CALDAV:calendar-data` is what it is for: it carries an entire `VCALENDAR`,
   * which `packages/calendar` reads, and which must arrive byte for byte —
   * CRLF, folding and all — because ICS folding lands on exact octet
   * boundaries. So this is `text` without the trim.
   *
   * Absent on an element with children, deliberately. Inner *markup* is written
   * in whatever prefixes the server chose, so a caller reading it would be a
   * caller that works against `d:` and fails against `D:` — which is the exact
   * fault this reader exists to remove, reintroduced one field along. Anything
   * structural is in `children`.
   */
  readonly raw?: string;
}

export interface QName {
  readonly namespace: string;
  readonly localName: string;
}

export interface DavElement extends QName {
  /**
   * Attributes, by their literal name — `name`, not `{}name`.
   *
   * An unprefixed attribute is in **no** namespace (XML names, §6.2: the
   * default namespace does not apply to attributes), and every attribute this
   * reader meets is unprefixed, so a Clark key here would be a decoration that
   * implied a rule the spec does not have.
   */
  readonly attributes: Readonly<Record<string, string>>;
}

export interface DavResponse {
  /** The `D:href` of the resource, exactly as the server wrote it. */
  readonly href: string;
  /**
   * The status of the `propstat` each prop came from, as written — `HTTP/1.1
   * 200 OK`. Absent when the response carried a bare `D:status` instead.
   *
   * Kept as the server's own words rather than as a number because the
   * interesting case is not the number: a `propstat` saying `404` for
   * `getctag` on a server that does not implement it is a normal answer, and
   * the caller decides what to do about it.
   */
  readonly status?: string;
  /**
   * Every property that came back **200**, keyed `{namespace}localName` — the
   * Clark notation `{DAV:}displayname`, because a key has to be one string and
   * that is the spelling everybody who has met XML namespaces already knows.
   *
   * A property a server answered 404 or 403 for is *absent* rather than
   * present-and-empty. Those are two different facts: "this collection has no
   * CTag" and "this collection's CTag is the empty string" would otherwise read
   * the same, and one of them means a sync that never detects a change.
   */
  readonly props: Readonly<Record<string, DavProp>>;
}

export type MultistatusErrorCode =
  /** A `DOCTYPE` anywhere in the bytes. Refused before any parsing. */
  | 'doctype-refused'
  /** An entity reference that is not one of the five built-ins or a numeric one. */
  | 'entity-refused'
  /** Nesting past `MAX_DEPTH`. */
  | 'too-deep'
  /** Longer than the byte ceiling. */
  | 'too-large'
  /** Not well-formed: an unclosed element, a mismatched tag, a truncated file. */
  | 'malformed'
  /** Well-formed XML that is not a `DAV:multistatus`. */
  | 'not-multistatus'
  /** A prefix used but never declared. */
  | 'undeclared-prefix';

export interface MultistatusError {
  readonly code: MultistatusErrorCode;
  /** Written for a log and for `diagnose-source`, never for a wall. */
  readonly message: string;
}

export type MultistatusResult =
  | { readonly ok: true; readonly responses: readonly DavResponse[] }
  | { readonly ok: false; readonly error: MultistatusError };

export const DAV_NS = 'DAV:';
export const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
export const CALENDARSERVER_NS = 'http://calendarserver.org/ns/';
export const APPLE_NS = 'http://apple.com/ns/ical/';

/**
 * How deep a document may nest before it is refused.
 *
 * A real multistatus is six deep at its worst — multistatus, response,
 * propstat, prop, resourcetype, calendar — so 20 is generous by a factor of
 * three and still nowhere near a stack this parser could be walked off. It is a
 * cap on *nesting* and deliberately not on element count, which the byte
 * ceiling already bounds.
 */
export const MAX_DEPTH = 20;

/** The Fetcher's `FETCH_LIMITS.dav`, restated rather than trusted to a caller. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** Clark notation: the key a prop is stored under. */
export function clark(namespace: string, localName: string): string {
  return `{${namespace}}${localName}`;
}

type Failure = { readonly ok: false; readonly error: MultistatusError };

function fail(code: MultistatusErrorCode, message: string): Failure {
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
  readonly qname: QName;
  /** Prefix → namespace, as declared at or above this element. */
  readonly namespaces: Readonly<Record<string, string>>;
  /** Where this element's content starts, for `raw`. */
  readonly contentStart: number;
  text: string;
  /** The element's own accumulated data, for the props builder. */
  readonly node: ElementNode;
}

interface ElementNode {
  readonly qname: QName;
  readonly attributes: Readonly<Record<string, string>>;
  text: string;
  /** The untrimmed character data, kept only while the element stays a leaf. */
  raw: string;
  readonly children: ElementNode[];
}

function resolve(
  raw: string,
  namespaces: Readonly<Record<string, string>>,
): QName | { readonly undeclared: string } {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    // No prefix: the default namespace, which may legitimately be none.
    return { namespace: namespaces[''] ?? '', localName: raw };
  }
  const prefix = raw.slice(0, colon);
  const namespace = namespaces[prefix];
  if (namespace === undefined) return { undeclared: prefix };
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
function parseDocument(xml: string): { readonly ok: true; readonly root: ElementNode } | Failure {
  const stack: Frame[] = [];
  let root: ElementNode | undefined;
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
      const expected = resolve(name, frame.namespaces);
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

    const qname = resolve(tag.name, namespaces);
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

    const node: ElementNode = { qname, attributes, text: '', raw: '', children: [] };
    if (stack.length === 0) {
      if (root !== undefined) {
        return fail('malformed', 'The document has more than one root element.');
      }
      root = node;
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }

    if (!tag.selfClosing) {
      if (stack.length + 1 > MAX_DEPTH) {
        return fail('too-deep', `The document nests more than ${MAX_DEPTH} elements deep.`);
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

function isDav(node: ElementNode, localName: string): boolean {
  return node.qname.namespace === DAV_NS && node.qname.localName === localName;
}

/** A `propstat` status is a 200 when its reason line says so. */
function isOkStatus(status: string): boolean {
  return / 2\d\d\b/.test(status);
}

/**
 * Read a `multistatus` document.
 *
 * Never throws. `DOCTYPE` is checked against the **raw bytes** before anything
 * is parsed, which is the one ordering decision in this file that is load
 * bearing: a check that ran after a tokeniser had already walked the prologue
 * would be a check on a document the tokeniser had already read.
 */
export function readMultistatus(xml: string): MultistatusResult {
  if (typeof xml !== 'string') return fail('malformed', 'The response was not text.');

  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength > MAX_DOCUMENT_BYTES) {
    return fail(
      'too-large',
      `The response is ${Math.round(byteLength / 1024)} KB, past the ` +
        `${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB this reader will accept.`,
    );
  }

  /*
   * Refused on any occurrence, case-insensitively, anywhere in the bytes —
   * including inside a comment or a CDATA section, where it would be inert.
   *
   * That over-refuses by construction and it is the right trade. The claim
   * §6.8 makes is that the feature is *absent*, and the moment this reader
   * starts deciding which `DOCTYPE`s are inert it has a parser for them, an
   * opinion about which ones matter, and somewhere for the next person to get
   * it wrong. No real server puts the string in a multistatus.
   */
  const doctype = /<!DOCTYPE/i.exec(xml);
  if (doctype !== null) {
    return fail(
      'doctype-refused',
      'The response carries a DOCTYPE. This reader refuses one outright rather than parsing it ' +
        'and declining to expand it, so that it has no entity machinery to get wrong.',
    );
  }

  const parsed = parseDocument(xml);
  if (!parsed.ok) return parsed;
  const root = parsed.root;

  if (!isDav(root, 'multistatus')) {
    return fail(
      'not-multistatus',
      `Expected a DAV:multistatus and the document's root is {${root.qname.namespace}}` +
        `${root.qname.localName}. That is what a server which is not a CalDAV server answers.`,
    );
  }

  const responses: DavResponse[] = [];
  for (const child of root.children) {
    if (!isDav(child, 'response')) continue;

    let href: string | undefined;
    let bareStatus: string | undefined;
    const props: Record<string, DavProp> = {};

    for (const part of child.children) {
      if (isDav(part, 'href') && href === undefined) {
        href = part.text.trim();
        continue;
      }
      if (isDav(part, 'status')) {
        bareStatus = part.text.trim();
        continue;
      }
      if (!isDav(part, 'propstat')) continue;

      const status = part.children.find((node) => isDav(node, 'status'))?.text.trim() ?? '';
      // A property that came back 404 or 403 is *absent* rather than
      // present-and-empty: "this collection has no CTag" and "its CTag is the
      // empty string" are different facts and one of them is a sync that never
      // notices a change.
      if (!isOkStatus(status)) continue;

      for (const prop of part.children.filter((node) => isDav(node, 'prop'))) {
        for (const value of prop.children) {
          props[clark(value.qname.namespace, value.qname.localName)] = {
            namespace: value.qname.namespace,
            localName: value.qname.localName,
            text: value.text.trim(),
            children: value.children.map((node) => ({
              namespace: node.qname.namespace,
              localName: node.qname.localName,
              attributes: node.attributes,
            })),
            // Only a leaf. See the field: inner markup carries the server's own
            // prefixes, and a caller reading it is a caller that works against
            // one server and fails against the next.
            ...(value.children.length === 0 ? { raw: value.raw } : {}),
          };
        }
      }
    }

    if (href === undefined) continue;
    responses.push({
      href,
      ...(bareStatus !== undefined && bareStatus !== '' ? { status: bareStatus } : {}),
      props,
    });
  }

  return { ok: true, responses };
}

/** Read one prop off a response, by namespace and local name. */
export function prop(
  response: DavResponse,
  namespace: string,
  localName: string,
): DavProp | undefined {
  return response.props[clark(namespace, localName)];
}

/** True when a `resourcetype` names `{urn:ietf:params:xml:ns:caldav}calendar`. */
export function isCalendarCollection(response: DavResponse): boolean {
  const resourceType = prop(response, DAV_NS, 'resourcetype');
  if (resourceType === undefined) return false;
  return resourceType.children.some(
    (child) => child.namespace === CALDAV_NS && child.localName === 'calendar',
  );
}
