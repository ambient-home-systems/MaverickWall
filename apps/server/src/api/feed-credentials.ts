import type { UrlPolicy } from '@maverick-wall/core';
import type { Keyring } from '../secrets/keyring.js';

/**
 * One resolver for a feed's connection: where to fetch it, under what policy,
 * and who to sign in as (RFC 013 §4, §6.2.2).
 *
 * The shape is taken from `resolveConnection` in
 * `modules/homeassistant/client.ts`, whose own docstring is the heading: *two
 * credential paths, one client*. Here the two paths are a password **stored**
 * as a keyring envelope on `calendar_sources` and one **typed** into a form
 * this instant — the add form and the wizard both test an address before any
 * row exists, so there is nothing to decrypt yet and there must still be
 * exactly one thing that decides what header goes on the wire.
 *
 * It answers the address, the `UrlPolicy` and the header **together** rather
 * than the header alone, and that is deliberate. A header-only resolver would
 * leave the three network opt-ins read separately by every caller, which is
 * the drift this file exists to prevent one layer down from where it names it
 * — and it is the seam Phase C's `caldav_accounts` will hang its own shape off
 * without any caller learning there are two.
 *
 * **This is the only thing in the server that reads
 * `auth_password_encrypted`.** Everything downstream sees a header or nothing.
 */

/**
 * Where the password is, and the union makes "both at once" unrepresentable.
 *
 * An earlier sketch had `authPassword` and `authPasswordEncrypted` side by side
 * with a precedence rule; a precedence rule is a thing somebody has to
 * remember, and the case it arbitrates is always a mistake. Two members of a
 * union is the same information with the mistake deleted.
 */
export type FeedPassword =
  /** A keyring envelope, exactly as the column holds it. Null means none. */
  | { readonly stored: string | null }
  /** In clear, from a form, for one request. Never written anywhere by this file. */
  | { readonly typed: string | null | undefined };

export interface FeedConnectionInput {
  /** The address, already decrypted. */
  readonly url: string;
  readonly allowPrivateNetwork: boolean;
  readonly allowLoopback: boolean;
  readonly allowHttp: boolean;
  readonly authUsername: string | null | undefined;
  readonly authPassword: FeedPassword;
}

export interface FeedConnection {
  readonly url: string;
  readonly policy: UrlPolicy;
  /** `authorization` when there is a credential, and an empty object when not. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * True when a stored envelope would not open — a backup restored without
   * `/data/.secret`, or a tampered column.
   *
   * The connection still comes back, with no header on it, because the caller
   * has to decide what to do about it: a sync says so and keeps yesterday's
   * events, and a diagnosis prints it. Throwing here would be an exception
   * across a boundary, which this codebase does not do.
   */
  readonly passwordUnreadable: boolean;
}

/**
 * Basic, per RFC 7617, and **UTF-8** rather than latin-1.
 *
 * The RFC's own `charset` parameter exists because the original scheme did not
 * say, and every server anybody self-hosts — Nextcloud, Baïkal, Radicale, SOGo
 * — reads the decoded bytes as UTF-8. A household whose app password carries an
 * accented character is a household whose calendar would otherwise fail to sign
 * in with no message that could name the reason.
 *
 * A username with a colon in it cannot be expressed at all, by the scheme
 * rather than by us: the decoded string is split on the *first* colon, so a
 * colon in the username silently moves the boundary. Nothing here rejects one
 * — an address that fails to sign in is recoverable and a refused save with a
 * sentence about colons is not the screen this deserves — but it is why the
 * password may contain them freely and the username may not.
 */
function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function passwordFrom(
  password: FeedPassword,
  keyring: Keyring | undefined,
): { readonly value: string | undefined; readonly unreadable: boolean } {
  if ('typed' in password) {
    const typed = password.typed;
    return { value: typed === null || typed === '' ? undefined : typed, unreadable: false };
  }
  const envelope = password.stored;
  if (envelope === null || envelope === '') return { value: undefined, unreadable: false };
  if (keyring === undefined) return { value: undefined, unreadable: true };
  const opened = keyring.decrypt(envelope, 'feed-password');
  return opened.ok ? { value: opened.value, unreadable: false } : { value: undefined, unreadable: true };
}

/**
 * Resolve one feed's connection.
 *
 * `keyring` is only consulted for a stored envelope, and is optional for that
 * reason: `testFeed` runs before a row exists and has nothing to open.
 */
export function connectionFor(
  source: FeedConnectionInput,
  keyring?: Keyring,
): FeedConnection {
  const policy: UrlPolicy = {
    ...(source.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(source.allowLoopback ? { allowLoopback: true } : {}),
    ...(source.allowHttp ? { allowHttp: true } : {}),
  };

  const username = source.authUsername === null ? undefined : source.authUsername?.trim();
  const password = passwordFrom(source.authPassword, keyring);

  /*
   * A username with no password sends **nothing**, and this is the one branch
   * worth stating rather than leaving to fall out of the arithmetic.
   *
   * `Basic base64("jane:")` is a well-formed header asserting an empty
   * password, and a server that answers it does so with a 401 that reads as
   * "the password was wrong" — for a household who has not typed one yet. Half
   * a credential is not a credential: sending no header at all lets the server
   * answer the question actually being asked, which is whether this calendar
   * needs signing in to, and lets `testFeed` say "this calendar needs a
   * username and password" rather than "that password was not accepted".
   *
   * The reverse — a password with no username — is the same non-credential and
   * takes the same branch.
   */
  const headers =
    username === undefined || username === '' || password.value === undefined
      ? {}
      : { authorization: basicAuthorization(username, password.value) };

  return { url: source.url, policy, headers, passwordUnreadable: password.unreadable };
}
