import type { NetworkOption, UrlPolicy } from '../net/url.js';

/**
 * The outbound HTTP boundary.
 *
 * Core defines this and never implements it: rule one keeps sockets out of the
 * pure packages. Everything that reaches the network — calendar feeds, weather,
 * Home Assistant, remote images — goes through one adapter, because a second
 * path to the network is a second place for the SSRF guard to be forgotten.
 */

export interface ConditionalRequest {
  readonly etag?: string;
  readonly lastModified?: string;
}

/**
 * The closed set of verbs this boundary will speak, and it is closed by the
 * type rather than by a check.
 *
 * A free string here would make the one guarded outbound path a general HTTP
 * client, available to recipe modules and to anything else a household points
 * at. A union of four is the same widening with that outcome unrepresentable:
 * `DELETE` is not a value anybody can pass, so no reviewer has to go looking
 * for the branch that would have refused it.
 *
 * `PROPFIND` and `REPORT` are WebDAV's two reads (RFC 4918 §9.1, RFC 4791 §7.1)
 * and both carry an XML body. They are reads in the sense that matters — they
 * ask a server what it holds and change nothing — which is why they follow a
 * redirect where `POST` does not. See `REDIRECT_POLICY`.
 */
export type FetchMethod = 'GET' | 'POST' | 'PROPFIND' | 'REPORT';

/**
 * Whether a method's request may be replayed at an address a server chose.
 *
 * Keyed by method, in the port, and deliberately **not** a flag a call site
 * passes. A caller that could choose would be a caller that could get it wrong,
 * and the way it gets wrong is a credentialled `POST` replayed somewhere we did
 * not intend — which is the property RFC 012's `postJson` was built around and
 * is not a decision to re-take per call.
 *
 * `GET` and `PROPFIND` follow because both are the first hop of a discovery
 * that is *specified* as a redirect: RFC 6764 §6 defines `/.well-known/caldav`
 * as a 301/303/307 to the context path, so a CalDAV client that refuses one
 * cannot reach iCloud or Nextcloud at all. `POST` and `REPORT` refuse: a
 * `REPORT` is issued only against a collection this application has already
 * discovered and stored, so a 3xx off it is a misconfiguration or an attack and
 * there is no third reading to preserve.
 *
 * Following is still bounded and still revalidated per hop, and
 * `authorization` is still dropped across an origin change — following is not
 * trusting.
 */
export const REDIRECT_POLICY: Readonly<Record<FetchMethod, 'follow' | 'refuse'>> = {
  GET: 'follow',
  PROPFIND: 'follow',
  POST: 'refuse',
  REPORT: 'refuse',
} as const;

/** The three verbs that carry a body. `GET` is the fourth method and has none. */
export type BodyMethod = Exclude<FetchMethod, 'GET'>;

interface FetchRequestCommon {
  readonly url: string;
  readonly policy: UrlPolicy;
  /**
   * Hard ceiling on the response body. Enforced while streaming, not after:
   * a `Content-Length` header is a claim, not a promise.
   */
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  /**
   * Accepted content types, matched on the media type alone. Empty means
   * anything. Every call site states its own, because "it parsed" is not the
   * same as "the server sent what we asked for".
   */
  readonly acceptContentTypes?: readonly string[];
  readonly conditional?: ConditionalRequest;
  readonly headers?: Readonly<Record<string, string>>;
  /** Identifies us to upstreams. Politeness, and it keeps NWS happy. */
  readonly userAgent?: string;
}

/**
 * A request, as a union of "a GET, which has no body" and "a verb that does".
 *
 * `method` defaults to `GET`, so every call site written before this field
 * existed means exactly what it meant then and none of them changed.
 *
 * The union is doing one job and it is the same one `FeedPassword` does next
 * door: a GET carrying a body is a mistake, and two members of a union is the
 * same information with the mistake deleted. The alternative — one interface
 * and an adapter that refuses the combination — needs an outcome code for a
 * caller's bug, and there is no honest one: it is not a bad URL, not a bad
 * address and not a broken network. It is also a bug this project would
 * otherwise have to *discover*, because an intermediary that drops a GET's body
 * does so silently, and a request that arrives without the body it was built
 * with is worse than one that never left.
 *
 * What this does **not** widen is worth stating where the field is. A body is
 * built from a first-party template and validated ids, and nothing in this
 * repository composes one from a form — so the sentence that survives RFC 013
 * §6.3 is the narrower one, *no household-authored body reaches the network*.
 * That is a property of the call sites rather than of this type, which is why
 * `caldav/query.ts` and `caldav/discover.ts` keep their templates as module
 * constants rather than accepting XML from anywhere.
 */
export type FetchRequest = FetchRequestCommon &
  (
    | { readonly method?: 'GET'; readonly body?: never }
    /**
     * Sent as `application/xml; charset=utf-8`. Optional because a bodyless
     * `PROPFIND` is legal and means `allprop` (RFC 4918 §9.1); nothing here
     * sends one, and a server that only answers `allprop` is a server this
     * reader would have to grow a second shape for.
     */
    | { readonly method: BodyMethod; readonly body?: string }
  );

export type FetchRejectionCode =
  /** Blocked before any packet was sent. Carries the URL guard's own code. */
  | 'url-rejected'
  /** The name resolved to somewhere we refuse to talk to. */
  | 'address-rejected'
  /** Resolution itself failed. */
  | 'dns-failed'
  /** More hops than allowed, or a redirect to somewhere refused. */
  | 'redirect-rejected'
  | 'too-many-redirects';

export type FetchFailureCode =
  | 'timeout'
  | 'too-large'
  | 'unacceptable-content-type'
  | 'http-error'
  | 'network-error';

export type FetchOutcome =
  | {
      readonly status: 'ok';
      readonly body: string;
      readonly contentType: string;
      readonly etag?: string;
      readonly lastModified?: string;
      /** After redirects. May differ from the requested URL. */
      readonly finalUrl: string;
      readonly byteSize: number;
    }
  /** Conditional request matched. Nothing changed upstream. */
  | { readonly status: 'not-modified'; readonly etag?: string; readonly lastModified?: string }
  /**
   * Refused by policy. Distinct from a failure: this is not retryable and
   * usually means a misconfigured source rather than a broken network.
   */
  | {
      readonly status: 'rejected';
      readonly code: FetchRejectionCode;
      readonly message: string;
      /**
       * The opt-ins that would let this destination through, when there are
       * any. Only DNS can answer for a name that *resolves* somewhere private,
       * so the adapter that resolved it is the only thing that can say — and a
       * form is otherwise left naming a remedy it cannot point at. Absent means
       * no switch would help; it never means the address was acceptable.
       */
      readonly networkOptions?: readonly NetworkOption[];
    }
  /** The attempt was legitimate and did not work. Retryable with backoff. */
  | {
      readonly status: 'failed';
      readonly code: FetchFailureCode;
      readonly message: string;
      /** Present for `http-error`. */
      readonly httpStatus?: number;
      /** Honoured for 429 and 503, so backoff respects the upstream. */
      readonly retryAfterSeconds?: number;
      /**
       * The address that actually answered, after redirects. Absent when
       * nothing was reached.
       *
       * The `ok` variant has always carried this; a failure needs it for the
       * same reason and for one case in particular — see below.
       */
      readonly finalUrl?: string;
      /**
       * True when a hop to another origin stripped an `authorization` (or
       * another sensitive header) the caller had supplied.
       *
       * Without this, a household who typed the *right* password sees the
       * identical "that password was not accepted" sentence a household who
       * typed the wrong one sees — because `isCrossOrigin` treats a protocol
       * change on the same hostname as cross-origin, so a server redirecting
       * its own `http://` to `https://` gets a second request with no
       * credential on it and answers 401 to that. The remedy the sentence
       * implies is to retype a password that was never the problem.
       *
       * So this is what lets a diagnosis point at the *address* instead
       * (RFC 013 §4.4). Absent means no credential was dropped; it never means
       * none was sent.
       */
      readonly credentialsDropped?: boolean;
    };

/**
 * A POST of a JSON document, and the whole of what may be sent that way.
 *
 * **This is `fetch` with the method fixed to `POST`, and it is kept as its own
 * entry point rather than folded into it.** RFC 013 §6.3 widened `fetch` to
 * carry a method and a body, which is most of what this interface was for — so
 * the honest reading of these two now is that `postJson` is the narrower one:
 * it serialises the body itself (a caller cannot hand over text claiming to be
 * JSON), it fixes both content types, it sends no conditional request, and it
 * keeps a non-2xx body as the upstream's own diagnosis. `fetch` does none of
 * those four. Collapsing them would mean a JSON POST whose body a caller
 * composed as a string, which is exactly the thing `ha-write-boundary.test.ts`
 * holds to one function.
 *
 * What has *not* survived the widening is the sentence this docstring used to
 * end with — "`fetch` stays GET-only so that stays true". `fetch` is no longer
 * GET-only. The narrower claim that is still true, and is the one to defend, is
 * that **no household-authored body reaches the network**: every body any
 * method sends is built from a first-party template in this repository. That is
 * a property of the call sites rather than of this type, and RFC 013 §6.3 says
 * so at `FetchRequest.method`.
 *
 * There is no `conditional` and no `acceptContentTypes` here. It always sends
 * `accept: application/json` and `content-type: application/json`, because that
 * is the whole of what it is for, and a call site that could vary either is a
 * call site that could send something else.
 */
export interface PostJsonRequest {
  readonly url: string;
  readonly policy: UrlPolicy;
  /** As on `FetchRequest`: enforced while streaming, not after. */
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Identifies us to upstreams. Politeness, and it keeps NWS happy. */
  readonly userAgent?: string;
  /**
   * A JSON-serialisable document. **The adapter serialises it** — no caller
   * hands over text, so no caller can hand over something that is not JSON
   * while the headers say it is.
   */
  readonly body: unknown;
}

/**
 * `FetchOutcome` with two differences, and both are the point.
 *
 * There is no `not-modified`: nothing here sends a conditional request, so
 * nothing can answer one.
 *
 * And `http-error` carries the response body. Home Assistant answers a refused
 * service call with `{"message": "..."}`, and that sentence is the difference
 * between something somebody standing in a kitchen can act on and a bare `400`.
 * `fetch` throws a non-2xx body away by design, because a dead feed's HTML
 * error page is noise; here it is the diagnosis.
 */
export type PostJsonOutcome =
  | {
      readonly status: 'ok';
      readonly body: string;
      readonly contentType: string;
      /** No redirect is ever followed, so this is always the requested URL. */
      readonly finalUrl: string;
      readonly byteSize: number;
    }
  /** Refused by policy, and — unlike `fetch` — that includes any redirect. */
  | {
      readonly status: 'rejected';
      readonly code: FetchRejectionCode;
      readonly message: string;
      /** As on `FetchOutcome`: only DNS can answer for a name that resolves private. */
      readonly networkOptions?: readonly NetworkOption[];
    }
  | {
      readonly status: 'failed';
      readonly code: FetchFailureCode;
      readonly message: string;
      /** Present for `http-error`. */
      readonly httpStatus?: number;
      readonly retryAfterSeconds?: number;
      /**
       * The upstream's own words, for `http-error` only, capped by `maxBytes`
       * like any other body — an error body is still a stranger's bytes.
       */
      readonly responseBody?: string;
    };

export interface Fetcher {
  /**
   * Never throws. Every outcome is a value.
   *
   * `method` defaults to `GET` and whether a redirect is followed is decided
   * from `REDIRECT_POLICY` by the method, never by the caller — see both for
   * why that is a table rather than a flag.
   */
  fetch(request: FetchRequest): Promise<FetchOutcome>;
  /**
   * Never throws either, and **never follows a redirect**.
   *
   * `fetch` follows up to three, revalidating each hop and stripping
   * `authorization` across origins, which is right for a feed that has moved.
   * A POST is not a feed: following one replays a request with a body and a
   * bearer token somewhere we did not intend. The only host this will ever
   * speak to is the household's own Home Assistant, so a 3xx off it is either a
   * misconfiguration or an attack, and there is no third reading to preserve.
   * Any 3xx is `rejected('redirect-rejected', …)` — a rejection rather than a
   * failure because it is not retryable and names a bad address rather than a
   * broken network.
   */
  postJson(request: PostJsonRequest): Promise<PostJsonOutcome>;
}

/** Sizes are stated per call site rather than shared, so one cannot creep. */
export const FETCH_LIMITS = {
  /** ICS feeds. A 3.2MB export of a decade of events fits comfortably. */
  ics: 5 * 1024 * 1024,
  /** JSON APIs: weather, alerts, Home Assistant. */
  json: 2 * 1024 * 1024,
  /** Remote images. */
  image: 10 * 1024 * 1024,
  /**
   * WebDAV `multistatus` documents: the discovery chain and one `REPORT`.
   *
   * Its own ceiling rather than a share of `ics`, because the two documents
   * have nothing to do with each other — an ICS export is a decade of one
   * household's events and a multistatus is a list of collections or of one
   * window's resources. 1 MB is generous for both: a hundred-resource
   * `calendar-query` carrying whole `VCALENDAR` bodies is tens of kilobytes,
   * and a home set with eight calendars in it is single figures.
   *
   * The point of a smaller number is that the ceiling is enforced while
   * streaming, so it is the only thing standing between a hostile server and
   * an unbounded read — and `caldav/multistatus.ts` is a parser with a depth
   * cap above it whose first defence is never being handed the bytes.
   */
  dav: 1024 * 1024,
} as const;
