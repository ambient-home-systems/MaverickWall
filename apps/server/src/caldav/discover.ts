import { FETCH_LIMITS, type Fetcher, type UrlPolicy } from '@maverick-wall/core';
import { decideHost, hostKey } from './host-policy.js';
import {
  CALDAV_NS,
  CALENDARSERVER_NS,
  DAV_NS,
  hrefIn,
  isCalendarCollection,
  prop,
  readMultistatus,
  type DavResponse,
} from './multistatus.js';

/**
 * The RFC 6764 / RFC 4791 discovery chain, run once at add time (RFC 013 §6.2).
 *
 * Four round trips before a single event:
 *
 * 1. `/.well-known/caldav`, **with no credential on it**, following the
 *    redirect that RFC 6764 §6 specifies, to learn the context path.
 * 2. `PROPFIND` there, `Depth: 0`, for `DAV:current-user-principal`.
 * 3. `PROPFIND` on the principal for `CALDAV:calendar-home-set`.
 * 4. `PROPFIND` on the home set, `Depth: 1`, for each collection's
 *    `resourcetype`, `displayname`, `supported-calendar-component-set` and
 *    `getctag`.
 *
 * On iCloud the home set lands on a per-account partition host —
 * `pNN-caldav.icloud.com` — so nothing about the address can be predicted and
 * the chain is not skippable. Sync afterwards is one `REPORT` per collection,
 * which is what turns four requests into a setup cost rather than a per-poll
 * one, and is the difference between CalDAV being viable here and not.
 *
 * **Never throws.** Every outcome is a value, including the one that stops the
 * chain to ask a question — `expandCalendar` and the Fetcher set that rule and
 * a household cannot read a stack trace.
 *
 * Two things are worth reading before changing anything here.
 *
 * **Step 1 carries no credential and that is free rather than careful.** The
 * well-known hop needs no authentication, so the host the chain moves to is
 * known *before* there is anything to lose — which is what makes §6.3.1's
 * confirmation possible at all rather than a thing asked after the fact. A 401
 * on that hop is a perfectly good answer: what is wanted from it is the address
 * it got to, and `FetchOutcome.failed` carries `finalUrl` for exactly that.
 *
 * **Every body is a module constant.** Nothing a household typed is
 * interpolated into XML anywhere in this file, which is the sentence
 * `FetchRequest.method`'s widening rests on.
 */

/** Where the household's address is, before anything has been discovered. */
export interface DiscoverInput {
  /** The address typed on the form: `https://caldav.icloud.com` or a full path. */
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
  /** The three per-source network opt-ins, as `connectionFor` builds them. */
  readonly policy: UrlPolicy;
  /**
   * A host the household has already been shown and accepted (§6.3.1). Absent
   * on the first submission, which is the whole point: the first run is what
   * discovers whether there is anything to ask about.
   */
  readonly confirmedHost?: string | null | undefined;
  /** Overridden by tests; the wire default is the Fetcher's own. */
  readonly timeoutMs?: number;
}

export interface DiscoveredCalendar {
  /** The collection URL, absolute, which is what gets stored and synced. */
  readonly url: string;
  /** `DAV:displayname`, or the last path segment when a server sends none. */
  readonly displayName: string;
  /** `CS:getctag`, when the server answers it. The conditional-sync marker. */
  readonly ctag?: string;
}

export type DiscoverFailureCode =
  /** The address is not a URL, or a hop answered one this policy cannot read. */
  | 'bad-address'
  /** Refused by the SSRF guard, at any hop. Carries the guard's own sentence. */
  | 'refused'
  /** Signed in and was told no. The commonest real failure. */
  | 'unauthorized'
  /** Reached something that is not a CalDAV server, or could not be read. */
  | 'not-caldav'
  /** Signed in fine, and the account has no calendars on it. */
  | 'no-calendars'
  /** The network, a timeout, a 5xx. Retryable. */
  | 'unreachable';

export type DiscoverResult =
  | {
      readonly status: 'ok';
      /** The principal URL, stored so a later re-discovery can skip two hops. */
      readonly principalUrl: string;
      readonly homeSetUrl: string;
      readonly calendars: readonly DiscoveredCalendar[];
    }
  /**
   * The chain wants to leave the host the household typed, and **the credential
   * has not been sent there**. The caller names this host on a confirmation
   * screen and re-runs discovery with it as `confirmedHost`.
   */
  | { readonly status: 'needs-confirmation'; readonly host: string }
  | {
      readonly status: 'failed';
      readonly code: DiscoverFailureCode;
      /** Written for somebody standing in a kitchen, per this repo's rule. */
      readonly message: string;
      /** Which of the four hops this was, for `diagnose-source`. */
      readonly stage: 'well-known' | 'principal' | 'home-set' | 'calendars';
    };

/** `PROPFIND Depth: 0`, asking who we are signed in as. */
const PRINCIPAL_BODY =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<D:propfind xmlns:D="DAV:">\n` +
  `  <D:prop>\n` +
  `    <D:current-user-principal/>\n` +
  `  </D:prop>\n` +
  `</D:propfind>\n`;

/** `PROPFIND Depth: 0` on the principal, asking where its calendars live. */
const HOME_SET_BODY =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\n` +
  `  <D:prop>\n` +
  `    <C:calendar-home-set/>\n` +
  `  </D:prop>\n` +
  `</D:propfind>\n`;

/** `PROPFIND Depth: 1` on the home set, asking what each collection is. */
const COLLECTIONS_BODY =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ` +
  `xmlns:CS="http://calendarserver.org/ns/">\n` +
  `  <D:prop>\n` +
  `    <D:resourcetype/>\n` +
  `    <D:displayname/>\n` +
  `    <C:supported-calendar-component-set/>\n` +
  `    <CS:getctag/>\n` +
  `  </D:prop>\n` +
  `</D:propfind>\n`;

/** The two a CalDAV server may answer with; they disagree about which. */
const XML_TYPES = ['application/xml', 'text/xml'] as const;

function basicAuthorization(username: string, password: string): string {
  // RFC 7617, UTF-8 — the same spelling and the same reasoning as
  // `connectionFor`'s, which is where the comment about it lives.
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

type Stage = 'well-known' | 'principal' | 'home-set' | 'calendars';

function failure(code: DiscoverFailureCode, message: string, stage: Stage): DiscoverResult {
  return { status: 'failed', code, message, stage };
}

/**
 * Resolve an href a server wrote against the request it answered.
 *
 * Servers answer with a path far more often than with an absolute URL, and
 * iCloud answers with both at different hops. `undefined` rather than a throw
 * for something that will not resolve at all.
 */
function absolute(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

/**
 * One PROPFIND, with the credential, and the one guard that is not the
 * Fetcher's.
 *
 * The host check runs **before the request is built**, so a hop that would
 * move the credential cannot have moved it by the time this returns. That
 * ordering is the whole of §6.3.1 and is the thing a refactor would quietly
 * lose by checking the answer instead of the question.
 */
async function propfind(
  fetcher: Fetcher,
  input: DiscoverInput,
  url: string,
  body: string,
  depth: '0' | '1',
  stage: Stage,
): Promise<
  | { readonly ok: true; readonly responses: readonly DavResponse[]; readonly finalUrl: string }
  | { readonly ok: false; readonly result: DiscoverResult }
> {
  const decision = decideHost({
    typedUrl: input.serverUrl,
    nextUrl: url,
    confirmedHost: input.confirmedHost,
  });
  if (decision.status === 'needs-confirmation') {
    return { ok: false, result: { status: 'needs-confirmation', host: decision.host } };
  }
  if (decision.status === 'unreadable') {
    return {
      ok: false,
      result: failure('bad-address', `That server pointed at an address we cannot read.`, stage),
    };
  }

  const outcome = await fetcher.fetch({
    url,
    policy: input.policy,
    method: 'PROPFIND',
    body,
    maxBytes: FETCH_LIMITS.dav,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    acceptContentTypes: [...XML_TYPES],
    headers: {
      authorization: basicAuthorization(input.username, input.password),
      depth,
    },
  });

  if (outcome.status === 'rejected') {
    return { ok: false, result: failure('refused', outcome.message, stage) };
  }
  if (outcome.status === 'not-modified') {
    // Unreachable: nothing here sends a conditional request. Stated as a value
    // rather than left to fall through, because a contract that never throws
    // cannot rely on a branch being impossible.
    return {
      ok: false,
      result: failure('not-caldav', 'The server answered 304 to a request that asked nothing.', stage),
    };
  }
  if (outcome.status === 'failed') {
    if (outcome.httpStatus === 401 || outcome.httpStatus === 403) {
      /*
       * Three causes and they are not one sentence, which is Phase A's own
       * lesson. `credentialsDropped` is what tells "that password was refused"
       * from "the right password never arrived", and the second is an address
       * problem wearing a password problem's clothes.
       */
      return {
        ok: false,
        result: failure(
          'unauthorized',
          outcome.credentialsDropped === true
            ? 'That server redirected to another address, which the sign-in details are not sent ' +
                'to. Use the address it redirected to.'
            : 'That username and password were not accepted.',
          stage,
        ),
      };
    }
    /*
     * A 4xx is not a broken network and must not be reported as one.
     *
     * `unreachable` is documented as retryable, and the sync job backs off on
     * it — so a 404 filed there is a collection that has moved being retried
     * every fifteen minutes for ever, with a household told to check their
     * connection. Anything below 500 is a fact about the *address*, which is
     * something they can act on.
     */
    const httpStatus = outcome.httpStatus;
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
      return {
        ok: false,
        result: failure(
          'not-caldav',
          `That address answered ${httpStatus}. It may not be a CalDAV server, or the calendar ` +
            `may have moved.`,
          stage,
        ),
      };
    }
    return { ok: false, result: failure('unreachable', outcome.message, stage) };
  }

  const document = readMultistatus(outcome.body);
  if (!document.ok) {
    return {
      ok: false,
      result: failure(
        'not-caldav',
        `That address did not answer with a calendar listing: ${document.error.message}`,
        stage,
      ),
    };
  }
  return { ok: true, responses: document.responses, finalUrl: outcome.finalUrl };
}

/** True when a collection says it holds `VEVENT`s, or says nothing at all. */
function holdsEvents(response: DavResponse): boolean {
  const components = prop(response, CALDAV_NS, 'supported-calendar-component-set');
  /*
   * **Absent means yes**, which is the same rule `show_in_grid` and every other
   * optional field in this product follows. The property is optional in RFC
   * 4791 §5.2.3 and a collection that does not answer it supports every
   * component — so refusing one would silently drop calendars off a server that
   * simply does not implement the property.
   */
  if (components === undefined || components.children.length === 0) return true;
  return components.children.some(
    (child) =>
      child.namespace === CALDAV_NS &&
      child.localName === 'comp' &&
      child.attributes['name'] === 'VEVENT',
  );
}

/** The last non-empty path segment, for a collection with no `displayname`. */
function nameFromHref(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter((part) => part !== '');
    return decodeURIComponent(segments[segments.length - 1] ?? '') || 'Calendar';
  } catch {
    return 'Calendar';
  }
}

/**
 * Run the chain.
 *
 * `fetcher` is the port rather than the adapter, so a test drives this against
 * a loopback server through the real guard — which is what `caldav-fake.ts`
 * does, because a stub cannot answer the one question this file exists to ask:
 * what did the *second* host receive.
 */
export async function discover(fetcher: Fetcher, input: DiscoverInput): Promise<DiscoverResult> {
  const typed = hostKey(input.serverUrl);
  if (typed === undefined) {
    return failure('bad-address', 'That is not an address we can read.', 'well-known');
  }

  /*
   * Step 1, unauthenticated. The only thing wanted from it is where it *got
   * to*, so a 401 is as good an answer as a 207 — and a rejection is not fatal
   * either, because plenty of servers do not implement `/.well-known/caldav`
   * at all and the address the household typed is then already the context
   * path. Failing the whole add here would refuse every self-hosted server
   * that has never heard of RFC 6764.
   */
  let contextUrl = input.serverUrl;
  const wellKnownUrl = absolute('/.well-known/caldav', input.serverUrl) ?? input.serverUrl;
  const wellKnown = await fetcher.fetch({
    url: wellKnownUrl,
    policy: input.policy,
    method: 'PROPFIND',
    body: PRINCIPAL_BODY,
    maxBytes: FETCH_LIMITS.dav,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    headers: { depth: '0' },
  });
  if (wellKnown.status === 'ok' || wellKnown.status === 'failed') {
    /*
     * A 401 here is as useful as a 207: what is wanted is where it *got to*,
     * which is why Phase A putting `finalUrl` on a failure matters to this file.
     *
     * **But only when it actually got somewhere else.** The paragraph above
     * says plenty of servers have never heard of RFC 6764 and that the typed
     * address is then already the context path — and the first version of this
     * adopted `finalUrl` unconditionally, so a server that simply answers 404
     * at `/.well-known/caldav` had *that dead path* taken as its context and
     * every later hop aimed at it. Every self-hosted server that does not
     * implement the well-known URI was refused with "it may not be a CalDAV
     * server", which is the precise failure the comment above says must not
     * happen.
     *
     * No fake could see it: a fake that models RFC 6764 redirects, and the
     * whole question is what happens when a server does not. Found by pointing
     * this at a real SabreDAV, which is the library Nextcloud's calendar is
     * built on, and which 404s that path unless somebody mounts a plugin for
     * it.
     *
     * So the test is *movement*: a redirect changes the URL, and a 404 in place
     * does not. Comparing against the address we asked for is what tells them
     * apart, and it needs no opinion about which status codes count.
     */
    const reached = wellKnown.finalUrl;
    const moved = reached !== undefined && reached !== wellKnownUrl;
    if (moved && hostKey(reached) !== undefined) contextUrl = reached;
  }

  /*
   * There is deliberately **no second host check here**, and the reason is
   * worth the lines it saves.
   *
   * A first draft repeated `decideHost` on what step 1 found, on the argument
   * that a well-known redirect leaving the typed host chooses where the
   * password goes just as much as `calendar-home-set` does two hops later.
   * True, and already handled: `propfind` runs the rule before it builds its
   * request, so the credentialled hop to `contextUrl` is checked whatever this
   * function does. Deleting the block turned no assertion red, which is this
   * repository's own test for a line that is not a fix.
   *
   * Its second branch was worse than redundant — it was unreachable.
   * `contextUrl` starts as an address `hostKey` has already read and is only
   * ever replaced by one `hostKey` can read, so `unreadable` could not happen,
   * and the fallback under it could never run.
   *
   * What is left is the property that matters: **one place applies the host
   * rule**, and it is the place that attaches the credential. Two readers of
   * one rule is the drift this repository's bug table is mostly made of.
   */

  // Step 2 — who are we?
  const principalHop = await propfind(
    fetcher,
    input,
    contextUrl,
    PRINCIPAL_BODY,
    '0',
    'principal',
  );
  if (!principalHop.ok) return principalHop.result;

  const principalHref = principalHop.responses
    .map((response) => hrefIn(response, DAV_NS, 'current-user-principal'))
    .find((href) => href !== undefined);
  if (principalHref === undefined) {
    return failure(
      'not-caldav',
      'That address answered, but did not say which account we are signed in as. It may not be ' +
        'a CalDAV server.',
      'principal',
    );
  }
  const principalUrl = absolute(principalHref, principalHop.finalUrl);
  if (principalUrl === undefined) {
    return failure('bad-address', 'That server named an account address we cannot read.', 'principal');
  }

  // Step 3 — where do its calendars live? This is the hop iCloud moves host on.
  const homeHop = await propfind(fetcher, input, principalUrl, HOME_SET_BODY, '0', 'home-set');
  if (!homeHop.ok) return homeHop.result;

  const homeHref = homeHop.responses
    .map((response) => hrefIn(response, CALDAV_NS, 'calendar-home-set'))
    .find((href) => href !== undefined);
  if (homeHref === undefined) {
    return failure(
      'not-caldav',
      'That account has no calendar home on this server.',
      'home-set',
    );
  }
  const homeSetUrl = absolute(homeHref, homeHop.finalUrl);
  if (homeSetUrl === undefined) {
    return failure('bad-address', 'That server named a calendar address we cannot read.', 'home-set');
  }

  // Step 4 — what is in it? `propfind` checks the host again before signing,
  // which is the check that stops here on iCloud's partition host.
  const collectionsHop = await propfind(
    fetcher,
    input,
    homeSetUrl,
    COLLECTIONS_BODY,
    '1',
    'calendars',
  );
  if (!collectionsHop.ok) return collectionsHop.result;

  const calendars: DiscoveredCalendar[] = [];
  for (const response of collectionsHop.responses) {
    if (!isCalendarCollection(response)) continue;
    if (!holdsEvents(response)) continue;
    const url = absolute(response.href, collectionsHop.finalUrl);
    if (url === undefined) continue;
    // The home set itself can come back in a `Depth: 1` listing, and on some
    // servers it is a calendar collection too. Dropping it by href keeps a
    // household from being offered their own container as a calendar.
    if (url.replace(/\/$/, '') === homeSetUrl.replace(/\/$/, '')) continue;

    const displayName = prop(response, DAV_NS, 'displayname')?.text ?? '';
    const ctag = prop(response, CALENDARSERVER_NS, 'getctag')?.text;
    calendars.push({
      url,
      displayName: displayName === '' ? nameFromHref(url) : displayName,
      ...(ctag !== undefined && ctag !== '' ? { ctag } : {}),
    });
  }

  if (calendars.length === 0) {
    /*
     * A distinct sentence rather than a failure to connect, and §6.7 is why:
     * *the address is fine and the password is wrong* is a completely different
     * thing from *you are signed in and that account has no calendars*, and
     * collapsing them reduces the best screen in the admin to the worst kind of
     * error.
     */
    return failure(
      'no-calendars',
      'Signed in, and that account has no calendars on it that hold events.',
      'calendars',
    );
  }

  return { status: 'ok', principalUrl, homeSetUrl, calendars };
}
