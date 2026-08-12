import type { Context } from 'hono';
import { normaliseSource } from './ingress.js';

/**
 * Sitting correctly behind a TLS-terminating reverse proxy.
 *
 * A security-minded household can front the box with Caddy, Traefik or NPM on
 * their own domain. The proxy terminates HTTPS and forwards plain http inward,
 * so the container *sees* http on every request and, left alone, builds
 * `http://` origins and an insecure cookie — which breaks the cross-origin
 * guard (the browser's `Origin` is `https://…` and would never match) and
 * leaves the display token with no downgrade protection.
 *
 * The proxy says what the browser actually used in `X-Forwarded-Proto`. The
 * trap, identical in shape to `X-Ingress-Path` (see `ingress.ts`), is that this
 * header is trivially forgeable: the wall port is on the LAN, so anything on the
 * network can send it. **A forgeable header is not a credential.** So it is
 * trusted only when the request's real TCP source — the socket, never a header
 * — is one the household configured as its proxy (`TRUSTED_PROXY_SOURCE`).
 * Empty by default, which means the header is ignored entirely; a plain
 * `docker run` or a direct-to-box household is completely unaffected.
 *
 * Two rules bound this deliberately:
 *
 *   - **Never mandate TLS, and never HSTS.** HTTPS is supported here; it is
 *     nowhere required. HSTS on a self-signed or reverse-proxied LAN box is a
 *     self-inflicted brick — once a browser pins "https only" for this host,
 *     any drop back to http or any cert change locks the household out with no
 *     in-product recovery, and rule eleven says we can never reach their
 *     machine to fix it. Nothing in this application sets
 *     `Strict-Transport-Security`, and this comment is here so nobody restores
 *     it as a "hardening" fix — the same shape as the `USER node` comment in
 *     the Dockerfile.
 *   - **Conditional, never unconditional.** The `Secure` cookie attribute
 *     follows the *effective* scheme. Setting it unconditionally would strip
 *     the cookie from every plain-http wall screen — which is the ordinary LAN
 *     case — and a screen that cannot keep its display cookie cannot pair: an
 *     instant rule-nine brick for the households who never went near TLS.
 */

/** The one header a reverse proxy uses to report the client-facing scheme. */
export const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';

/**
 * The scheme the browser actually used.
 *
 * The request's own scheme, unless a *trusted* proxy source overrode it via
 * `X-Forwarded-Proto`. Fails closed to the direct scheme on any doubt: no
 * configured proxies, an unknown socket, a source not in the set, or a missing
 * or unrecognised header value.
 */
export function effectiveScheme(
  c: Context,
  socketAddress: string | undefined,
  trustedProxies: ReadonlySet<string>,
): 'http' | 'https' {
  const direct = new URL(c.req.url).protocol === 'https:' ? 'https' : 'http';
  // No proxy trust configured: the header does not exist as far as we care.
  if (trustedProxies.size === 0) return direct;
  if (socketAddress === undefined || socketAddress === '') return direct;
  if (!trustedProxies.has(normaliseSource(socketAddress))) return direct;

  const forwarded = c.req.header(FORWARDED_PROTO_HEADER);
  if (forwarded === undefined) return direct;
  // A proxy chain may send a comma list ("https, http"); the first hop is the
  // one the browser saw. Anything but the two known schemes is ignored.
  const first = forwarded.split(',')[0]?.trim().toLowerCase();
  if (first === 'https') return 'https';
  if (first === 'http') return 'http';
  return direct;
}

/**
 * The origin the browser is using — scheme corrected, host as received.
 *
 * Only the scheme is proxy-derived; the host comes from the request's own
 * `Host`, which a reverse proxy is expected to preserve. This is what the
 * cross-origin guard compares against so a genuine `https://…` form post is not
 * refused as foreign.
 */
export function effectiveOrigin(
  c: Context,
  socketAddress: string | undefined,
  trustedProxies: ReadonlySet<string>,
): string {
  const url = new URL(c.req.url);
  return `${effectiveScheme(c, socketAddress, trustedProxies)}://${url.host}`;
}

/** Whether the browser reached us over HTTPS — the gate on a `Secure` cookie. */
export function isSecureRequest(
  c: Context,
  socketAddress: string | undefined,
  trustedProxies: ReadonlySet<string>,
): boolean {
  return effectiveScheme(c, socketAddress, trustedProxies) === 'https';
}
