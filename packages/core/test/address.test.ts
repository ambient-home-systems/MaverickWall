import { describe, expect, it } from 'vitest';
import { classifyIp, formatIp, isLocalNetwork, isPubliclyRoutable, parseIp } from '../src/net/address.js';

const classify = (text: string): string => {
  const ip = parseIp(text);
  return ip ? classifyIp(ip) : 'UNPARSEABLE';
};

describe('IPv4 obfuscation', () => {
  // Every one of these is 127.0.0.1 to a C resolver, to curl, and to every
  // browser. A parser that rejected them as "not an IP" would pass them
  // through as hostnames, which is the bypass.
  it.each([
    '127.0.0.1',
    '127.1',
    '127.0.1',
    '2130706433',
    '0x7f000001',
    '0177.0.0.1',
    '017700000001',
    '0x7f.0x0.0x0.0x1',
    '127.000.000.001',
  ])('%s resolves to loopback', (form) => {
    expect(classify(form)).toBe('loopback');
  });

  it.each(['169.254.169.254', '0xa9fea9fe', '2852039166'])(
    '%s is link-local, not public',
    (form) => {
      // 169.254.169.254 is the cloud metadata endpoint. It is the single
      // address that makes SSRF worth exploiting.
      expect(classify(form)).toBe('link-local');
    },
  );
});

describe('IPv6 with embedded IPv4', () => {
  it.each([
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'loopback'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['::127.0.0.1', 'loopback'],
    ['::ffff:192.168.1.1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:8.8.8.8', 'public'],
  ])('%s classifies as %s', (text, expected) => {
    expect(classify(text)).toBe(expected);
  });

  it('does not let a mapped address slip past as public', () => {
    // Regression: a trailing dotted quad was substituted with a placeholder
    // group, shifting every preceding group one position left. The ffff marker
    // landed in the wrong bytes and ::ffff:127.0.0.1 read as public.
    expect(isPubliclyRoutable(parseIp('::ffff:127.0.0.1')!)).toBe(false);
    expect(isPubliclyRoutable(parseIp('::ffff:10.0.0.1')!)).toBe(false);
    expect(isPubliclyRoutable(parseIp('::ffff:172.16.0.1')!)).toBe(false);
  });
});

describe('range boundaries', () => {
  it.each([
    ['9.255.255.255', 'public'],
    ['10.0.0.0', 'private'],
    ['10.255.255.255', 'private'],
    ['11.0.0.0', 'public'],
    ['172.15.255.255', 'public'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.0', 'public'],
    ['192.167.255.255', 'public'],
    ['192.168.0.0', 'private'],
    ['192.168.255.255', 'private'],
    ['192.169.0.0', 'public'],
    ['100.63.255.255', 'public'],
    ['100.64.0.0', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.0', 'public'],
  ])('%s is %s', (text, expected) => {
    expect(classify(text)).toBe(expected);
  });
});

describe('IPv6 special ranges', () => {
  it.each([
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fbff::1', 'public'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:1::1', 'reserved'],
    ['::', 'unspecified'],
    ['2606:4700:4700::1111', 'public'],
    ['2a00:1450:4001::200e', 'public'],
  ])('%s is %s', (text, expected) => {
    expect(classify(text)).toBe(expected);
  });
});

describe('other reserved space', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'reserved'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
  ])('%s is %s', (text, expected) => {
    expect(classify(text)).toBe(expected);
  });
});

describe('malformed input', () => {
  it.each([
    '',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.256',
    '0x',
    '...',
    '1..2.3',
    'abc',
    '999999999999',
    'fe80::1%eth0',
    ':::1',
    '1:2:3:4:5:6:7:8:9',
    '::ffff:999.1.1.1',
  ])('%s does not parse', (text) => {
    expect(parseIp(text)).toBeUndefined();
  });
});

describe('isLocalNetwork', () => {
  // The boundary of the self-host exception. Getting this wrong is how the
  // opt-in becomes an SSRF hole: an earlier version returned true for the
  // whole of link-local, which meant enabling local network access for a feed
  // also permitted 169.254.169.254.
  const cases: [string, boolean][] = [
    // Where self-hosted services actually live.
    ['192.168.1.50', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.30.32.2', true], // Home Assistant supervisor
    ['100.64.0.1', true], // Tailscale
    ['fd12:3456::1', true], // IPv6 unique local

    // 169.254.169.254 is the cloud metadata endpoint. Opting into the local
    // network must never open it, so the whole of link-local stays out.
    ['169.254.169.254', false],
    ['169.254.1.1', false],
    ['fe80::1', false],

    // Loopback reaches the container itself, and services bound to it are
    // written assuming nothing remote can get there.
    ['127.0.0.1', false],
    ['::1', false],

    ['8.8.8.8', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['240.0.0.1', false],
    ['0.0.0.0', false],
  ];

  it.each(cases)('%s -> %s', (text, expected) => {
    expect(isLocalNetwork(parseIp(text)!)).toBe(expected);
  });
});

describe('formatIp', () => {
  it('round-trips a v4 address', () => {
    expect(formatIp(parseIp('192.168.1.1')!)).toBe('192.168.1.1');
  });
  it('normalises obfuscated forms for logging', () => {
    expect(formatIp(parseIp('0x7f000001')!)).toBe('127.0.0.1');
  });
});
