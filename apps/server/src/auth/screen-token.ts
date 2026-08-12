import { verifyDisplayToken } from './tokens.js';
import type { ScreenRow } from '../api/queries.js';

/**
 * Authenticating a wall screen from a request's headers.
 *
 * Two callers need exactly the same rule and must not drift apart: the HTTP
 * routes under `/d/*` (a Hono context) and the WebSocket push server (a raw
 * Node upgrade request, which never reaches Hono). Both a socket screen and a
 * polling screen carry the identical `mw_display` token, so the identity check
 * lives here, header-shaped, and each caller adapts its own request into these
 * two strings.
 */

/** Ten years. A wall is paired once and left alone; see the `/pair` routes. */
export const DISPLAY_COOKIE = 'mw_display';
export const DISPLAY_COOKIE_ATTRS = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000';

/** Pull a single cookie's value out of a `Cookie:` header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** The token a request presents: a bearer header, or failing that the cookie. */
export function presentedDisplayToken(
  authorization: string | undefined,
  cookie: string | undefined,
): string | undefined {
  const bearer = authorization?.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : undefined;
  // A native client can set Authorization; a kiosk WebView loading `/` cannot,
  // and carries the cookie the pairing redirect set instead.
  return bearer ?? cookieValue(cookie, DISPLAY_COOKIE);
}

/**
 * The screen behind a presented token, or nothing.
 *
 * A linear scan over every screen, comparing against each stored hash. A
 * household has a handful, and this is what keeps the comparison constant-time
 * per candidate rather than turning the token into a lookup key an attacker
 * could time.
 */
export function authenticateScreenToken(
  screens: readonly ScreenRow[],
  headers: { authorization?: string | undefined; cookie?: string | undefined },
): ScreenRow | undefined {
  const presented = presentedDisplayToken(headers.authorization, headers.cookie);
  if (presented === undefined || presented === '') return undefined;
  return screens.find((screen) => verifyDisplayToken(presented, screen.tokenHash));
}
