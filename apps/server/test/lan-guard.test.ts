import { describe, expect, it } from 'vitest';

import { isFromHomeNetwork, resolveFrameSource, type ForwardingNote } from '../src/http/lan-guard.js';
import { normaliseSource } from '../src/http/ingress.js';

/**
 * The eInk frame guard's whole policy, read down in one place.
 *
 * A table against the pure function for the reason `safeNextPath` has one: the
 * cases that matter differ only in which of two addresses is judged, and
 * reaching each of them through a real server is one harness per row. The real
 * round trip lives in `epaper-lan-only.test.ts` and is still the thing that
 * proves the wiring.
 *
 * The case this file exists for is `untrusted-forwarding`. The shipped guard
 * read the socket and nothing else, which behind a reverse proxy meant it
 * judged the *proxy* — always private or loopback — and so answered "on the
 * home network" for every request in the world.
 */

const PROXY = new Set(['10.0.0.9']);
const NONE = new Set<string>();

describe('resolveFrameSource', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly socket: string | undefined;
    readonly forwarded: string | undefined;
    readonly proxies: ReadonlySet<string>;
    readonly client: string | undefined;
    readonly note: ForwardingNote | null;
  }> = [
    // --- No proxy configured: the socket is the only thing worth judging ----
    {
      name: 'a direct request judges the socket',
      socket: '192.168.1.42',
      forwarded: undefined,
      proxies: NONE,
      client: '192.168.1.42',
      note: null,
    },
    {
      name: 'a forgeable header from an unconfigured source is ignored, and noted',
      socket: '192.168.1.42',
      forwarded: '203.0.113.9',
      proxies: NONE,
      client: '192.168.1.42',
      note: 'untrusted-forwarding',
    },
    {
      name: 'the note fires on the address the guard would wrongly bless',
      // The shape of the real fault: a proxy on the same host forwards a
      // visitor from the public internet, and the socket is loopback.
      socket: '127.0.0.1',
      forwarded: '203.0.113.9',
      proxies: NONE,
      client: '127.0.0.1',
      note: 'untrusted-forwarding',
    },
    {
      name: 'whitespace is not a forwarding claim',
      socket: '192.168.1.42',
      forwarded: '   ',
      proxies: NONE,
      client: '192.168.1.42',
      note: null,
    },

    // --- A configured proxy: the first hop is the visitor ------------------
    {
      name: 'a trusted proxy hands over the client it forwarded for',
      socket: '10.0.0.9',
      forwarded: '203.0.113.9',
      proxies: PROXY,
      client: '203.0.113.9',
      note: null,
    },
    {
      name: 'a chain is read at its first hop, the one the browser was',
      socket: '10.0.0.9',
      forwarded: '203.0.113.9, 172.18.0.4, 10.0.0.9',
      proxies: PROXY,
      client: '203.0.113.9',
      note: null,
    },
    {
      name: 'a dual-stack socket matches a bare address in the trust set',
      socket: '::ffff:10.0.0.9',
      forwarded: '192.168.1.42',
      proxies: PROXY,
      client: '192.168.1.42',
      note: null,
    },
    {
      name: 'a trusted proxy that says nothing leaves nobody to judge',
      socket: '10.0.0.9',
      forwarded: undefined,
      proxies: PROXY,
      client: undefined,
      note: 'proxy-sent-no-client',
    },
    {
      name: 'a trusted proxy sending nonsense is the same as saying nothing',
      // Never fall back to the socket here: it is known to be the proxy's own
      // address, so judging it would be judging the wrong thing on purpose.
      socket: '10.0.0.9',
      forwarded: 'unknown',
      proxies: PROXY,
      client: undefined,
      note: 'proxy-sent-no-client',
    },

    // --- Nothing to go on -------------------------------------------------
    {
      name: 'no socket and no header leaves nobody to judge',
      socket: undefined,
      forwarded: undefined,
      proxies: PROXY,
      client: undefined,
      note: null,
    },
    {
      name: 'an empty socket is not an address, and cannot be a trusted proxy',
      // Refused before the trust set is consulted, so an empty entry in that
      // set — the shape a stray comma in TRUSTED_PROXY_SOURCE would make —
      // can never turn "we know nothing" into "a proxy vouched for this".
      socket: '',
      forwarded: '203.0.113.9',
      proxies: new Set(['']),
      client: '',
      note: 'untrusted-forwarding',
    },
  ];

  for (const row of cases) {
    it(row.name, () => {
      expect(
        resolveFrameSource({
          socketAddress: row.socket,
          forwardedFor: row.forwarded,
          trustedProxies: row.proxies,
        }),
      ).toEqual({ client: row.client, note: row.note });
    });
  }
});

describe('isFromHomeNetwork', () => {
  it('accepts the addresses a household actually serves a panel from', () => {
    for (const address of ['192.168.1.42', '10.0.0.5', '172.16.4.1', '127.0.0.1', '::1', '100.64.0.5']) {
      expect(isFromHomeNetwork(address), address).toBe(true);
    }
  });

  it('refuses the public internet, link-local, and anything unreadable', () => {
    // 169.254.0.0/16 is deliberately out: it holds the cloud metadata address,
    // and "the local network" must never mean that one — the same boundary
    // `isLocalNetwork` draws in the SSRF guard.
    for (const address of ['203.0.113.9', '8.8.8.8', '169.254.169.254', 'not-an-ip', '']) {
      expect(isFromHomeNetwork(address), address).toBe(false);
    }
  });

  it('refuses an address that could not be determined at all', () => {
    expect(isFromHomeNetwork(undefined)).toBe(false);
  });

  it('sees through an IPv4-mapped address, so ::ffff: cannot smuggle one past', () => {
    expect(isFromHomeNetwork('::ffff:192.168.1.42')).toBe(true);
    expect(isFromHomeNetwork('::ffff:203.0.113.9')).toBe(false);
  });
});

/**
 * `lan-guard.ts` transcribes `normaliseSource` rather than importing it, so
 * that the frame guard does not depend on the ingress module for one string
 * operation. That is only safe while the two agree — this is the pin the
 * docstring there promises.
 */
describe('the transcribed address normaliser', () => {
  it('agrees with the ingress one it was copied from', () => {
    // The empty string is left out deliberately: it is not an address, and
    // `resolveFrameSource` refuses it before the trust set is consulted — see
    // the table above, which is where that case is asserted.
    const inputs = ['10.0.0.9', '::ffff:10.0.0.9', '::1', 'fe80::1', '::ffff:'];
    for (const address of inputs) {
      // Reached through the exported behaviour: a bare address in the trust
      // set has to match whichever form the socket reported.
      const trust = new Set([normaliseSource(address)]);
      const resolved = resolveFrameSource({
        socketAddress: address,
        forwardedFor: '192.168.1.42',
        trustedProxies: trust,
      });
      expect(resolved.client, address).toBe('192.168.1.42');
    }
  });
});
