/**
 * OFFLINE TYPECHECK SHIM — NOT SHIPPED, NOT AUTHORITATIVE.
 * Stands in for the @maverick-wall/core workspace package, which is not built
 * in this environment. The real package's own types are the authority.
 */
declare module '@maverick-wall/core' {
  export interface ParsedIp { readonly version: 4 | 6; readonly bytes: readonly number[] }
  export function parseIp(text: string): ParsedIp | undefined;
  export function classifyIp(ip: ParsedIp): string;
  export function isLocalNetwork(ip: ParsedIp): boolean;
  export function formatIp(ip: ParsedIp): string;

  export interface UrlPolicy {
    readonly allowHttp?: boolean;
    readonly allowPrivateNetwork?: boolean;
    readonly allowLoopback?: boolean;
    readonly maxLength?: number;
  }
  export interface ValidatedUrl {
    readonly href: string;
    readonly protocol: 'http:' | 'https:';
    readonly hostname: string;
    readonly port: string;
    readonly isIpLiteral: boolean;
    readonly ip?: ParsedIp;
  }
  export interface UrlRejection { readonly code: string; readonly message: string }
  export type ValidateUrlResult =
    | { readonly ok: true; readonly value: ValidatedUrl }
    | { readonly ok: false; readonly error: UrlRejection };
  export function validateOutboundUrl(raw: string, policy?: UrlPolicy): ValidateUrlResult;
  export function validateRedirect(
    location: string, from: ValidatedUrl, policy?: UrlPolicy,
  ): ValidateUrlResult;
  export function isCrossOrigin(from: ValidatedUrl, to: ValidatedUrl): boolean;

  export type FetchRejectionCode =
    | 'url-rejected' | 'address-rejected' | 'dns-failed'
    | 'redirect-rejected' | 'too-many-redirects';
  export type FetchFailureCode =
    | 'timeout' | 'too-large' | 'unacceptable-content-type'
    | 'http-error' | 'network-error';

  export interface FetchRequest {
    readonly url: string;
    readonly policy: UrlPolicy;
    readonly maxBytes: number;
    readonly timeoutMs?: number;
    readonly acceptContentTypes?: readonly string[];
    readonly conditional?: { readonly etag?: string; readonly lastModified?: string };
    readonly headers?: Readonly<Record<string, string>>;
    readonly userAgent?: string;
  }
  export type FetchOutcome =
    | { readonly status: 'ok'; readonly body: string; readonly contentType: string;
        readonly etag?: string; readonly lastModified?: string;
        readonly finalUrl: string; readonly byteSize: number }
    | { readonly status: 'not-modified'; readonly etag?: string; readonly lastModified?: string }
    | { readonly status: 'rejected'; readonly code: FetchRejectionCode; readonly message: string }
    | { readonly status: 'failed'; readonly code: FetchFailureCode; readonly message: string;
        readonly httpStatus?: number; readonly retryAfterSeconds?: number };
  export interface Fetcher { fetch(request: FetchRequest): Promise<FetchOutcome> }
  export const FETCH_LIMITS: { ics: number; json: number; image: number };
}
