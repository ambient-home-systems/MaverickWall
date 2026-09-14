import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connectionFor } from '../src/api/feed-credentials.js';
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
});
