import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { validateOutboundUrl } from '@maverick-wall/core';
import { createFetcher } from '../src/net/fetcher.js';
import { testFeed } from '../src/api/test-feed.js';

/**
 * A feed behind Basic auth, and the three sentences a 401 has to tell apart.
 *
 * Against a **real server that enforces it** rather than a stub: the whole of
 * Phase A's user experience is the diagnosis, and a stub answering 200 to
 * everything cannot see any of it — it cannot even see whether the header went
 * out. This one answers 401 with a `WWW-Authenticate` whenever the credential
 * is absent or wrong, which is what Nextcloud and every other self-hosted
 * server does, and serves the calendar when it is right.
 */

/**
 * One event, a week out.
 *
 * Dated from the clock rather than written as a literal, because `testFeed`
 * previews what is *upcoming* — a fixture with a hardcoded date is a test that
 * passes until the day it is overtaken, and this file would then fail for a
 * reason that has nothing to do with signing in.
 */
const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/[-:]|\.\d{3}/g, '');
const ICS =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n' +
  `BEGIN:VEVENT\r\nUID:1\r\nDTSTART:${soon}\r\nDTEND:${soon}\r\n` +
  'SUMMARY:Bin day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

const USER = 'jane';
const PASSWORD = 'Fluffy2019!';
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64')}`;

let guarded: Server;
let elsewhere: Server;
let guardedBase = '';
let elsewhereBase = '';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

/** Exactly what a self-hosted server does: challenge, or serve. */
function requireBasic(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers.authorization !== EXPECTED) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="calendars", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    res.end('Unauthorized');
    return false;
  }
  return true;
}

beforeAll(async () => {
  elsewhere = createServer((_req, res) => {
    // The second origin is guarded too, so the hop that arrives with nothing
    // gets the same 401 a wrong password would — which is the whole reason the
    // third sentence is hard to tell from the second.
    res.writeHead(401, { 'www-authenticate': 'Basic realm="calendars"' });
    res.end('Unauthorized');
  });
  elsewhereBase = await listen(elsewhere);

  guarded = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/moved') {
      res.writeHead(302, { location: `${elsewhereBase}/cal.ics` });
      res.end();
      return;
    }
    if (path === '/signin-page') {
      // Far commoner than a bare 401: an unauthenticated GET answered with an
      // HTML sign-in form.
      if (req.headers.authorization === undefined) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><form>sign in</form></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(ICS);
      return;
    }
    if (!requireBasic(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(ICS);
  });
  guardedBase = await listen(guarded);
});

afterAll(() => {
  guarded.close();
  elsewhere.close();
});

const fetcher = createFetcher();

function ask(url: string, credential?: { username?: string; password?: string }) {
  return testFeed(
    {
      url,
      allowLoopback: true,
      allowHttp: true,
      timezone: 'Europe/London',
      ...(credential ?? {}),
    },
    fetcher,
  );
}

describe('testing a feed that needs signing in', () => {
  it('fetches it with the right credential', async () => {
    const result = await ask(`${guardedBase}/cal.ics`, { username: USER, password: PASSWORD });
    expect(result.ok).toBe(true);
    expect(result.ok && result.totalEvents).toBe(1);
    expect(result.ok && result.preview[0]?.title).toBe('Bin day');
  });

  it('says the calendar needs one when none was sent', async () => {
    const result = await ask(`${guardedBase}/cal.ics`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe('fetch');
    expect(result.ok === false && result.suggestion).toBe(
      'This calendar needs a username and password; enter them below.',
    );
  });

  it('says the same when a username arrived without a password', async () => {
    /*
     * Half a credential composes no header, so this request signed in as
     * nobody — and the sentence has to follow *what was sent* rather than what
     * was typed. Following what was typed here would tell a household halfway
     * through the form that their password was rejected.
     */
    const result = await ask(`${guardedBase}/cal.ics`, { username: USER });
    expect(result.ok === false && result.suggestion).toBe(
      'This calendar needs a username and password; enter them below.',
    );
  });

  it('says the password was not accepted when one was sent and refused', async () => {
    const result = await ask(`${guardedBase}/cal.ics`, { username: USER, password: 'wrong' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.suggestion).toContain(
      'The username or password was not accepted.',
    );
    // And never the other two, which is the half that makes this a diagnosis.
    expect(result.ok === false && result.suggestion).not.toContain('needs a username and password');
    expect(result.ok === false && result.suggestion).not.toContain('redirected');
  });

  it('points at the address, not the password, when a redirect dropped it', async () => {
    const result = await ask(`${guardedBase}/moved`, { username: USER, password: PASSWORD });
    expect(result.ok).toBe(false);
    // The origin it went to, by name, so the household can point at it. Never
    // the path, which is a credential in its own right.
    expect(result.ok === false && result.suggestion).toBe(
      `The address redirected to ${elsewhereBase}, and the password is not sent there. ` +
        'Use that address instead.',
    );
    expect(result.ok === false && result.suggestion).not.toContain('not accepted');
  });

  it('offers the sign-in clause when a web page comes back unauthenticated', async () => {
    // Once a feed can be credentialed, an HTML page in place of a calendar
    // means a second thing — a server answering an unauthenticated GET with a
    // sign-in form rather than a 401.
    const anonymous = await ask(`${guardedBase}/signin-page`);
    expect(anonymous.ok).toBe(false);
    expect(anonymous.ok === false && anonymous.suggestion).toContain(
      'if this calendar needs a username and password, enter them below',
    );

    // And with a credential already supplied, Google's link is the likelier
    // diagnosis and the sentence is left exactly as it was.
    const signedIn = await ask(`${guardedBase}/signin-page`, {
      username: USER,
      password: PASSWORD,
    });
    expect(signedIn.ok).toBe(true);
  });

  it('refuses a credential written into the address, and says where to put it', async () => {
    // The refusal stays — `user@host` is a parser-confusion trick and storing
    // one is a bad idea — and only the remedy changed.
    const result = await ask(`http://${USER}:${PASSWORD}@127.0.0.1:1/cal.ics`);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe('url');
    expect(result.ok === false && result.suggestion).toContain(
      'enter them where the calendar’s username and password are asked for below',
    );
    // The old remedy sent somebody holding an app password looking for a token.
    expect(result.ok === false && result.suggestion).not.toContain('token in the path');
  });

  it('says the same thing one layer down, in the guard itself', () => {
    const refused = validateOutboundUrl(`https://${USER}:${PASSWORD}@example.com/cal.ics`, {});
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.code).toBe('userinfo-present');
    expect(refused.ok === false && refused.error.message).toContain(
      'enter them in the username and password fields instead',
    );
    expect(refused.ok === false && refused.error.message).not.toContain('token in the path');
  });
});
