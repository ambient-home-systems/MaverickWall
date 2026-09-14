import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CALDAV_NS,
  CALENDARSERVER_NS,
  DAV_NS,
  hrefIn,
  MAX_DEPTH,
  MAX_DOCUMENT_BYTES,
  clark,
  isCalendarCollection,
  prop,
  readMultistatus,
  type DavResponse,
} from '../src/caldav/multistatus.js';

/**
 * The reader is the security boundary, so it is checked the way `qr.ts` is
 * checked: by feeding it whole documents and reading back what came out, never
 * by reading the source and agreeing with it.
 *
 * RFC 013 §11 asks for four things by name and each has a case below: a DOCTYPE
 * with an external entity refused **at the document**, a billion-laughs body
 * refused at the document rather than expanded and ignored, the same response
 * under `d:`/`D:`/`DAV:`/default reading identically, and a truncated document
 * failing without throwing.
 */

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/caldav/synthetic/${name}`, import.meta.url)),
    'utf8',
  );
}

function ok(xml: string): readonly DavResponse[] {
  const result = readMultistatus(xml);
  if (!result.ok) throw new Error(`expected a readable document, got ${result.error.code}`);
  return result.responses;
}

describe('entities, which is the whole reason this is hand-rolled', () => {
  it('refuses a DOCTYPE declaring an external entity, at the document', () => {
    const result = readMultistatus(fixture('hostile-xxe-external-entity.xml'));

    expect(result.ok).toBe(false);
    // At the *document*: not "one property came back odd", not "the entity was
    // left unexpanded". §6.8's claim is that the feature is absent, and a reader
    // that parses a DOCTYPE while declining to expand it has the feature and a
    // mitigation — which is the thing somebody configures wrong later.
    expect(!result.ok && result.error.code).toBe('doctype-refused');
  });

  it('refuses a billion-laughs body without expanding any of it', () => {
    const xml = fixture('hostile-billion-laughs.xml');
    const before = process.memoryUsage().heapUsed;
    const result = readMultistatus(xml);

    expect(!result.ok && result.error.code).toBe('doctype-refused');
    /*
     * The expansion this refuses is ~10^9 characters, so a reader that expanded
     * it would not return at all — which is exactly why the assertion cannot be
     * only on the outcome. A few hundred kilobytes of headroom says nothing was
     * built; a reader that had expanded one level would already be past it.
     */
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(10 * 1024 * 1024);
  });

  it('refuses an entity reference that has no DOCTYPE above it', () => {
    /*
     * The half a DOCTYPE check alone cannot see. A reader that refuses the
     * declaration and then hands `&xxe;` back as literal text has read a
     * document it did not understand and reported success — and a household's
     * calendar name is not where that gets noticed.
     */
    const result = readMultistatus(fixture('hostile-entity-no-doctype.xml'));
    expect(!result.ok && result.error.code).toBe('entity-refused');
    expect(!result.ok && result.error.message).toContain('&xxe;');
  });

  it('refuses a DOCTYPE even where it is inert', () => {
    // Inside a comment it can do nothing. Refused anyway: the moment this reader
    // starts deciding which DOCTYPEs matter it has a parser for them and an
    // opinion, and no real server puts the string in a multistatus.
    const result = readMultistatus(fixture('hostile-doctype-in-comment.xml'));
    expect(!result.ok && result.error.code).toBe('doctype-refused');
  });

  it('resolves the five built-ins and character references, and nothing else', () => {
    const responses = ok(
      `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/c/</d:href><d:propstat>` +
        `<d:prop><d:displayname>Ben &amp; Jo&apos;s &lt;list&gt; &#82;&#x75;n</d:displayname></d:prop>` +
        `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    );
    expect(prop(responses[0]!, DAV_NS, 'displayname')?.text).toBe("Ben & Jo's <list> Run");
  });

  it('refuses a character reference outside the range of a character', () => {
    for (const reference of ['&#x110000;', '&#55296;', '&#xZZ;', '&#;']) {
      const result = readMultistatus(
        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${reference}</d:href></d:response></d:multistatus>`,
      );
      expect(!result.ok && result.error.code).toBe('entity-refused');
    }
  });
});

describe('prefixes come from the declarations', () => {
  it('reads the same response identically under d:, D:, DAV: and no prefix', () => {
    /*
     * §6.8 names this as the commonest way a hand-rolled reader goes wrong: it
     * works against Nextcloud's output and fails against Apple's. All four
     * spellings occur in the wild and all four are one document as far as XML is
     * concerned, so the assertion is *equality of the parsed result* rather than
     * four separate readings that each happen to look right.
     */
    const parsed = [
      'prefix-lowercase-d.xml',
      'prefix-uppercase-d.xml',
      'prefix-literal-dav.xml',
      'prefix-default-namespace.xml',
    ].map((name) => ok(fixture(name)));

    for (const responses of parsed) {
      expect(responses).toEqual(parsed[0]);
    }

    const one = parsed[0]![0]!;
    expect(one.href).toBe('/dav/calendars/REDACTED/personal/');
    expect(prop(one, DAV_NS, 'displayname')?.text).toBe('Home');
    expect(prop(one, CALENDARSERVER_NS, 'getctag')?.text).toBe('ctag-1');
    expect(isCalendarCollection(one)).toBe(true);
    // Keyed by namespace and local name, which is the only identity that
    // survives a server changing its mind about prefixes.
    expect(Object.keys(one.props).sort()).toEqual([
      clark(CALDAV_NS, 'supported-calendar-component-set'),
      clark(DAV_NS, 'displayname'),
      clark(DAV_NS, 'resourcetype'),
      clark(CALENDARSERVER_NS, 'getctag'),
    ].sort());
  });

  it('refuses a prefix that was never declared', () => {
    const result = readMultistatus(
      '<d:multistatus xmlns:d="DAV:"><d:response><x:href>/c/</x:href></d:response></d:multistatus>',
    );
    // Rather than silently reading it as if it were DAV:. A prefix nobody
    // declared is a document we cannot resolve, and guessing is how a reader
    // reports somebody else's namespace as ours.
    expect(!result.ok && result.error.code).toBe('undeclared-prefix');
  });

  it('does not confuse a local name with a prefix that happens to match', () => {
    // `cal:calendar` and `d:calendar` are different properties. A reader keyed
    // on the local name alone would answer the same for both.
    const responses = ok(
      `<m:multistatus xmlns:m="DAV:" xmlns:z="urn:example:other">` +
        `<m:response><m:href>/c/</m:href><m:propstat><m:prop>` +
        `<m:resourcetype><z:calendar/></m:resourcetype>` +
        `</m:prop><m:status>HTTP/1.1 200 OK</m:status></m:propstat></m:response></m:multistatus>`,
    );
    expect(isCalendarCollection(responses[0]!)).toBe(false);
  });
});

describe('a document that is not well formed', () => {
  it('fails without throwing on a truncated document', () => {
    const result = readMultistatus(fixture('truncated-mid-document.xml'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('malformed');
    // Named rather than reported generically: "the response stopped
    // mid-document" and "this server speaks a dialect we do not read" want
    // different remedies from whoever reads `diagnose-source`.
    expect(!result.ok && result.error.message).toContain('truncated');
  });

  it('fails without throwing on every shape of damage', () => {
    const damaged: readonly [string, string][] = [
      ['', 'malformed'],
      ['   ', 'malformed'],
      ['not xml at all', 'malformed'],
      ['<d:multistatus xmlns:d="DAV:">', 'malformed'],
      ['<d:multistatus xmlns:d="DAV:"></d:response>', 'malformed'],
      ['<d:a xmlns:d="DAV:"/><d:b xmlns:d="DAV:"/>', 'malformed'],
      ['<d:multistatus xmlns:d="DAV:"><!-- unclosed', 'malformed'],
      ['<d:multistatus xmlns:d="DAV:"><![CDATA[ unclosed', 'malformed'],
      ['<d:multistatus xmlns:d="DAV:" bad=>', 'malformed'],
      ['<html><body>404 Not Found</body></html>', 'not-multistatus'],
    ];
    for (const [xml, code] of damaged) {
      const result = readMultistatus(xml);
      expect(result.ok, xml).toBe(false);
      expect(!result.ok && result.error.code, xml).toBe(code);
    }
  });

  it('says a document is not a multistatus rather than reading nothing out of it', () => {
    // What a server that is not a CalDAV server answers. "Zero calendars" and
    // "that address is not a CalDAV server" are different sentences and §6.7
    // says the distinction is the whole value of the discovery stage.
    const result = readMultistatus('<html><body>Sign in</body></html>');
    expect(!result.ok && result.error.code).toBe('not-multistatus');
  });

  it('refuses nesting past the depth cap', () => {
    const result = readMultistatus(fixture('hostile-deeply-nested.xml'));
    expect(!result.ok && result.error.code).toBe('too-deep');
    expect(!result.ok && result.error.message).toContain(String(MAX_DEPTH));
  });

  it('refuses a document past the byte ceiling', () => {
    const padding = 'x'.repeat(MAX_DOCUMENT_BYTES + 1);
    const result = readMultistatus(
      `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${padding}</d:href></d:response></d:multistatus>`,
    );
    // The ceiling the Fetcher enforces while streaming, restated here rather
    // than trusted to a caller having passed the right one.
    expect(!result.ok && result.error.code).toBe('too-large');
  });

  it('measures that ceiling in bytes, not in characters', () => {
    // A multi-byte name is where a length check and a byte check disagree, and
    // the Fetcher above this counts bytes off a socket.
    const wide = 'é'.repeat(MAX_DOCUMENT_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    const result = readMultistatus(
      `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${wide}</d:href></d:response></d:multistatus>`,
    );
    expect(!result.ok && result.error.code).toBe('too-large');
  });
});

describe('what a home set actually reads as', () => {
  const responses = ok(fixture('nextcloud-home-set.xml'));

  it('finds every response, in order, with its href as written', () => {
    expect(responses.map((response) => response.href)).toEqual([
      '/remote.php/dav/calendars/REDACTED/',
      '/remote.php/dav/calendars/REDACTED/personal/',
      '/remote.php/dav/calendars/REDACTED/school-run/',
      '/remote.php/dav/calendars/REDACTED/tasks/',
      '/remote.php/dav/calendars/REDACTED/contact_birthdays/',
    ]);
  });

  it('tells a calendar collection from a plain one by resourcetype, not by name', () => {
    expect(responses.map(isCalendarCollection)).toEqual([false, true, true, true, true]);
  });

  it('leaves a property the server answered 404 for absent rather than empty', () => {
    /*
     * The two-propstat shape, and the case a reader gets wrong by walking every
     * `prop` regardless of the `status` beside it. "This collection has no CTag"
     * and "its CTag is the empty string" would then read the same, and one of
     * them is a sync that never notices a change.
     */
    const container = responses[0]!;
    expect(prop(container, DAV_NS, 'displayname')?.text).toBe('calendars');
    expect(prop(container, CALENDARSERVER_NS, 'getctag')).toBeUndefined();
    expect(prop(container, CALDAV_NS, 'supported-calendar-component-set')).toBeUndefined();
  });

  it('reads a component set as its children, since its value is not text', () => {
    const personal = responses[1]!;
    const components = prop(personal, CALDAV_NS, 'supported-calendar-component-set');
    expect(components?.text).toBe('');
    // The whole value is an attribute, which is why `children` carries them:
    // a reader that only had the element names could not tell a VEVENT
    // calendar from a VTODO one, and §6.2 filters on exactly that.
    expect(components?.children).toEqual([
      { namespace: CALDAV_NS, localName: 'comp', text: '', attributes: { name: 'VEVENT' } },
      { namespace: CALDAV_NS, localName: 'comp', text: '', attributes: { name: 'VTODO' } },
    ]);
    // And `raw` is absent on an element that has children, deliberately: inner
    // markup is written in whatever prefixes the server chose, so a caller
    // scraping it would work against `d:` and fail against `D:` — this reader's
    // own fault, one field along.
    expect(components?.raw).toBeUndefined();
  });

  it('reads a wrapped href off its child, not off the wrapper', () => {
    /*
     * `current-user-principal` and `calendar-home-set` are each one `D:href`
     * inside a wrapper, and a prop carries its *own* character data rather than
     * its descendants'. Reading the wrapper's text answers the whitespace
     * between the two tags, which is an empty address rather than an error —
     * so discovery would stop saying "that account has no calendar home" on a
     * server that had just named one.
     */
    const responses = ok(
      `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
        `<d:response><d:href>/</d:href><d:propstat><d:prop>` +
        `<d:current-user-principal>\n  <d:href>/dav/principals/REDACTED/</d:href>\n ` +
        `</d:current-user-principal>` +
        `<cal:calendar-home-set><d:href>/dav/calendars/REDACTED/</d:href></cal:calendar-home-set>` +
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    );

    expect(hrefIn(responses[0]!, DAV_NS, 'current-user-principal')).toBe(
      '/dav/principals/REDACTED/',
    );
    expect(hrefIn(responses[0]!, CALDAV_NS, 'calendar-home-set')).toBe('/dav/calendars/REDACTED/');
    // The wrapper's own text is whitespace, which is the thing that must not be
    // mistaken for the answer.
    expect(prop(responses[0]!, DAV_NS, 'current-user-principal')?.text).toBe('');
    // And a wrapper with no href inside says nothing rather than saying "".
    expect(hrefIn(responses[0]!, DAV_NS, 'displayname')).toBeUndefined();
  });

  it('decodes an escaped displayname', () => {
    expect(prop(responses[2]!, DAV_NS, 'displayname')?.text).toBe('School & clubs');
  });

  it('keeps a calendar-data body byte for byte, CRLF included', () => {
    const report = ok(fixture('report-calendar-query.xml'));
    const data = prop(report[0]!, CALDAV_NS, 'calendar-data');
    // `raw` rather than `text`, and unwrapped rather than trimmed: an ICS
    // document's folding lands on exact octet boundaries and `packages/calendar`
    // is what reads it.
    expect(data?.raw?.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(data?.raw?.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(data?.raw).toContain('DTSTART;TZID=America/New_York:20260224T090000\r\n');
  });
});
