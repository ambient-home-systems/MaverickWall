import type { UrlPolicy } from '../net/url.js';

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
  | { readonly status: 'rejected'; readonly code: FetchRejectionCode; readonly message: string }
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

export interface Fetcher {
  /** Never throws. Every outcome is a value. */
  fetch(request: FetchRequest): Promise<FetchOutcome>;
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
