import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FETCH_LIMITS, type UrlPolicy } from '@maverick-wall/core';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * The four verbs, against a real socket (RFC 013 §6.3).
 *
 * `fetcher.test.ts` next door proves the guard; this file proves the widening —
 * that a `PROPFIND` arrives *as* a `PROPFIND` with its body and its `Depth`,
 * and that `REDIRECT_POLICY` decides what happens to a 3xx rather than a flag
 * somebody passed.
 *
 * Everything is asserted on **what the server received**, for the reason
 * `redirect-credentials.test.ts` states one file along: an outcome alone cannot
 * tell "the body was sent" from "the server made one up", and it cannot tell
 * "the header was stripped" from "the second server rejected one it did get".
 * So each server records its own requests and the assertions read those.
 */

const LOOPBACK: UrlPolicy = { allowLoopback: true, allowHttp: true };
const fetcher = createFetcher();

const MULTISTATUS =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href></d:response></d:multistatus>\n';

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>\n';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;
  readonly depth: string | undefined;
  readonly authorization: string | undefined;
}

let first: Server;
let second: Server;
let firstBase = '';
let secondBase = '';
const atFirst: Seen[] = [];
const atSecond: Seen[] = [];

function record(into: Seen[], req: IncomingMessage, done: (seen: Seen) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const seen: Seen = {
      method: req.method ?? '',
      path: (req.url ?? '').split('?')[0] ?? '',
      body: Buffer.concat(chunks).toString('utf8'),
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      depth: req.headers['depth'] as string | undefined,
      authorization: req.headers.authorization,
    };
    into.push(seen);
    done(seen);
  });
}

function multistatus(res: ServerResponse): void {
  res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
  res.end(MULTISTATUS);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

beforeAll(async () => {
  second = createServer((req, res) => {
    record(atSecond, req, () => multistatus(res));
  });
  secondBase = await listen(second);

  first = createServer((req, res) => {
    record(atFirst, req, (seen) => {
      if (seen.path === '/away') {
        // A different port is a different origin, exactly as a protocol change
        // on one hostname is.
        res.writeHead(302, { location: `${secondBase}/dav/` });
        res.end();
        return;
      }
      if (seen.path === '/here') {
        res.writeHead(302, { location: `${firstBase}/dav/` });
        res.end();
        return;
      }
      multistatus(res);
    });
  });
  firstBase = await listen(first);
});

afterAll(() => {
  first.close();
  second.close();
});

const CREDENTIAL = `Basic ${Buffer.from('jane:app-pw-1', 'utf8').toString('base64')}`;

function clear(): void {
  atFirst.length = 0;
  atSecond.length = 0;
}

describe('a method other than GET', () => {
  it('arrives as itself, with its body and its own headers', async () => {
    for (const method of ['POST', 'PROPFIND', 'REPORT'] as const) {
      clear();
      const result = await fetcher.fetch({
        url: `${firstBase}/dav/`,
        policy: LOOPBACK,
        method,
        body: PROPFIND_BODY,
        maxBytes: FETCH_LIMITS.dav,
        headers: { depth: '1' },
      });

      expect(result.status).toBe('ok');
      const seen = atFirst[0];
      // The verb itself. A widening that quietly sent a GET would still parse
      // the fixture the server answers with, which is why this is read off the
      // request rather than off the outcome.
      expect(seen?.method).toBe(method);
      expect(seen?.body).toBe(PROPFIND_BODY);
      // Stated rather than left to a default: XML's own default when a document
      // has no declaration is UTF-8 and HTTP's for `text/*` historically was
      // not, and a household whose calendar is named in anything but ASCII
      // should not depend on which of those a server believes.
      expect(seen?.contentType).toBe('application/xml; charset=utf-8');
      expect(seen?.contentLength).toBe(String(Buffer.byteLength(PROPFIND_BODY, 'utf8')));
      // A caller's own header still reaches the wire. `Depth` is how a PROPFIND
      // says whether it wants one collection or its children, so a widening
      // that dropped it would answer the wrong question with no error at all.
      expect(seen?.depth).toBe('1');
    }
  });

  it('does not let a caller relabel the body', async () => {
    /*
     * `content-type` is applied last and is not overridable, the same rule
     * `postJson` states one function down. A content type that disagrees with
     * the bytes is how a server is talked into parsing something as the wrong
     * thing, and there is no call site in this repository that wants to.
     */
    clear();
    await fetcher.fetch({
      url: `${firstBase}/dav/`,
      policy: LOOPBACK,
      method: 'REPORT',
      body: PROPFIND_BODY,
      maxBytes: FETCH_LIMITS.dav,
      headers: { 'content-type': 'text/html' },
    });
    expect(atFirst[0]?.contentType).toBe('application/xml; charset=utf-8');
  });
});

describe('the redirect policy, per method', () => {
  it('refuses a redirected POST', async () => {
    clear();
    const result = await fetcher.fetch({
      url: `${firstBase}/away`,
      policy: LOOPBACK,
      method: 'POST',
      body: PROPFIND_BODY,
      maxBytes: FETCH_LIMITS.dav,
      headers: { authorization: CREDENTIAL },
    });

    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && result.code).toBe('redirect-rejected');
    // The assertion that matters: the second origin never heard from us at all.
    // A POST replayed at an address a server chose is the credential-disclosure
    // primitive `REDIRECT_POLICY` exists to remove, and "the outcome was a
    // rejection" would also pass if the request had gone and then been refused.
    expect(atSecond).toEqual([]);
  });

  it('refuses a redirected REPORT for the same reason', async () => {
    clear();
    const result = await fetcher.fetch({
      url: `${firstBase}/away`,
      policy: LOOPBACK,
      method: 'REPORT',
      body: PROPFIND_BODY,
      maxBytes: FETCH_LIMITS.dav,
      headers: { authorization: CREDENTIAL },
    });

    expect(result.status === 'rejected' && result.code).toBe('redirect-rejected');
    expect(atSecond).toEqual([]);
  });

  it('follows a redirected PROPFIND and drops the credential across the origin', async () => {
    clear();
    const result = await fetcher.fetch({
      url: `${firstBase}/away`,
      policy: LOOPBACK,
      method: 'PROPFIND',
      body: PROPFIND_BODY,
      maxBytes: FETCH_LIMITS.dav,
      headers: { authorization: CREDENTIAL, depth: '0' },
    });

    expect(result.status).toBe('ok');
    expect(atFirst.map((seen) => seen.authorization)).toEqual([CREDENTIAL]);
    expect(atSecond.map((seen) => seen.path)).toEqual(['/dav/']);
    // Following is not trusting: the hop is revalidated and `authorization` is
    // dropped exactly as it is for a GET.
    expect(atSecond[0]?.authorization).toBeUndefined();
    // And the body survives the hop, which is the half a stripped-header test
    // would not notice — a second request with no body is a PROPFIND that means
    // `allprop` and answers something else entirely.
    expect(atSecond[0]?.method).toBe('PROPFIND');
    expect(atSecond[0]?.body).toBe(PROPFIND_BODY);
    expect(atSecond[0]?.depth).toBe('0');
  });

  it('keeps the credential across a same-origin redirect', async () => {
    clear();
    const result = await fetcher.fetch({
      url: `${firstBase}/here`,
      policy: LOOPBACK,
      method: 'PROPFIND',
      body: PROPFIND_BODY,
      maxBytes: FETCH_LIMITS.dav,
      headers: { authorization: CREDENTIAL },
    });

    expect(result.status).toBe('ok');
    expect(atFirst.map((seen) => seen.path)).toEqual(['/here', '/dav/']);
    // Both hops signed in. This is the hop RFC 6764 §6 specifies and the reason
    // PROPFIND follows at all: a CalDAV client that refuses it cannot reach
    // iCloud or a Nextcloud whose well-known points at its context path.
    expect(atFirst.map((seen) => seen.authorization)).toEqual([CREDENTIAL, CREDENTIAL]);
    expect(atSecond).toEqual([]);
  });

  it('still follows a plain GET, which is what every existing call site is', async () => {
    clear();
    const result = await fetcher.fetch({
      url: `${firstBase}/here`,
      policy: LOOPBACK,
      maxBytes: FETCH_LIMITS.dav,
    });
    expect(result.status).toBe('ok');
    expect(atFirst.map((seen) => seen.method)).toEqual(['GET', 'GET']);
    // No method, no body: byte-for-byte the request this file's subject did not
    // change. A widening that made an omitted method mean anything else would
    // move every feed in the product.
    expect(atFirst[0]?.contentType).toBeUndefined();
    expect(atFirst[0]?.body).toBe('');
  });
});
