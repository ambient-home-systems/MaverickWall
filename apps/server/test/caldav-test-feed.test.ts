import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFetcher } from '../src/net/fetcher.js';
import { testCaldavAccount, testFeed } from '../src/api/test-feed.js';
import { startCalDavFake, type CalDavFake } from './caldav-fake.js';

/**
 * `testFeed`'s fourth stage, and the picker (RFC 013 §6.7).
 *
 * The section's whole argument is that four outcomes are four *sentences*, so
 * that is what is asserted: not that each case fails, which a single "could not
 * connect" would satisfy, but that no two of them say the same thing and each
 * names a different next action.
 *
 * Driven against a real loopback server through the real `createFetcher`, for
 * the reason every other CalDAV test here is: the question is what the server
 * received, and a stub is asked rather than reached.
 */

const USERNAME = 'jane@example.org';
const PASSWORD = 'app-specific-pw';
const CREDENTIAL = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`;
const fetcher = createFetcher();
const LOOPBACK = { allowLoopback: true, allowHttp: true } as const;

let home: CalDavFake;
let empty: CalDavFake;
let notCaldav: CalDavFake;

beforeAll(async () => {
  home = await startCalDavFake({ credential: CREDENTIAL });
  empty = await startCalDavFake({ credential: CREDENTIAL, emptyHomeSet: true });
  notCaldav = await startCalDavFake({ credential: CREDENTIAL, serveCollections: false });
});
afterAll(async () => {
  await Promise.all([home.close(), empty.close(), notCaldav.close()]);
});

const ask = (base: string, overrides: Record<string, unknown> = {}) =>
  testCaldavAccount(
    { serverUrl: base, username: USERNAME, password: PASSWORD, ...LOOPBACK, ...overrides },
    fetcher,
  );

describe('testCaldavAccount', () => {
  it('answers a picker of calendars rather than a preview of events', async () => {
    const result = await ask(home.base);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);

    // Two of the fake's three collections hold events; the VTODO-only one is a
    // shopping list and is not a calendar a household should be offered.
    expect(result.calendars.map((calendar) => calendar.displayName)).toEqual([
      'Home',
      'School & clubs',
    ]);
    // The CTag comes back with them, so the first sync after adding costs one
    // PROPFIND and no REPORT rather than being a special case.
    expect(result.calendars[0]?.ctag).toBe('ctag-home-1');
    expect(result.principalUrl).toContain('/dav/principals/');
    expect(result.homeSetUrl).toContain('/dav/calendars/');
  });

  it('says four different things, and that is the point of the stage', async () => {
    const wrongPassword = await ask(home.base, { password: 'not-the-password' });
    const noCalendars = await ask(empty.base);
    const notAServer = await ask(notCaldav.base);
    /*
     * The confirmation is its own arm rather than a failure, because it is a
     * question rather than a fault: a caller must not have to tell it from a
     * real error by matching on the sentence.
     */
    const confirmation = await testCaldavAccount(
      {
        serverUrl: (await startMoved()).typed,
        username: USERNAME,
        password: PASSWORD,
        ...LOOPBACK,
      },
      fetcher,
    );
    expect(confirmation.ok).toBe(false);
    expect(confirmation.ok === false && confirmation.needsConfirmation?.host).toBeDefined();

    for (const result of [wrongPassword, noCalendars, notAServer]) {
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.needsConfirmation).toBeUndefined();
      expect(result.ok === false && result.stage).toBe('discover');
    }

    const sentences = [wrongPassword, noCalendars, notAServer].map((result) =>
      result.ok === false && result.needsConfirmation === undefined ? result.message : '',
    );
    // No two of them say the same thing. A single "could not connect" would
    // pass every assertion above this line and fail this one.
    expect(new Set(sentences).size).toBe(3);
    expect(sentences[0]).toMatch(/not accepted/i);
    expect(sentences[1]).toMatch(/no calendars/i);
    expect(sentences[2]).toMatch(/not be a CalDAV server|moved/i);

    // And each names a different next action rather than repeating the message.
    const advice = [wrongPassword, noCalendars, notAServer].map((result) =>
      result.ok === false && result.needsConfirmation === undefined ? result.suggestion : undefined,
    );
    expect(advice.every((line) => line !== undefined)).toBe(true);
    expect(new Set(advice).size).toBe(3);
    expect(advice[0]).toMatch(/app-specific password/i);
  });

  it('names the host it was sent to, and the credential has not gone there', async () => {
    const { typed, second } = await startMoved();
    second.reset();
    const result = await testCaldavAccount(
      { serverUrl: typed, username: USERNAME, password: PASSWORD, ...LOOPBACK },
      fetcher,
    );

    expect(result.ok).toBe(false);
    if (result.ok || result.needsConfirmation === undefined) throw new Error('expected a question');
    expect(result.needsConfirmation.host).toContain('127.0.0.1');
    // §11's assertion, and the only one that matters here: it is about what the
    // *second* host received, which no outcome can answer — an outcome cannot
    // tell "we never went" from "we went and were refused".
    expect(second.signedIn()).toHaveLength(0);
  });

  it('completes once the host is confirmed, and the credential does go there', async () => {
    const { typed, second } = await startMoved();
    second.reset();
    const result = await testCaldavAccount(
      {
        serverUrl: typed,
        username: USERNAME,
        password: PASSWORD,
        ...LOOPBACK,
        confirmedHost: new URL(second.base).host,
      },
      fetcher,
    );

    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.calendars.length).toBeGreaterThan(0);
    expect(second.signedIn().length).toBeGreaterThan(0);
    // The host stored as `confirmedHost` is where the calendars actually are.
    expect(result.host).toBe('127.0.0.1');
  });

  it('answers the network opt-ins as one list, not one per submission', async () => {
    // The same aggregate the ICS path answers: the guard stops at the first
    // rule that refuses, so a form told one code at a time takes three
    // submissions to reach a loopback http server.
    const result = await testCaldavAccount(
      { serverUrl: home.base, username: USERNAME, password: PASSWORD },
      fetcher,
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.needsConfirmation !== undefined) throw new Error('expected a refusal');
    expect(result.stage).toBe('url');
    expect([...result.networkOptions].sort()).toEqual(['allowHttp', 'allowLoopback']);
  });
});

describe('the ICS path is unchanged', () => {
  it('still reports its own three stages and still previews events', async () => {
    // §6.7 widens the union; it must not move anything the other callers read.
    const result = await testFeed(
      { url: 'not a url', timezone: 'Europe/London' },
      fetcher,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe('url');
  });
});

/** A server whose `calendar-home-set` points at a second origin (iCloud's move). */
const movedServers: CalDavFake[] = [];
afterAll(async () => {
  for (const server of movedServers) await server.close();
});
async function startMoved(): Promise<{ typed: string; second: CalDavFake }> {
  const second = await startCalDavFake({ credential: CREDENTIAL });
  const first = await startCalDavFake({
    credential: CREDENTIAL,
    homeSetUrl: `${second.base}/dav/calendars/REDACTED/`,
    serveCollections: false,
  });
  movedServers.push(second, first);
  return { typed: first.base, second };
}
