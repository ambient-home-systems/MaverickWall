import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UrlPolicy } from '@maverick-wall/core';
import { createFetcher } from '../src/net/fetcher.js';
import { discover } from '../src/caldav/discover.js';
import { startCalDavFake, type CalDavFake } from './caldav-fake.js';

/**
 * The host-confirmation policy, driven (RFC 013 §11).
 *
 * Three cases, and the middle one is the only one that was ever at risk:
 *
 * - a chain that stays on one host completes with **no confirmation step**;
 * - a chain whose `calendar-home-set` points at a second host **stops**, and
 *   the second host has received no request carrying `authorization`;
 * - with `confirmedHost` set, the same chain completes and the second host does
 *   receive the credential.
 *
 * Every assertion about the credential is on **what the second server
 * recorded**, never on the outcome. An outcome cannot tell "we never went" from
 * "we went and were refused", and the thing being protected is a household's
 * Apple ID password.
 *
 * Run through the real `createFetcher`, so the SSRF guard, the DNS pin and the
 * redirect handling are all on the path — §11's own complaint about a stub that
 * answers 200 with a fixture is that it proves nothing about any of them.
 */

const LOOPBACK: UrlPolicy = { allowLoopback: true, allowHttp: true };
const USERNAME = 'jane@example.org';
const PASSWORD = 'app-specific-pw';
const CREDENTIAL = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`;
const fetcher = createFetcher();

let home: CalDavFake;
let partition: CalDavFake;

beforeAll(async () => {
  // The partition host, standing in for `pNN-caldav.icloud.com`. A second
  // loopback port is a second origin by exactly the test `isCrossOrigin` and
  // `hostKey` both apply.
  partition = await startCalDavFake({ credential: CREDENTIAL });
  home = await startCalDavFake({ credential: CREDENTIAL });
});

afterAll(async () => {
  await home.close();
  await partition.close();
});

function run(serverUrl: string, confirmedHost?: string) {
  return discover(fetcher, {
    serverUrl,
    username: USERNAME,
    password: PASSWORD,
    policy: LOOPBACK,
    ...(confirmedHost !== undefined ? { confirmedHost } : {}),
    timeoutMs: 5000,
  });
}

/** A fake whose home set points at the other one, rebuilt per test. */
async function movingChain(): Promise<CalDavFake> {
  return startCalDavFake({
    credential: CREDENTIAL,
    homeSetUrl: `${partition.base}/dav/calendars/REDACTED/`,
  });
}

describe('a chain that stays on the host the household typed', () => {
  it('completes with nothing to confirm', async () => {
    home.reset();
    const result = await run(home.base);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.principalUrl).toBe(`${home.base}/dav/principals/REDACTED/`);
    expect(result.homeSetUrl).toBe(`${home.base}/dav/calendars/REDACTED/`);
    // Two calendars, not three: the `VTODO`-only collection is a shopping list
    // and a calendar widget asking for tasks would draw them as events.
    expect(result.calendars.map((calendar) => calendar.displayName)).toEqual([
      'Home',
      'School & clubs',
    ]);
    expect(result.calendars.map((calendar) => calendar.ctag)).toEqual([
      'ctag-home-1',
      'ctag-school-9',
    ]);
    expect(result.calendars[0]?.url).toBe(`${home.base}/dav/calendars/REDACTED/personal/`);
  });

  it('sends no credential on the well-known hop, and one on every hop after', async () => {
    home.reset();
    await run(home.base);

    // §6.3.1: the credential is not sent before the host decision, and that is
    // free rather than careful — step 1 needs no authentication at all.
    const wellKnown = home.seen.filter((record) => record.path === '/.well-known/caldav');
    expect(wellKnown).toHaveLength(1);
    expect(wellKnown[0]?.authorization).toBeUndefined();

    /*
     * Five requests for four hops, and the extra one is the price of the rule
     * rather than waste: step 1 follows the well-known redirect *unsigned*, so
     * the context path answers 401 and step 2 asks it again with the
     * credential. Paying one unauthenticated request is what makes the host
     * known before there is a password to lose, which is the whole of §6.3.1.
     */
    expect(home.seen.map((record) => record.path)).toEqual([
      '/.well-known/caldav',
      '/dav/',
      '/dav/',
      '/dav/principals/REDACTED/',
      '/dav/calendars/REDACTED/',
    ]);
    expect(home.seen.map((record) => record.authorization !== undefined)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    // The redirect is followed as a PROPFIND — RFC 6764 §6 specifies that hop,
    // and `REDIRECT_POLICY` is what lets it happen.
    expect(new Set(home.seen.map((record) => record.method))).toEqual(new Set(['PROPFIND']));
    // Depth 0 for the two lookups and Depth 1 for the listing. A listing at
    // Depth 0 answers the container and no calendars at all.
    expect(home.seen.map((record) => record.depth)).toEqual(['0', '0', '0', '0', '1']);
    expect(home.signedIn()).toHaveLength(3);
  });
});

describe('a chain whose calendar-home-set points at another host', () => {
  it('stops, and the second host has received no credential', async () => {
    const moving = await movingChain();
    partition.reset();
    try {
      const result = await run(moving.base);

      expect(result.status).toBe('needs-confirmation');
      expect(result.status === 'needs-confirmation' && result.host).toBe(
        new URL(partition.base).host,
      );

      /*
       * The assertion this whole file exists for. Not "the outcome was a
       * confirmation" — that would also pass if the request had gone and the
       * answer had been examined afterwards. The second host must not have been
       * asked *anything*, because an Apple ID password is not recoverable once
       * it has been handed to a server somebody else nominated.
       */
      expect(partition.signedIn()).toEqual([]);
      expect(partition.seen).toEqual([]);
    } finally {
      await moving.close();
    }
  });

  it('completes once the household has confirmed that host, and only then signs in there', async () => {
    const moving = await movingChain();
    partition.reset();
    try {
      const result = await run(moving.base, new URL(partition.base).host);

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.homeSetUrl).toBe(`${partition.base}/dav/calendars/REDACTED/`);
      expect(result.calendars.map((calendar) => calendar.displayName)).toEqual([
        'Home',
        'School & clubs',
      ]);
      // And now it *did* arrive — which is the half that says the stored answer
      // is what changed the behaviour rather than the request having been
      // impossible all along.
      expect(partition.seen.map((record) => record.path)).toEqual([
        '/dav/calendars/REDACTED/',
      ]);
      expect(partition.seen[0]?.authorization).toBe(CREDENTIAL);
    } finally {
      await moving.close();
    }
  });

  it('refuses a confirmation for a different host than the one it was asked about', async () => {
    // A stored answer is about one host. Reusing it for the next host a server
    // nominates would make the confirmation a one-time waiver rather than a
    // decision about a destination.
    const moving = await movingChain();
    partition.reset();
    try {
      const result = await run(moving.base, '127.0.0.1:1');
      expect(result.status).toBe('needs-confirmation');
      expect(partition.seen).toEqual([]);
    } finally {
      await moving.close();
    }
  });
});

describe('what discovery says when it cannot finish', () => {
  it('tells a refused password from a working one', async () => {
    home.reset();
    const result = await discover(fetcher, {
      serverUrl: home.base,
      username: USERNAME,
      password: 'not-the-password',
      policy: LOOPBACK,
      timeoutMs: 5000,
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.code).toBe('unauthorized');
    // Which hop, because §6.7's whole point is that "the address is fine and
    // the password is wrong" is a different sentence from the other two.
    expect(result.status === 'failed' && result.stage).toBe('principal');
  });

  it('says an account has no calendars rather than failing to connect', async () => {
    // Signed in, `207`, and the home set holds only its own container. §6.7:
    // this is a different sentence from "that address is not a CalDAV server",
    // and collapsing the two reduces the best screen in the admin to the worst
    // kind of error.
    const empty = await startCalDavFake({ credential: CREDENTIAL, emptyHomeSet: true });
    try {
      const result = await run(empty.base);
      expect(result.status === 'failed' && result.code).toBe('no-calendars');
      expect(result.status === 'failed' && result.stage).toBe('calendars');
    } finally {
      await empty.close();
    }
  });

  it('calls a 404 an address problem, not a broken network', async () => {
    /*
     * `unreachable` is documented as retryable and the sync job backs off on
     * it, so a 404 filed there is a moved collection retried every fifteen
     * minutes for ever while the household is told to check their connection.
     */
    const gone = await startCalDavFake({ credential: CREDENTIAL, serveCollections: false });
    try {
      const result = await run(gone.base);
      expect(result.status === 'failed' && result.code).toBe('not-caldav');
      expect(result.status === 'failed' && result.stage).toBe('calendars');
    } finally {
      await gone.close();
    }
  });

  it('says an address is not a CalDAV server when it answers something else', async () => {
    const result = await discover(fetcher, {
      serverUrl: 'http://127.0.0.1:1',
      username: USERNAME,
      password: PASSWORD,
      policy: LOOPBACK,
      timeoutMs: 2000,
    });
    expect(result.status === 'failed' && result.code).toBe('unreachable');
  });

  it('never throws, whatever the address is', async () => {
    for (const serverUrl of ['', 'not a url', 'ftp://example.org', 'https://']) {
      const result = await discover(fetcher, {
        serverUrl,
        username: USERNAME,
        password: PASSWORD,
        policy: LOOPBACK,
        timeoutMs: 2000,
      });
      expect(result.status, serverUrl).toBe('failed');
    }
  });

  it('is refused by the SSRF guard before it asks anything, with loopback off', async () => {
    const result = await discover(fetcher, {
      serverUrl: home.base,
      username: USERNAME,
      password: PASSWORD,
      // The three per-source opt-ins are what `connectionFor` builds, and every
      // hop is under the same policy — a discovery that widened its own policy
      // for hop four would be the guard forgotten in one of two places.
      policy: {},
      timeoutMs: 2000,
    });
    expect(result.status === 'failed' && result.code).toBe('refused');
  });
});
