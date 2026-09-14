import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { UrlPolicy } from '@maverick-wall/core';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * What the *second* server actually received.
 *
 * `SENSITIVE_HEADERS` drops `authorization` across an origin, and until this
 * file existed that was read out of the source rather than out of a request —
 * RFC 013 §11 names it as the gap: "it needs two origins, not one stub ... so
 * the assertion is on what arrived rather than on what the client believes it
 * sent."
 *
 * Two loopback servers on different ports is enough to be two origins:
 * `isCrossOrigin` treats a port change exactly as it treats a host change, and
 * that is the whole point — a Nextcloud redirecting its own `http://` to
 * `https://` on one hostname is cross-origin by the same test, which is the
 * case a household actually meets and the reason `credentialsDropped` exists.
 */

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const LOOPBACK: UrlPolicy = { allowLoopback: true, allowHttp: true };
const fetcher = createFetcher();

/** Every request each server saw, in order, with the headers it carried. */
interface Seen {
  readonly path: string;
  readonly authorization: string | undefined;
}

let first: Server;
let second: Server;
let firstBase = '';
let secondBase = '';
const atFirst: Seen[] = [];
const atSecond: Seen[] = [];

function record(into: Seen[], req: IncomingMessage): void {
  into.push({
    path: (req.url ?? '').split('?')[0] ?? '',
    authorization: req.headers.authorization,
  });
}

function calendar(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/calendar' });
  res.end(ICS);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

beforeAll(async () => {
  second = createServer((req, res) => {
    record(atSecond, req);
    // Signs in or it does not: the whole question this file asks is which of
    // those the second hop got, so the second server has to be able to tell.
    if (req.headers.authorization === undefined) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="calendars"' });
      res.end('sign in');
      return;
    }
    calendar(res);
  });
  secondBase = await listen(second);

  first = createServer((req, res) => {
    record(atFirst, req);
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/away') {
      // A different port is a different origin, which is what a protocol change
      // on one hostname also is.
      res.writeHead(302, { location: `${secondBase}/cal.ics` });
      res.end();
      return;
    }
    if (path === '/here') {
      // Same scheme, same host, same port: not cross-origin, and the credential
      // has no reason to be taken off.
      res.writeHead(302, { location: `${firstBase}/cal.ics` });
      res.end();
      return;
    }
    if (path === '/cal.ics') {
      if (req.headers.authorization === undefined) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="calendars"' });
        res.end('sign in');
        return;
      }
      calendar(res);
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  firstBase = await listen(first);
});

afterAll(() => {
  first.close();
  second.close();
});

const CREDENTIAL = `Basic ${Buffer.from('jane:app-pw-1', 'utf8').toString('base64')}`;

function get(url: string) {
  return fetcher.fetch({
    url,
    policy: LOOPBACK,
    maxBytes: 64 * 1024,
    acceptContentTypes: ['text/calendar'],
    headers: { authorization: CREDENTIAL },
  });
}

describe('a credential across a redirect', () => {
  it('reaches the first origin and never the second', async () => {
    atFirst.length = 0;
    atSecond.length = 0;
    const result = await get(`${firstBase}/away`);

    // The assertion that matters is on what arrived, not on the outcome: an
    // outcome alone cannot tell "the header was stripped" from "the second
    // server rejected a header it did receive".
    expect(atFirst.map((seen) => seen.authorization)).toEqual([CREDENTIAL]);
    expect(atSecond.map((seen) => seen.path)).toEqual(['/cal.ics']);
    expect(atSecond[0]?.authorization).toBeUndefined();

    // And the outcome says so, which is what `testFeed` reads.
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.httpStatus).toBe(401);
    expect(result.status === 'failed' && result.credentialsDropped).toBe(true);
    // Named so a diagnosis can point at the address rather than the password.
    expect(result.status === 'failed' && result.finalUrl).toBe(`${secondBase}/cal.ics`);
  });

  it('keeps it across a same-origin redirect', async () => {
    atFirst.length = 0;
    atSecond.length = 0;
    const result = await get(`${firstBase}/here`);

    expect(atFirst.map((seen) => seen.path)).toEqual(['/here', '/cal.ics']);
    // Both hops signed in, which is what makes a same-host redirect silent.
    expect(atFirst.map((seen) => seen.authorization)).toEqual([CREDENTIAL, CREDENTIAL]);
    expect(atSecond).toEqual([]);
    expect(result.status).toBe('ok');
  });

  it('does not claim a credential was dropped when none was sent', async () => {
    /*
     * The half that would otherwise be silently wrong. A cross-origin redirect
     * on a request carrying no credential has dropped nothing, and reporting
     * otherwise would put "the password is not sent there" on a feed that has
     * no password — advice about a control the household never filled in.
     */
    atFirst.length = 0;
    atSecond.length = 0;
    const result = await fetcher.fetch({
      url: `${firstBase}/away`,
      policy: LOOPBACK,
      maxBytes: 64 * 1024,
      acceptContentTypes: ['text/calendar'],
    });

    expect(atSecond[0]?.authorization).toBeUndefined();
    expect(result.status === 'failed' && result.httpStatus).toBe(401);
    expect(result.status === 'failed' && result.credentialsDropped).toBeUndefined();
    // `finalUrl` is still there: it is where the request got to, which is worth
    // saying whether or not anything was stripped on the way.
    expect(result.status === 'failed' && result.finalUrl).toBe(`${secondBase}/cal.ics`);
  });
});
