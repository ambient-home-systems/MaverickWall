import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connectionFor, forgetBothShapeWarnings } from '../src/api/feed-credentials.js';
import { createKeyring } from '../src/secrets/keyring.js';

/**
 * The one resolver, against every shape a feed's credential comes in.
 *
 * It is a unit test rather than a sync test on purpose: this is one function
 * standing in for two storage locations, and §6.2.2's whole claim is that no
 * caller knows the difference. A test that drove it through `ics-sync` would
 * be asserting the sync and inferring the resolver.
 */

const keyring = createKeyring(randomBytes(32));

const base = {
  url: 'https://nextcloud.example/remote.php/dav/calendars/jane/personal?export',
  allowPrivateNetwork: false,
  allowLoopback: false,
  allowHttp: false,
} as const;

function decode(header: string | undefined): string {
  expect(header).toBeDefined();
  return Buffer.from((header as string).slice('Basic '.length), 'base64').toString('utf8');
}

describe('connectionFor', () => {
  it('builds a Basic header from a stored envelope', () => {
    const connection = connectionFor(
      {
        ...base,
        authUsername: 'jane',
        authPassword: { stored: keyring.encrypt('app-pw-1', 'feed-password') },
      },
      keyring,
    );
    expect(decode(connection.headers['authorization'])).toBe('jane:app-pw-1');
    expect(connection.passwordUnreadable).toBe(false);
    expect(connection.url).toBe(base.url);
  });

  it('builds the same header from a password typed into a form', () => {
    // The add form and the wizard both test an address before a row exists, so
    // there is nothing to decrypt — and the bytes on the wire have to be the
    // same ones the sync will send an hour later, or testing proves nothing.
    const typed = connectionFor({ ...base, authUsername: 'jane', authPassword: { typed: 'app-pw-1' } });
    const stored = connectionFor(
      { ...base, authUsername: 'jane', authPassword: { stored: keyring.encrypt('app-pw-1', 'feed-password') } },
      keyring,
    );
    expect(typed.headers).toEqual(stored.headers);
  });

  it('encodes a non-ASCII password as UTF-8, not latin-1', () => {
    // RFC 7617's `charset` parameter exists because the original scheme did not
    // say. Every self-hosted server anybody points this at reads UTF-8, and a
    // household whose app password carries an accent would otherwise fail to
    // sign in with no message that could name the reason.
    const connection = connectionFor({
      ...base,
      authUsername: 'jané',
      authPassword: { typed: 'sünshine' },
    });
    expect(decode(connection.headers['authorization'])).toBe('jané:sünshine');
    expect(connection.headers['authorization']).toBe(
      `Basic ${Buffer.from('jané:sünshine', 'utf8').toString('base64')}`,
    );
  });

  it('sends no header at all for a feed with no credential', () => {
    const connection = connectionFor(
      { ...base, authUsername: null, authPassword: { stored: null } },
      keyring,
    );
    expect(connection.headers).toEqual({});
    expect(connection.passwordUnreadable).toBe(false);
  });

  it('sends nothing for a username with no password', () => {
    /*
     * Half a credential is not a credential.
     *
     * `Basic base64("jane:")` is a well-formed header asserting an *empty*
     * password, and a server answers it with the same 401 a wrong password
     * gets — so a household who typed a username and has not reached the
     * password field yet would be told their password was rejected. Sending
     * nothing lets the server answer the question actually being asked, and
     * lets `testFeed` say "this calendar needs a username and password".
     */
    const connection = connectionFor(
      { ...base, authUsername: 'jane', authPassword: { stored: null } },
      keyring,
    );
    expect(connection.headers).toEqual({});
  });

  it('sends nothing for a password with no username, which is the same non-credential', () => {
    const connection = connectionFor(
      { ...base, authUsername: null, authPassword: { typed: 'app-pw-1' } },
      keyring,
    );
    expect(connection.headers).toEqual({});
  });

  it('says so, and sends nothing, when a stored envelope will not open', () => {
    // A backup restored without /data/.secret. The connection still comes back
    // — the caller decides what to say about it and keeps yesterday's events.
    const other = createKeyring(randomBytes(32));
    const connection = connectionFor(
      {
        ...base,
        authUsername: 'jane',
        authPassword: { stored: other.encrypt('app-pw-1', 'feed-password') },
      },
      keyring,
    );
    expect(connection.passwordUnreadable).toBe(true);
    expect(connection.headers).toEqual({});
  });

  it('refuses an envelope sealed for another purpose', () => {
    // The purpose is bound into the ciphertext, which is why `feed-password` is
    // its own rather than a second use of `calendar-source-url`: without the
    // split, a feed's address swapped into this column would decrypt and be
    // sent as a password.
    const connection = connectionFor(
      {
        ...base,
        authUsername: 'jane',
        authPassword: { stored: keyring.encrypt('https://elsewhere/feed.ics', 'calendar-source-url') },
      },
      keyring,
    );
    expect(connection.passwordUnreadable).toBe(true);
    expect(connection.headers).toEqual({});
  });

  it('carries the three network opt-ins through as one policy', () => {
    // The reason this answers the policy rather than the header alone: a
    // header-only resolver leaves these read separately by every caller.
    const off = connectionFor({ ...base, authUsername: null, authPassword: { stored: null } });
    expect(off.policy).toEqual({});

    const on = connectionFor({
      ...base,
      allowPrivateNetwork: true,
      allowLoopback: true,
      allowHttp: true,
      authUsername: null,
      authPassword: { stored: null },
    });
    expect(on.policy).toEqual({
      allowPrivateNetwork: true,
      allowLoopback: true,
      allowHttp: true,
    });
  });

  /*
   * The four cases §11 names, against one function standing in for two storage
   * locations.
   *
   * §6.2.2's whole claim is that no caller knows there are two shapes, so these
   * are asserted on what comes *out* — the address, the policy and the header —
   * rather than on which branch produced it. A test that checked the branch
   * would pass just as happily on a resolver that answered the right header
   * from the wrong switches, which is the exact failure the section predicts.
   */
  describe('the two storage locations (RFC 013 §6.2.2)', () => {
    const account = {
      id: 'acct-1',
      username: 'jane@icloud.example',
      passwordEncrypted: keyring.encrypt('apple-app-specific', 'caldav-password'),
      allowPrivateNetwork: false,
      allowLoopback: false,
      allowHttp: false,
    } as const;

    it('a Phase A row signs in from its own columns', () => {
      const connection = connectionFor(
        {
          ...base,
          authUsername: 'jane',
          authPassword: { stored: keyring.encrypt('app-pw-1', 'feed-password') },
        },
        keyring,
      );
      expect(decode(connection.headers['authorization'])).toBe('jane:app-pw-1');
      expect(connection.confirmedHost).toBeUndefined();
    });

    it('a Phase C row signs in from the account, and takes its policy from it too', () => {
      // The address still comes from the calendar row -- a collection href is a
      // fact about the calendar -- while everything sent *with* the request
      // comes from the account. Both halves are asserted, because a resolver
      // that got the header right and the switches wrong is the failure mode.
      const connection = connectionFor(
        {
          ...base,
          url: 'https://p42-caldav.icloud.example/1234/calendars/home/',
          authUsername: null,
          authPassword: { stored: null },
          account: {
            ...account,
            allowPrivateNetwork: true,
            allowHttp: true,
            confirmedHost: 'p42-caldav.icloud.example',
          },
        },
        keyring,
      );
      expect(decode(connection.headers['authorization'])).toBe(
        'jane@icloud.example:apple-app-specific',
      );
      expect(connection.url).toBe('https://p42-caldav.icloud.example/1234/calendars/home/');
      // From the account, and emphatically not from the calendar row, whose own
      // three switches are all false in `base`.
      expect(connection.policy).toEqual({ allowPrivateNetwork: true, allowHttp: true });
      expect(connection.confirmedHost).toBe('p42-caldav.icloud.example');
    });

    it('a row with both prefers the account, and says so once', () => {
      forgetBothShapeWarnings();
      const warnings: string[] = [];
      const realWarn = console.warn;
      console.warn = (...args: unknown[]): void => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        const both = {
          ...base,
          authUsername: 'stale-from-phase-a',
          authPassword: { stored: keyring.encrypt('stale-pw', 'feed-password') },
          account,
        };
        const first = connectionFor(both, keyring);
        const second = connectionFor(both, keyring);
        expect(decode(first.headers['authorization'])).toBe(
          'jane@icloud.example:apple-app-specific',
        );
        // The same answer twice, and the line said once: this runs on a
        // schedule, so "once" has to survive the second sync or it is not once.
        expect(second.headers).toEqual(first.headers);
        expect(warnings).toHaveLength(1);
        // Rule six, and `api/diagnostics.ts`'s own promise: a CalDAV username is
        // very often an email address, so neither half of either credential may
        // reach a log line.
        expect(warnings[0]).not.toContain('jane@icloud.example');
        expect(warnings[0]).not.toContain('stale-from-phase-a');
        expect(warnings[0]).not.toContain('apple-app-specific');
        expect(warnings[0]).not.toContain('stale-pw');
      } finally {
        console.warn = realWarn;
      }
    });

    it('a row with neither signs in as nobody', () => {
      const connection = connectionFor(
        { ...base, authUsername: null, authPassword: { stored: null } },
        keyring,
      );
      expect(connection.headers).toEqual({});
      expect(connection.passwordUnreadable).toBe(false);
    });

    it("reports an account envelope that will not open, and still answers", () => {
      // Rule nine at the resolver: a backup restored without /data/.secret must
      // come back as a connection with no header rather than as a throw, so the
      // sync can say so and keep yesterday's events.
      const connection = connectionFor(
        {
          ...base,
          authUsername: null,
          authPassword: { stored: null },
          // Sealed for the wrong purpose, which is precisely what the purpose
          // split exists to refuse: a feed password must not open as a CalDAV one.
          account: { ...account, passwordEncrypted: keyring.encrypt('x', 'feed-password') },
        },
        keyring,
      );
      expect(connection.passwordUnreadable).toBe(true);
      expect(connection.headers).toEqual({});
    });
  });
});
