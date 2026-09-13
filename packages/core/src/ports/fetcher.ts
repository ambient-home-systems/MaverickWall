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

export interface FetchRequest {
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
    };

/**
 * A POST of a JSON document, and the whole of what may be sent that way.
 *
 * Deliberately not `method` and `body` on `FetchRequest`. That is the smaller
 * diff and it quietly turns the one outbound boundary into a general-purpose
 * HTTP client — available to recipe modules, to catalogue entries, to anything
 * a household points at. The guard would still run, so it would not be a hole;
 * it would be a much larger surface, and it would cost a sentence worth more
 * than the lines it saves: **no arbitrary method and no household-authored body
 * reaches the network.** `fetch` stays GET-only so that stays true.
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
  /** Never throws. Every outcome is a value. */
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
} as const;
