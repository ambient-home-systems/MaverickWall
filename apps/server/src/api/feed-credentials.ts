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

/**
 * A CalDAV account's own columns, when the source is reached through one
 * (RFC 013 §6.2.1, §6.2.2).
 *
 * Everything here belongs to the **account** rather than to the calendar: one
 * credential and one server, for however many collections the household ticked.
 * The address is deliberately *not* here — a collection href is a fact about
 * the calendar and stays on `calendar_sources.url_encrypted`, which is why
 * `url` on the input below is still the only place an address comes from
 * whatever the kind.
 */
export interface FeedCaldavAccount {
  readonly id: string;
  readonly username: string;
  /** A keyring envelope, purpose `caldav-password`, exactly as the column holds it. */
  readonly passwordEncrypted: string;
  readonly allowPrivateNetwork: boolean;
  readonly allowLoopback: boolean;
  readonly allowHttp: boolean;
  /** The host discovery moved to and the household accepted (§6.3.1). */
  readonly confirmedHost?: string | null;
}

export interface FeedConnectionInput {
  /**
   * The address, already decrypted.
   *
   * For an `ics` feed this is the feed URL; for a `caldav` source it is the
   * collection href. One field either way, because which kind a row is has no
   * bearing on *where the bytes come from* — only on what is sent with the
   * request, which is what the rest of this file decides.
   */
  readonly url: string;
  readonly allowPrivateNetwork: boolean;
  readonly allowLoopback: boolean;
  readonly allowHttp: boolean;
  readonly authUsername: string | null | undefined;
  readonly authPassword: FeedPassword;
  /**
   * The account this source is reached through, when it has one.
   *
   * **Read first, and the row's own columns second** — which is the whole of
   * §6.2.2. Absent is a Phase A row and is the overwhelmingly common case.
   */
  readonly account?: FeedCaldavAccount | null;
}

export interface FeedConnection {
  readonly url: string;
  readonly policy: UrlPolicy;
  /**
   * The host the household confirmed for this account, passed through so the
   * CalDAV sync can hand it to `decideHost` without a second read of a table
   * this function has already read (§6.3.1). Undefined for every other kind.
   */
  readonly confirmedHost?: string | null;
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
  purpose: 'feed-password' | 'caldav-password' = 'feed-password',
): { readonly value: string | undefined; readonly unreadable: boolean } {
  if ('typed' in password) {
    const typed = password.typed;
    return { value: typed === null || typed === '' ? undefined : typed, unreadable: false };
  }
  const envelope = password.stored;
  if (envelope === null || envelope === '') return { value: undefined, unreadable: false };
  if (keyring === undefined) return { value: undefined, unreadable: true };
  const opened = keyring.decrypt(envelope, purpose);
  return opened.ok ? { value: opened.value, unreadable: false } : { value: undefined, unreadable: true };
}

/**
 * Source ids already warned about carrying both shapes, so the line is said
 * once rather than every fifteen minutes for ever.
 *
 * Module-global deliberately, and it is the same reasoning the auth rate-limit
 * buckets are: this outlives any one resolver call and any one job run, which
 * is exactly what "once" has to mean for a sync that repeats on a schedule. A
 * restart says it again, which is right — a boot is when somebody is reading.
 */
const warnedAboutBothShapes = new Set<string>();

/** Only for tests, which need each case to be the first time it is seen. */
export function forgetBothShapeWarnings(): void {
  warnedAboutBothShapes.clear();
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
  /*
   * The three switches come from whichever row owns them, resolved here and
   * not at the call site.
   *
   * This is the half §6.2.2 says a header-only resolver would have got wrong:
   * for a CalDAV source the opt-ins are a fact about the *server*, so they sit
   * on the account, and a caller that asked this function for a header while
   * reading the switches itself would read them from the calendar row for
   * Phase A and from the account for Phase C — two shapes, two readers, which
   * is the drift the whole section exists to prevent.
   */
  const switches = source.account ?? source;
  const policy: UrlPolicy = {
    ...(switches.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(switches.allowLoopback ? { allowLoopback: true } : {}),
    ...(switches.allowHttp ? { allowHttp: true } : {}),
  };

  const account = source.account ?? undefined;

  /*
   * The account wins, and it says so once.
   *
   * A row carrying both a `caldav_account_id` and its own `auth_username` is a
   * mistake rather than a configuration — nothing in the product writes one,
   * and the two paths that could (a Phase A feed edited into a CalDAV source, a
   * hand-edited database) both leave the *account* as the thing the household
   * actually set up. So preferring it is the reading that matches what they
   * did, and the alternative — refusing, or composing some merge of the two —
   * would take a working calendar off a wall over a column nobody can see.
   *
   * It is a warning rather than silence because the row is genuinely wrong and
   * the stale half will go on looking configured on the settings screen. The
   * line names the **source id and nothing else**: the username is very often
   * an email address, and rule six plus `api/diagnostics.ts`'s own promise put
   * it out of a log line whatever the redactor would have made of it.
   */
  if (account !== undefined && source.authUsername !== null && source.authUsername !== undefined
      && source.authUsername.trim() !== '') {
    if (!warnedAboutBothShapes.has(account.id + ':' + source.url)) {
      warnedAboutBothShapes.add(account.id + ':' + source.url);
      console.warn(
        '[caldav] a calendar carries both a CalDAV account and its own sign-in details; ' +
          'using the account. The calendar\u2019s own username and password are ignored.',
      );
    }
  }

  const username =
    account !== undefined
      ? account.username.trim()
      : source.authUsername === null
        ? undefined
        : source.authUsername?.trim();
  const password =
    account !== undefined
      ? passwordFrom({ stored: account.passwordEncrypted }, keyring, 'caldav-password')
      : passwordFrom(source.authPassword, keyring);

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

  return {
    url: source.url,
    policy,
    ...(account?.confirmedHost === undefined ? {} : { confirmedHost: account.confirmedHost }),
    headers,
    passwordUnreadable: password.unreadable,
  };
}
