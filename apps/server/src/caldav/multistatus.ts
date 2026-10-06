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

import { readXml, type XmlName, type XmlNode } from '../xml/read.js';

/** A property value, keyed by namespace and local name. */
export interface DavProp {
  readonly namespace: string;
  readonly localName: string;
  /**
   * This element's **own** character data, trimmed — not its descendants'.
   *
   * Empty for a structural property such as `resourcetype` or
   * `current-user-principal`, whose meaning is in a child. That is the honest
   * reading rather than a convenience: `<current-user-principal><href>/p/</href>
   * </current-user-principal>` has a text value of nothing and an href of
   * `/p/`, and flattening the two would make a prop with two hrefs in it read
   * as one string nobody can split again. Read a child's own text off
   * `children`.
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

/** A namespace and a local name: the only identity a prefix-choosing server cannot change. */
export type QName = XmlName;

export interface DavElement extends QName {
  /**
   * This child's own character data, trimmed.
   *
   * `current-user-principal` and `calendar-home-set` are why: each is one
   * `D:href` inside a wrapper, and the href is the whole answer.
   */
  readonly text: string;
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

function fail(code: MultistatusErrorCode, message: string): { readonly ok: false; readonly error: MultistatusError } {
  return { ok: false, error: { code, message } };
}

function isDav(node: XmlNode, localName: string): boolean {
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

  const parsed = readXml(xml, { maxDepth: MAX_DEPTH });
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
              text: node.text.trim(),
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

/**
 * The text of the first `DAV:href` inside a property.
 *
 * `current-user-principal` and `calendar-home-set` have exactly this shape, and
 * it is here rather than in `discover.ts` so both read it one way. A property
 * with no href inside answers `undefined`, which every caller treats as "that
 * server did not tell us" rather than as an empty address.
 */
export function hrefIn(
  response: DavResponse,
  namespace: string,
  localName: string,
): string | undefined {
  const value = prop(response, namespace, localName);
  const href = value?.children.find(
    (child) => child.namespace === DAV_NS && child.localName === 'href',
  );
  return href === undefined || href.text === '' ? undefined : href.text;
}

/** True when a `resourcetype` names `{urn:ietf:params:xml:ns:caldav}calendar`. */
export function isCalendarCollection(response: DavResponse): boolean {
  const resourceType = prop(response, DAV_NS, 'resourcetype');
  if (resourceType === undefined) return false;
  return resourceType.children.some(
    (child) => child.namespace === CALDAV_NS && child.localName === 'calendar',
  );
}
