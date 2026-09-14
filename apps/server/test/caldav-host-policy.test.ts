import { describe, expect, it } from 'vitest';
import { decideHost, hostKey } from '../src/caldav/host-policy.js';

/**
 * The whole policy, read down at once (RFC 013 §6.3.1).
 *
 * `caldav-discover.test.ts` drives this through two real servers, which is what
 * proves the credential does not travel; this file is the *table* — every way
 * somebody might try to make a different host look like the same one, in one
 * place, where the rule can be checked against its own statement rather than
 * one case per round trip.
 *
 * That is the reason the policy is a pure module at all. It earned it
 * immediately: the "an address we cannot read is never a proceed" branch had no
 * case that could contradict it until this file existed — reverting it left the
 * driven tests entirely green, because a real server never answers with an href
 * a URL parser refuses.
 */

const TYPED = 'https://caldav.example.org/';

function decide(nextUrl: string, confirmedHost?: string | null) {
  return decideHost({ typedUrl: TYPED, nextUrl, ...(confirmedHost !== undefined ? { confirmedHost } : {}) });
}

describe('what counts as the same host', () => {
  it('is silent for the host the household typed, whatever else moved', () => {
    const same = [
      'https://caldav.example.org/',
      'https://caldav.example.org/dav/principals/jane/',
      // Case and a trailing dot are the same name to DNS and must be here too.
      'https://CALDAV.EXAMPLE.ORG/dav/',
      'https://caldav.example.org./dav/',
      // A scheme change is `allowHttp`'s question, per source, for every hop.
      // A second opinion here would be a second answer to a settled question.
      'http://caldav.example.org/dav/',
      // The default port written out is the same origin.
      'https://caldav.example.org:443/dav/',
    ];
    for (const url of same) {
      expect(decide(url), url).toEqual({ status: 'proceed' });
    }
  });

  it('stops for every way a host can differ', () => {
    const different: readonly string[] = [
      // The iCloud move this policy exists to permit-once.
      'https://p42-caldav.example.org/dav/',
      // A subdomain is not the site, and a parent is not either.
      'https://example.org/dav/',
      'https://caldav.example.org.evil.test/dav/',
      // Userinfo naming the typed host, which is the oldest trick in this list.
      'https://caldav.example.org@evil.test/dav/',
      // A port change. `isCrossOrigin` drops the credential across one, so a
      // policy that called it silent would be a second guard disagreeing with
      // the first about the same hop.
      'https://caldav.example.org:8443/dav/',
      // The address the name resolves to is not the name. The SSRF guard has
      // its own opinion about this one; so does this.
      'https://127.0.0.1/dav/',
      // A unicode lookalike. `URL` punycodes it, so what is compared is what
      // DNS will be asked for.
      'https://cаldav.example.org/dav/',
    ];
    for (const url of different) {
      const decision = decide(url);
      expect(decision.status, url).toBe('needs-confirmation');
      // And the host it names is the one it would have gone to, which is what
      // a household reads on the confirmation screen.
      expect(decision.status === 'needs-confirmation' && decision.host, url).toBe(
        hostKey(url),
      );
    }
  });
});

describe('an address that cannot be read', () => {
  it('is never a proceed', () => {
    /*
     * The direction rule nine takes everywhere else: a check that could not run
     * does not get to answer yes. It costs a household a sentence and it cannot
     * cost them a password.
     *
     * No real server answers with one of these, which is exactly why this
     * branch needs a table rather than a round trip — reverting it leaves every
     * driven test green.
     */
    for (const url of ['', 'not a url', '/dav/', 'https://', 'caldav.example.org']) {
      expect(decide(url).status, url).toBe('unreadable');
    }
  });

  it('is unreadable in both directions', () => {
    // A typed address this cannot read is the same refusal: comparing against
    // nothing would make every next host "different", which reads as a
    // confirmation screen for a form that should have been refused.
    expect(decideHost({ typedUrl: 'nonsense', nextUrl: 'https://example.org/' }).status).toBe(
      'unreadable',
    );
  });
});

describe('the stored confirmation', () => {
  it('proceeds to exactly the host it was given, and to no other', () => {
    expect(decide('https://p42-caldav.example.org/dav/', 'p42-caldav.example.org')).toEqual({
      status: 'proceed',
    });
    // A stored answer is about one destination. Treating it as a waiver would
    // let the *next* host a server nominates through silently.
    expect(decide('https://p99-caldav.example.org/dav/', 'p42-caldav.example.org').status).toBe(
      'needs-confirmation',
    );
  });

  it('normalises a stored value through the same function that produced it', () => {
    // A value written by an older shape, or by hand, cannot proceed on a
    // spelling the comparison would otherwise refuse — and cannot fail to
    // proceed on one it would otherwise accept.
    for (const stored of ['P42-CalDAV.example.org', 'p42-caldav.example.org.']) {
      expect(decide('https://p42-caldav.example.org/dav/', stored).status, stored).toBe('proceed');
    }
  });

  it('treats an absent or empty confirmation as none', () => {
    for (const stored of [null, undefined, '']) {
      expect(decide('https://p42-caldav.example.org/dav/', stored).status, String(stored)).toBe(
        'needs-confirmation',
      );
    }
  });

  it('does not let a stored host smuggle a port in', () => {
    // `hostKey` carries the port, so a confirmation for `example.org` is not a
    // confirmation for `example.org:8443`, and the reverse.
    expect(decide('https://p42-caldav.example.org:8443/dav/', 'p42-caldav.example.org').status).toBe(
      'needs-confirmation',
    );
    expect(decide('https://p42-caldav.example.org/dav/', 'p42-caldav.example.org:8443').status).toBe(
      'needs-confirmation',
    );
  });
});

describe('hostKey itself', () => {
  it('is what the policy compares, and carries the port and not the scheme', () => {
    expect(hostKey('https://Example.ORG./dav/')).toBe('example.org');
    expect(hostKey('http://example.org:8080/')).toBe('example.org:8080');
    expect(hostKey('https://example.org:443/')).toBe('example.org');
    expect(hostKey('http://example.org:80/')).toBe('example.org');
    expect(hostKey('https://xn--caldav-4za.example.org/')).toBe('xn--caldav-4za.example.org');
    for (const bad of ['', 'nope', 'https://', '//example.org']) {
      expect(hostKey(bad), bad).toBeUndefined();
    }
  });
});
