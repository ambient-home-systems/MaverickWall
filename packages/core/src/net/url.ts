import { classifyIp, isLocalNetwork, parseIp, type ParsedIp } from './address.js';

/**
 * URL-level validation, applied before a single packet is sent.
 *
 * This is the first of two gates. It works on the URL as written and can only
 * catch what is visible there: a bad scheme, credentials in the userinfo, an IP
 * literal in any of its disguises, a hostname that names something internal.
 *
 * It cannot catch a hostname that *resolves* to an internal address — that is
 * the fetcher adapter's job, and it needs DNS. Neither gate is sufficient
 * alone. This one exists because rejecting `http://0x7f000001/` before a socket
 * opens is cheaper and clearer than discovering it after resolution, and
 * because a user pasting a bad URL deserves an error that names the problem.
 */

export type UrlRejectionCode =
  | 'unparseable'
  | 'too-long'
  | 'scheme-not-allowed'
  | 'http-not-allowed'
  | 'userinfo-present'
  | 'empty-host'
  | 'ip-literal'
  | 'private-address'
  | 'loopback-name'
  | 'internal-suffix'
  | 'reserved-name'
  | 'bare-hostname'
  | 'trailing-dot';

export interface UrlRejection {
  readonly code: UrlRejectionCode;
  /** Safe to show a user. Says what is wrong and, where useful, what to do. */
  readonly message: string;
}

export interface ValidatedUrl {
  /** Normalised. Use this, not the string that was passed in. */
  readonly href: string;
  readonly protocol: 'http:' | 'https:';
  /** Lowercased, punycoded. What DNS will actually be asked for. */
  readonly hostname: string;
  readonly port: string;
  /** True when the host is an address literal rather than a name. */
  readonly isIpLiteral: boolean;
  readonly ip?: ParsedIp;
}

export interface UrlPolicy {
  /**
   * Permit plain HTTP. Off by default: a feed URL is a bearer credential and
   * sending it in clear over someone's network is worth an explicit decision.
   */
  readonly allowHttp?: boolean;
  /**
   * Permit LAN destinations. Off by default, and per-source rather than global.
   *
   * The self-host exception. Households legitimately point at Nextcloud, Immich
   * or Home Assistant on their own network, and refusing that would make the
   * product useless to exactly the people it is for. But it must be a
   * deliberate per-source toggle: enabling it for one feed should never widen
   * the reach of the others.
   */
  readonly allowPrivateNetwork?: boolean;
  /**
   * Permit the loopback interface. Off by default, and deliberately separate
   * from `allowPrivateNetwork` so that enabling LAN access never implies it.
   *
   * The case this exists for: Home Assistant add-ons reach each other over
   * localhost, and a `--network host` deployment may have a service bound only
   * to 127.0.0.1. Everything else should use the machine's LAN address.
   *
   * Note what it does *not* unlock. Link-local stays refused under every
   * policy, because 169.254.169.254 is the cloud metadata endpoint.
   */
  readonly allowLoopback?: boolean;
  /** Default 2048. Long enough for any real feed URL. */
  readonly maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 2048;

/**
 * Suffixes that name something inside the local network.
 *
 * `.local` is mDNS, `.home.arpa` is the RFC 8375 home network name, `.internal`
 * is the convention every cloud provider uses for private zones, and the rest
 * are RFC 6761 special-use names that must never reach a public resolver.
 */
const INTERNAL_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.home.arpa',
  '.lan',
  '.onion',
];

/**
 * RFC 6761 names reserved for documentation and testing. They never resolve
 * to anything, anywhere — not just on this network, so "turn on allow local
 * network" is a suggestion that would not help. They get their own message.
 */
const RESERVED_SUFFIXES = ['.test', '.example', '.invalid'];

const LOOPBACK_NAMES = ['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'];

function reject(code: UrlRejectionCode, message: string): { ok: false; error: UrlRejection } {
  return { ok: false, error: { code, message } };
}

export type ValidateUrlResult =
  | { readonly ok: true; readonly value: ValidatedUrl }
  | { readonly ok: false; readonly error: UrlRejection };

/**
 * Validate a user-supplied URL.
 *
 * Never throws. Every rejection carries a code for the caller and a message for
 * the person who typed it.
 */
export function validateOutboundUrl(raw: string, policy: UrlPolicy = {}): ValidateUrlResult {
  const maxLength = policy.maxLength ?? DEFAULT_MAX_LENGTH;

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return reject('unparseable', 'Enter a calendar address.');
  }
  if (raw.length > maxLength) {
    return reject('too-long', `That address is longer than ${maxLength} characters.`);
  }

  // `webcal:` is the scheme calendar apps register; it is plain HTTPS with a
  // different label, and every provider that publishes one serves it over TLS.
  const normalised = raw.trim().replace(/^webcal:\/\//i, 'https://');

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    return reject('unparseable', 'That does not look like a web address.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return reject(
      'scheme-not-allowed',
      `Calendar addresses must start with https://. This one starts with ${url.protocol}`,
    );
  }

  if (url.protocol === 'http:' && policy.allowHttp !== true) {
    return reject(
      'http-not-allowed',
      'This address is not encrypted. Calendar addresses are passwords in ' +
        'effect, so plain http has to be turned on for this feed deliberately.',
    );
  }

  // Credentials in the URL. Beyond being a bad idea to store, `user@host` is a
  // classic parser-confusion trick: the part a human reads as the host is the
  // username, and the real destination follows the @.
  if (url.username !== '' || url.password !== '') {
    return reject(
      'userinfo-present',
      'Remove the username and password from the address. If the feed needs ' +
        'credentials, it should carry them in a token in the path.',
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    return reject('empty-host', 'That address has no server name in it.');
  }

  // A trailing dot is the DNS root, and it makes `evil.com.` a different string
  // to `evil.com` while resolving identically — enough to slip past a naive
  // suffix or allow-list check somewhere downstream.
  if (hostname.endsWith('.')) {
    return reject('trailing-dot', 'Remove the dot from the end of the server name.');
  }

  if (LOOPBACK_NAMES.includes(hostname)) {
    if (policy.allowLoopback === true) {
      return {
        ok: true,
        value: {
          href: url.href,
          protocol: url.protocol,
          hostname,
          port: url.port,
          isIpLiteral: false,
        },
      };
    }
    return reject(
      'loopback-name',
      'That address points back at the machine running Maverick Wall. Turn on ' +
        '"allow loopback" for this source if that is really what you meant.',
    );
  }

  for (const suffix of INTERNAL_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return reject(
        'internal-suffix',
        `Addresses ending in ${suffix} name something on the local network ` +
          'rather than a public calendar service.',
      );
    }
  }

  for (const suffix of RESERVED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return reject(
        'reserved-name',
        `Addresses ending in ${suffix} are reserved for documentation and ` +
          "testing and never resolve to anything. Check for a typo, or that " +
          "this isn't placeholder text left in the address.",
      );
    }
  }

  // An address literal, in any of the forms a resolver accepts. Bracketed IPv6
  // arrives here with the brackets already stripped by the URL parser.
  const ip = parseIp(hostname);
  if (ip) {
    const loopbackPermitted = policy.allowLoopback === true && classifyIp(ip) === 'loopback';
    if (loopbackPermitted || (policy.allowPrivateNetwork === true && isLocalNetwork(ip))) {
      return {
        ok: true,
        value: {
          href: url.href,
          protocol: url.protocol,
          hostname,
          port: url.port,
          isIpLiteral: true,
          ip,
        },
      };
    }

    const kind = classifyIp(ip);

    // Checked before the reserved branch below: loopback has its own opt-in,
    // so the message should point at that rather than say "unreachable".
    if (kind === 'loopback') {
      return reject(
        'ip-literal',
        'That address points back at this machine. Turn on "allow loopback" ' +
          'for this source if that is really what you meant.',
      );
    }

    if (!isLocalNetwork(ip) && kind !== 'public') {
      // Link-local lands here, which is deliberate. There is no flag that
      // opens 169.254.169.254, so the message must not imply one exists.
      return reject(
        'private-address',
        'That address is reserved and cannot be reached from here.',
      );
    }
    return reject(
      'ip-literal',
      isLocalNetwork(ip)
        ? 'That is an address on your local network. Turn on "allow local ' +
          'network" for this feed if that is what you meant.'
        : 'Use the server name rather than its numeric address.',
    );
  }

  // A name with no dot in it is a local hostname — a NAS, a router, a container
  // name — resolved by the search domain rather than public DNS.
  if (!hostname.includes('.')) {
    if (policy.allowPrivateNetwork === true) {
      return {
        ok: true,
        value: {
          href: url.href,
          protocol: url.protocol,
          hostname,
          port: url.port,
          isIpLiteral: false,
        },
      };
    }
    return reject(
      'bare-hostname',
      `"${hostname}" is a name on your local network. Turn on "allow local ` +
        'network" for this feed if that is what you meant.',
    );
  }

  return {
    ok: true,
    value: {
      href: url.href,
      protocol: url.protocol,
      hostname,
      port: url.port,
      isIpLiteral: false,
    },
  };
}

/**
 * Re-check a redirect target against the same policy.
 *
 * A redirect is a fresh destination chosen by a remote server, so it gets the
 * same scrutiny as the URL a user typed. Following one blindly is the standard
 * way an SSRF guard gets bypassed: the first request goes somewhere harmless
 * and the 302 points at the metadata endpoint.
 */
export function validateRedirect(
  location: string,
  from: ValidatedUrl,
  policy: UrlPolicy = {},
): ValidateUrlResult {
  let absolute: string;
  try {
    absolute = new URL(location, from.href).href;
  } catch {
    return reject('unparseable', 'The server redirected to an address we could not read.');
  }
  return validateOutboundUrl(absolute, policy);
}

/** True when a redirect leaves the origin, meaning credentials must be dropped. */
export function isCrossOrigin(from: ValidatedUrl, to: ValidatedUrl): boolean {
  return from.protocol !== to.protocol || from.hostname !== to.hostname || from.port !== to.port;
}
