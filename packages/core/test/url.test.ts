import { describe, expect, it } from 'vitest';
import {
  isCrossOrigin,
  validateOutboundUrl,
  validateRedirect,
  type UrlPolicy,
} from '../src/net/url.js';

/** Rejection code, or 'OK'. Keeps the tables below readable. */
function code(raw: string, policy?: UrlPolicy): string {
  const result = validateOutboundUrl(raw, policy);
  return result.ok ? 'OK' : result.error.code;
}

describe('real feed URLs are accepted', () => {
  // Every shape in the fixture corpus, plus the providers most households use.
  it.each([
    'https://calendar.google.com/calendar/ical/x%40group.calendar.google.com/private-abc/basic.ics',
    'https://www.fcps.org/ICalendarHandler?calendarId=74783647',
    'https://outlook.office365.com/owa/calendar/abc/reachcalendar.ics',
    'https://p01-calendars.icloud.com/published/2/abc',
    'https://example.co.uk/cal.ics',
    'https://sub.domain.example.com:8443/cal.ics',
  ])('%s', (url) => {
    expect(code(url)).toBe('OK');
  });

  it('rewrites webcal to https', () => {
    // The scheme calendar apps register. It is HTTPS with a different label,
    // and every provider publishing one serves it over TLS.
    const result = validateOutboundUrl('webcal://example.com/cal.ics');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.protocol).toBe('https:');
  });
});

describe('schemes', () => {
  it('refuses plain http unless it is turned on for the feed', () => {
    // A feed URL is a bearer credential. Sending it in clear is a decision
    // somebody should make on purpose.
    expect(code('http://example.com/c.ics')).toBe('http-not-allowed');
    expect(code('http://example.com/c.ics', { allowHttp: true })).toBe('OK');
  });

  it.each([
    'ftp://example.com/c.ics',
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:text/plain,hi',
    'javascript:alert(1)',
  ])('refuses %s', (url) => {
    expect(code(url)).toBe('scheme-not-allowed');
  });
});

describe('credentials in the URL', () => {
  it.each([
    'https://user:pass@example.com/c.ics',
    'https://evil.com@169.254.169.254/',
  ])('refuses %s', (url) => {
    // Beyond being bad to store, `user@host` is parser confusion: the part a
    // human reads as the host is the username, and the real destination is
    // whatever follows the @.
    expect(code(url)).toBe('userinfo-present');
  });
});

describe('address literals', () => {
  it.each([
    '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1',
    '[::1]', '[::ffff:127.0.0.1]',
    '10.0.0.1', '192.168.1.1', '172.16.0.1',
  ])('refuses https://%s', (host) => {
    expect(code(`https://${host}/c.ics`)).toBe('ip-literal');
  });

  it.each(['169.254.169.254', '0xa9fea9fe', '[fe80::1]'])(
    'refuses %s as reserved space, with no flag that opens it',
    (host) => {
      // Reported as reserved rather than as an ordinary literal, so the
      // message never hints at an opt-in. There isn't one.
      expect(code(`https://${host}/c.ics`)).toBe('private-address');
    },
  );

  it('refuses a public address literal too', () => {
    // Not a security boundary on its own — 8.8.8.8 is harmless — but a feed
    // addressed numerically is never legitimate, and allowing public literals
    // would mean the rule depends on classification rather than shape.
    expect(code('https://8.8.8.8/c.ics')).toBe('ip-literal');
  });

  it('reports reserved space distinctly from an ordinary literal', () => {
    expect(code('https://240.0.0.1/c.ics')).toBe('private-address');
  });
});

describe('names that mean somewhere internal', () => {
  it.each([
    ['https://localhost/c.ics', 'loopback-name'],
    ['https://nas.local/c.ics', 'internal-suffix'],
    ['https://api.internal/c.ics', 'internal-suffix'],
    ['https://pi.home.arpa/c.ics', 'internal-suffix'],
    ['https://box.lan/c.ics', 'internal-suffix'],
    ['https://abc.onion/c.ics', 'internal-suffix'],
    ['https://nas/c.ics', 'bare-hostname'],
  ] as [string, string][])('%s is %s', (url, expected) => {
    expect(code(url)).toBe(expected);
  });

  it('refuses a trailing dot', () => {
    // The DNS root. It makes `evil.com.` a different string to `evil.com`
    // while resolving identically — enough to slip past a suffix check
    // somewhere downstream.
    expect(code('https://example.com./c.ics')).toBe('trailing-dot');
  });
});

describe('the self-host exception', () => {
  // Households legitimately point at Nextcloud or Immich on their own network.
  // Refusing that outright would make the product useless to the people it is
  // for — but it stays a per-source toggle, never a global relaxation.
  const lan: UrlPolicy = { allowPrivateNetwork: true, allowHttp: true };

  it('permits a LAN address and a bare hostname', () => {
    expect(code('http://192.168.1.50:8080/c.ics', lan)).toBe('OK');
    expect(code('http://nextcloud/c.ics', lan)).toBe('OK');
  });

  it.each([
    ['http://localhost/c.ics', 'loopback-name'],
    ['http://127.0.0.1/c.ics', 'ip-literal'],
    ['https://8.8.8.8/c.ics', 'ip-literal'],
    ['https://224.0.0.1/c.ics', 'private-address'],
    ['http://nas.local/c.ics', 'internal-suffix'],
  ] as [string, string][])('still refuses %s', (url, expected) => {
    // Opting into the LAN does not open the loopback interface, the public
    // internet by number, multicast, or mDNS.
    expect(code(url, lan)).toBe(expected);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/',
  ])('never permits %s under any policy', (url) => {
    // 169.254.169.254 is the cloud metadata endpoint and the single most
    // valuable thing an SSRF can reach. An earlier version of isLocalNetwork
    // treated the whole of link-local as "local", which meant enabling LAN
    // access for one feed opened it. No flag opens it now.
    for (const policy of [
      {},
      { allowHttp: true },
      { allowPrivateNetwork: true, allowHttp: true },
      { allowLoopback: true, allowHttp: true },
      { allowPrivateNetwork: true, allowLoopback: true, allowHttp: true },
    ] as UrlPolicy[]) {
      expect(code(url, policy)).not.toBe('OK');
    }
  });
});

describe('the loopback exception', () => {
  // Separate from the LAN flag on purpose. Home Assistant add-ons reach each
  // other over localhost, and a --network host deployment may have a service
  // bound only to 127.0.0.1 — but enabling LAN access should never imply it.
  const loop: UrlPolicy = { allowLoopback: true, allowHttp: true };

  it('permits loopback by name and by address', () => {
    expect(code('http://localhost/c.ics', loop)).toBe('OK');
    expect(code('http://127.0.0.1:8123/c.ics', loop)).toBe('OK');
  });

  it('does not imply LAN access', () => {
    expect(code('http://192.168.1.50/c.ics', loop)).toBe('ip-literal');
  });
});

describe('redirects', () => {
  const base = validateOutboundUrl('https://example.com/cal.ics');
  const from = base.ok ? base.value : undefined;

  it('revalidates the target', () => {
    // Following a redirect blindly is the standard bypass: the first request
    // goes somewhere harmless and the 302 points at the metadata endpoint.
    expect(validateRedirect('http://169.254.169.254/latest/meta-data/', from!).ok).toBe(false);
    expect(validateRedirect('https://localhost/x', from!).ok).toBe(false);
  });

  it('resolves a relative target against the current URL', () => {
    expect(validateRedirect('/other.ics', from!).ok).toBe(true);
  });

  it('detects leaving the origin, so credentials can be dropped', () => {
    const elsewhere = validateOutboundUrl('https://elsewhere.com/cal.ics');
    const sameHost = validateOutboundUrl('https://example.com/z.ics');
    expect(isCrossOrigin(from!, elsewhere.ok ? elsewhere.value : from!)).toBe(true);
    expect(isCrossOrigin(from!, sameHost.ok ? sameHost.value : from!)).toBe(false);
  });
});

describe('malformed input', () => {
  it.each(['', '   ', 'not a url', 'https://', '://x'])('never throws on %s', (bad) => {
    expect(() => validateOutboundUrl(bad)).not.toThrow();
    expect(code(bad)).not.toBe('OK');
  });

  it('refuses an absurdly long URL before parsing it', () => {
    expect(code(`https://${'a'.repeat(3000)}.com/`)).toBe('too-long');
  });
});
