/**
 * Where to go after signing in.
 *
 * The gate knows what somebody was reaching for and the sign-in handler decides
 * where they land, and those are two different requests — so the destination
 * travels between them as a `?next=` parameter, which means it arrives from the
 * browser and is therefore a boundary. An admin box the docs assume somebody
 * will expose badly (rule ten) must not become a redirector to a stranger's
 * site.
 *
 * Everything here is one pure function so the whole rule can be read at once,
 * and so a test can enumerate the bypasses rather than driving each of them
 * through a server.
 */

/** Where an absent, malformed or refused destination lands. */
export const DEFAULT_AFTER_SIGN_IN = '/admin';

/**
 * The longest destination worth carrying.
 *
 * Not a security bound — everything below already refuses a foreign host — but
 * a `Location` is a header, and an unbounded one taken from a query string is
 * somebody else's problem to store and log.
 */
const MAX_LENGTH = 512;

/**
 * Control characters, and the backslash.
 *
 * A newline in a value that becomes a `Location` header is response splitting.
 * The backslash is here because engines have historically normalised
 * `/\evil.example` to `//evil.example` *before* deciding whether it names a
 * host — so a value that reads as our path can be read as their origin.
 */
// eslint-disable-next-line no-control-regex
const REFUSED_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * A destination this server is willing to send a browser to, or the default.
 *
 * The check is an allowlist by construction: it must be an absolute path under
 * `/admin`, which is the only prefix a signed-in household has any business
 * being returned to. That refuses a scheme (`http://evil.example` does not
 * start with `/admin`), a protocol-relative host (`//evil.example` does not
 * either — the second character is the tell), and any path outside the admin,
 * without any of them needing a clause of their own.
 *
 * Percent-encoded attempts need no separate clause either, and that is
 * deliberate: a query parameter is decoded once by URL parsing, so
 * `%2f%2fevil.example` arrives here as `//evil.example` and is refused by the
 * same line, while `%252f%252fevil.example` arrives still encoded and does not
 * start with `/admin`. Decoding again here is what would open the hole rather
 * than close it.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') return DEFAULT_AFTER_SIGN_IN;
  if (value.length > MAX_LENGTH) return DEFAULT_AFTER_SIGN_IN;
  if (REFUSED_CHARACTERS.test(value)) return DEFAULT_AFTER_SIGN_IN;
  if (!value.startsWith(DEFAULT_AFTER_SIGN_IN)) return DEFAULT_AFTER_SIGN_IN;
  /*
   * And the prefix has to end a path segment rather than merely start the
   * string, or `/administrator` passes. Still this origin, so still harmless —
   * but the rule is meant to read as "under the admin" and should say so.
   */
  const after = value.charAt(DEFAULT_AFTER_SIGN_IN.length);
  if (after !== '' && after !== '/' && after !== '?' && after !== '#') {
    return DEFAULT_AFTER_SIGN_IN;
  }
  return value;
}

/**
 * The sign-in URL to send an anonymous browser to, carrying where it was going.
 *
 * A destination that is only the default is left off rather than spelled out:
 * the sign-in page is reachable directly and a bare URL is what somebody
 * bookmarks.
 */
export function signInUrl(destination: unknown): string {
  const safe = safeNextPath(destination);
  return safe === DEFAULT_AFTER_SIGN_IN
    ? '/admin/sign-in'
    : `/admin/sign-in?next=${encodeURIComponent(safe)}`;
}
