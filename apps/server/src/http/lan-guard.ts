import { classifyIp, parseIp } from '@maverick-wall/core';

/**
 * Who is really asking for an eInk frame, and whether we can see them at all.
 *
 * The eInk frame carries its token in a URL rather than an `HttpOnly` cookie,
 * because a dumb panel cannot hold one — and a URL is the one credential in
 * this product a household is expected to hand-copy into a device's own
 * config, which makes it more likely than a wall's cookie to end up somewhere
 * with weaker access control than this app. `screens.lan_only` does not make
 * that token harder to guess; it bounds what a *leaked* copy is worth by
 * refusing it from off the household's own network.
 *
 * That is only true if the address being judged is the visitor's. It is a pure
 * module for the reason `safeNextPath`, `widget-options.ts` and `ink.ts` are:
 * a policy that lives inside a handler is a policy a test can only reach
 * through a server, one case at a time — and this one has five cases whose
 * differences are the entire point.
 *
 * **The shipped guard read the socket and nothing else, which is correct
 * for a direct-to-box household and silently wrong behind a reverse proxy.**
 * `forwarded.ts` explicitly supports fronting the box with Caddy, Traefik or
 * NPM; when a household does, every request arrives from the *proxy's*
 * address — loopback, or a private Docker address — so a socket-only check
 * answered "on the home network" for every request in the world, including
 * ones from the public internet through that proxy. The switch said it was
 * protecting them and it was not. A control that does nothing is this
 * repository's most repeated fault (`options.json`, `showIcon`, "Show week
 * numbers" on five days out of seven); on a security control it is the worst
 * place to have it.
 */

/**
 * The header a reverse proxy reports the original client in.
 *
 * Trusted on exactly the terms `X-Forwarded-Proto` is trusted in
 * `forwarded.ts`, and for the identical reason: the wall port is on the LAN,
 * so anything on the network can send this. **A forgeable header is not a
 * credential.** It is read only when the request's real TCP source — the
 * socket, never a header — is one the household named in
 * `TRUSTED_PROXY_SOURCE`. Note that this is *not* `CLIENT_IP_HEADER`, which
 * `app.ts` stamps from the socket and overwrites on every request; that one is
 * ours and is never read from a client.
 */
export const FORWARDED_FOR_HEADER = 'x-forwarded-for';

/**
 * What stands between this application and the visitor, when it cannot see
 * past it. Recorded so the admin can say so; never a reason on its own to
 * refuse a frame.
 */
export type ForwardingNote =
  /**
   * Requests are arriving with proxy headers from a source that is *not*
   * configured as this household's proxy. Deliberately not called "there is a
   * proxy": the header is forgeable, so anything on the LAN can produce this
   * observation. What is certain is only that the guard is judging the socket
   * while something is claiming to forward — which is worth telling a
   * household either way, since both readings are things they would want to
   * know about a panel they have restricted.
   */
  | 'untrusted-forwarding'
  /**
   * The request came *from* a configured proxy, and that proxy did not say who
   * it was forwarding for. Here there is no doubt and no fallback: the socket
   * is known to be the proxy's own address, so judging it would be judging the
   * wrong thing.
   */
  | 'proxy-sent-no-client';

export interface FrameSource {
  /**
   * The address to judge, or `undefined` when it genuinely cannot be told.
   * `undefined` is not "no restriction applies" — callers refuse on it.
   */
  readonly client: string | undefined;
  /** What to record about our ability to see the client; null when clear. */
  readonly note: ForwardingNote | null;
}

export interface FrameSourceInput {
  /** The real TCP peer, from `getConnInfo` — never a header. */
  readonly socketAddress: string | undefined;
  /** The raw `X-Forwarded-For`, whatever a client or a proxy sent. */
  readonly forwardedFor: string | undefined;
  /** Socket addresses the household named as its reverse proxy. */
  readonly trustedProxies: ReadonlySet<string>;
}

/**
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:172.30.32.2`.
 * Transcribed from `ingress.ts` rather than imported, because importing the
 * ingress module for one string operation ties the frame guard to a feature it
 * has nothing to do with; the two are four characters long and pinned to each
 * other by `lan-guard.test.ts`.
 */
function normalise(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * Resolve who to judge, given where the request actually came from.
 *
 * Deliberately independent of whether `lan_only` is on, so the note is
 * recorded — and the admin can warn — *before* a household flips the switch
 * rather than after they have trusted it. Turning a restriction on and only
 * then being told it cannot see anything is the wrong way round.
 */
export function resolveFrameSource(input: FrameSourceInput): FrameSource {
  const socket = input.socketAddress;
  const forwarded = input.forwardedFor;
  const fromTrustedProxy =
    socket !== undefined && socket !== '' && input.trustedProxies.has(normalise(socket));

  if (fromTrustedProxy) {
    /*
     * A proxy chain sends `client, proxy1, proxy2` and the first entry is the
     * one the browser was — the same first-hop reading `effectiveScheme` takes
     * of `X-Forwarded-Proto`. Only the last hop is verified (it is our own
     * socket); every entry before it is whatever the household's own proxy
     * chain wrote, which is their configuration to get right and exactly the
     * trust they granted by naming a proxy at all.
     */
    const first = forwarded?.split(',')[0]?.trim();
    if (first === undefined || first === '' || parseIp(first) === undefined) {
      return { client: undefined, note: 'proxy-sent-no-client' };
    }
    return { client: first, note: null };
  }

  // Not a configured proxy, so the header is ignored entirely and the socket
  // is the only thing worth judging — which is exactly what a direct-to-box
  // household wants and is unchanged from what shipped.
  const claimingToForward = forwarded !== undefined && forwarded.trim() !== '';
  return { client: socket, note: claimingToForward ? 'untrusted-forwarding' : null };
}

/**
 * Whether an address is one a household's own panel could plausibly connect
 * from.
 *
 * Reuses the SSRF guard's own classifier rather than a second one — two
 * classifiers agreeing by coincidence is not something to rely on — but asks a
 * different question than `isLocalNetwork` does there: loopback counts here (a
 * request from the same host is not "the internet" either), where the SSRF
 * guard excludes it because a feed loopback points at is never a legitimate
 * calendar. An address that cannot be determined fails closed, exactly as
 * `isTrustedIngress` already does for the same reason: a check that cannot
 * tell is not a green light.
 */
export function isFromHomeNetwork(address: string | undefined): boolean {
  if (address === undefined) return false;
  const parsed = parseIp(address);
  if (parsed === undefined) return false;
  const kind = classifyIp(parsed);
  return kind === 'private' || kind === 'cgnat' || kind === 'loopback';
}
