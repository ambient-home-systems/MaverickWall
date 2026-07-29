/**
 * IP address parsing and classification.
 *
 * This is the sharp end of the SSRF guard. Everything here is pure: no DNS, no
 * sockets, no runtime APIs. The server adapter resolves names and pins
 * connections; this module decides what is safe to talk to.
 *
 * The parsers are deliberately *permissive* — more permissive than any sane
 * address format — because their job is detection, not interpretation. An
 * attacker submitting `http://0x7f000001/` or `http://2130706433/` is asking
 * for 127.0.0.1, and both curl and every browser will oblige. A strict parser
 * that rejected those as "not an IP" would let them through as hostnames.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  readonly version: IpVersion;
  /** Big-endian: 4 bytes for v4, 16 for v6. */
  readonly bytes: readonly number[];
}

/**
 * Parse one component of a dotted address the way `inet_aton` does: decimal,
 * octal when prefixed with `0`, hexadecimal when prefixed with `0x`.
 */
function parseAtonPart(part: string): number | undefined {
  // A full 32-bit value in octal is twelve characters; leading zeros can add
  // more. Range is enforced below, so this bound only stops absurd input.
  if (part.length === 0 || part.length > 24) return undefined;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
  if (/^(0|[1-9][0-9]*)$/.test(part)) return Number.parseInt(part, 10);
  return undefined;
}

function bytesFromUint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * Parse an IPv4 address in any form a C resolver would accept.
 *
 * Covers `1.2.3.4`, `1.2.3` (last part spans two octets), `1.2`, and a bare
 * 32-bit integer, each part independently decimal, octal, or hex. All of the
 * following mean 127.0.0.1: `127.0.0.1`, `127.1`, `2130706433`, `0x7f000001`,
 * `0177.0.0.01`.
 */
export function parseIpv4(text: string): ParsedIp | undefined {
  if (text.length === 0 || text.length > 64) return undefined;

  const parts = text.split('.');
  if (parts.length > 4) return undefined;

  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseAtonPart(part);
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) return undefined;
    numbers.push(value);
  }

  const last = numbers[numbers.length - 1];
  if (last === undefined) return undefined;

  // Every part but the last is a single octet; the last absorbs what remains.
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i]! > 0xff) return undefined;
  }
  const remainingOctets = 4 - (numbers.length - 1);
  if (last >= 2 ** (8 * remainingOctets)) return undefined;

  let value = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    value += numbers[i]! * 2 ** (8 * (3 - i));
  }

  return { version: 4, bytes: bytesFromUint32(value >>> 0) };
}

/** Parse an IPv6 address, including `::` compression and a trailing IPv4 tail. */
export function parseIpv6(text: string): ParsedIp | undefined {
  let input = text;
  if (input.startsWith('[') && input.endsWith(']')) input = input.slice(1, -1);
  // A zone identifier is only meaningful to the local host, so its presence is
  // itself a signal we should not be dialling this address.
  if (input.includes('%')) return undefined;
  if (input.length === 0 || input.length > 64) return undefined;
  if (!input.includes(':')) return undefined;

  const lastColon = input.lastIndexOf(':');
  const afterColon = input.slice(lastColon + 1);
  if (afterColon.includes('.')) {
    // Strict dotted-quad only in this position; the permissive forms are not
    // legal inside an IPv6 literal.
    if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(afterColon)) return undefined;
    const octets = afterColon.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => octet > 255)) return undefined;

    // Rewrite the trailing IPv4 as the two hex groups it actually occupies, so
    // the rest of the parser sees a uniform eight-group address. Substituting a
    // single placeholder group instead shifts every preceding group one
    // position left, which silently turns ::ffff:127.0.0.1 into a public
    // address — the exact bypass this guard exists to stop.
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    input = `${input.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColon = input.indexOf('::');
  if (doubleColon !== input.lastIndexOf('::')) return undefined;

  const groupsNeeded = 8;
  let groups: number[];

  if (doubleColon === -1) {
    const pieces = input.split(':');
    if (pieces.length !== groupsNeeded) return undefined;
    groups = [];
    for (const piece of pieces) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
  } else {
    const headText = input.slice(0, doubleColon);
    const tailText = input.slice(doubleColon + 2);
    const head = headText === '' ? [] : headText.split(':');
    const rest = tailText === '' ? [] : tailText.split(':');
    if (head.length + rest.length >= groupsNeeded) return undefined;

    const parse = (pieces: string[]): number[] | undefined => {
      const out: number[] = [];
      for (const piece of pieces) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
        out.push(Number.parseInt(piece, 16));
      }
      return out;
    };

    const headGroups = parse(head);
    const restGroups = parse(rest);
    if (!headGroups || !restGroups) return undefined;

    const zeros = new Array<number>(groupsNeeded - headGroups.length - restGroups.length).fill(0);
    groups = [...headGroups, ...zeros, ...restGroups];
  }

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  if (bytes.length !== 16) return undefined;

  return { version: 6, bytes };
}

/** Parse an address in either family. */
export function parseIp(text: string): ParsedIp | undefined {
  return text.includes(':') ? parseIpv6(text) : parseIpv4(text);
}

export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link-local'
  | 'multicast'
  | 'broadcast'
  | 'documentation'
  | 'reserved';

function inV4Range(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < 4 && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) addresses carry a
 * v4 address in their low bytes. Both are routed to that v4 address, so both
 * must be unwrapped before classification or `::ffff:127.0.0.1` walks straight
 * past a v6-only check.
 */
export function unwrapEmbeddedIpv4(ip: ParsedIp): ParsedIp | undefined {
  if (ip.version !== 6) return undefined;
  const b = ip.bytes;

  const isMapped =
    b.slice(0, 10).every((byte) => byte === 0) && b[10] === 0xff && b[11] === 0xff;
  const isNat64 =
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b.slice(4, 12).every((byte) => byte === 0);

  if (!isMapped && !isNat64) return undefined;
  return { version: 4, bytes: b.slice(12, 16) };
}

function classifyIpv4(bytes: readonly number[]): AddressClass {
  if (inV4Range(bytes, [0, 0, 0, 0], 8)) return 'unspecified';
  if (inV4Range(bytes, [127, 0, 0, 0], 8)) return 'loopback';
  if (inV4Range(bytes, [10, 0, 0, 0], 8)) return 'private';
  if (inV4Range(bytes, [172, 16, 0, 0], 12)) return 'private';
  if (inV4Range(bytes, [192, 168, 0, 0], 16)) return 'private';
  if (inV4Range(bytes, [100, 64, 0, 0], 10)) return 'cgnat';
  // 169.254.0.0/16 includes 169.254.169.254, the cloud metadata endpoint that
  // makes SSRF worth exploiting in the first place.
  if (inV4Range(bytes, [169, 254, 0, 0], 16)) return 'link-local';
  if (inV4Range(bytes, [192, 0, 0, 0], 24)) return 'reserved';
  if (inV4Range(bytes, [192, 0, 2, 0], 24)) return 'documentation';
  if (inV4Range(bytes, [198, 51, 100, 0], 24)) return 'documentation';
  if (inV4Range(bytes, [203, 0, 113, 0], 24)) return 'documentation';
  if (inV4Range(bytes, [192, 88, 99, 0], 24)) return 'reserved';
  if (inV4Range(bytes, [198, 18, 0, 0], 15)) return 'reserved';
  if (bytes[0] === 255 && bytes[1] === 255 && bytes[2] === 255 && bytes[3] === 255) {
    return 'broadcast';
  }
  if (inV4Range(bytes, [224, 0, 0, 0], 4)) return 'multicast';
  if (inV4Range(bytes, [240, 0, 0, 0], 4)) return 'reserved';
  return 'public';
}

function classifyIpv6(bytes: readonly number[]): AddressClass {
  if (bytes.every((byte) => byte === 0)) return 'unspecified';
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return 'loopback';

  // ::a.b.c.d — the deprecated IPv4-compatible form from RFC 4291. Still
  // routed to the embedded v4 address by stacks that accept it, so it needs
  // unwrapping like ::ffff: does. Checked after the unspecified and loopback
  // cases above so ::  and ::1 keep their own labels.
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return classifyIpv4(bytes.slice(12, 16));
  }

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;

  if (first === 0xff) return 'multicast';
  if ((first & 0xfe) === 0xfc) return 'private'; // fc00::/7 unique local
  if (first === 0xfe && (second & 0xc0) === 0x80) return 'link-local'; // fe80::/10
  if (first === 0x20 && second === 0x01) {
    const third = bytes[2] ?? 0;
    const fourth = bytes[3] ?? 0;
    if (third === 0x0d && fourth === 0xb8) return 'documentation'; // 2001:db8::/32
    if (third === 0x00 && fourth === 0x00) return 'reserved'; // 2001::/32 Teredo
  }
  if (first === 0x01 && second === 0x00 && bytes.slice(2, 8).every((b) => b === 0)) {
    return 'reserved'; // 100::/64 discard-only
  }
  return 'public';
}

/** Classify an address, unwrapping any embedded IPv4 first. */
export function classifyIp(ip: ParsedIp): AddressClass {
  if (ip.version === 4) return classifyIpv4(ip.bytes);
  const embedded = unwrapEmbeddedIpv4(ip);
  if (embedded) return classifyIpv4(embedded.bytes);
  return classifyIpv6(ip.bytes);
}

/** True only for addresses reachable across the public internet. */
export function isPubliclyRoutable(ip: ParsedIp): boolean {
  return classifyIp(ip) === 'public';
}

/**
 * True for addresses a household might legitimately self-host on.
 *
 * Deliberately narrower than "not public", and the boundary is worth stating
 * because getting it wrong is how the self-host exception becomes an SSRF hole.
 *
 * Included:
 *   - RFC 1918 private space. Where Nextcloud, Immich and Home Assistant live,
 *     including the 172.30.x supervisor address of a Home Assistant add-on.
 *   - CGNAT space (100.64.0.0/10), because Tailscale uses it and reaching your
 *     own services over Tailscale is a normal self-hosting pattern.
 *
 * Excluded, and each for a reason:
 *   - **Link-local.** 169.254.0.0/16 holds APIPA addresses, which appear only
 *     when DHCP has failed and which nobody deliberately serves from. It also
 *     holds 169.254.169.254, the cloud metadata endpoint that is the single
 *     most valuable target an SSRF can reach. Permitting "the local network"
 *     must never permit that.
 *   - **Loopback.** From inside a container this reaches the container itself,
 *     which is not a self-hosting scenario, and services bound to loopback are
 *     written on the assumption that nothing remote can reach them.
 *   - Multicast, broadcast, reserved and documentation space, none of which a
 *     calendar feed could plausibly live on.
 */
export function isLocalNetwork(ip: ParsedIp): boolean {
  const kind = classifyIp(ip);
  return kind === 'private' || kind === 'cgnat';
}

/** Render an address for logs and error messages. */
export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return ip.bytes.join('.');
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((ip.bytes[i] ?? 0) << 8) | (ip.bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}
