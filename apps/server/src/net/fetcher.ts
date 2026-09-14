import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  classifyIp,
  formatIp,
  isCrossOrigin,
  isLocalNetwork,
  parseIp,
  validateOutboundUrl,
  validateRedirect,
  type FetchFailureCode,
  type FetchOutcome,
  type FetchRejectionCode,
  type FetchRequest,
  type Fetcher,
  type NetworkOption,
  type PostJsonOutcome,
  type PostJsonRequest,
  type UrlPolicy,
  type ValidatedUrl,
} from '@maverick-wall/core';

/**
 * The second SSRF gate, and the one that matters.
 *
 * `validateOutboundUrl` sees only what is written in the URL. It cannot catch
 * `evil.com` resolving to `127.0.0.1`, because nothing in the string gives that
 * away. So this adapter resolves the name itself, checks every address it gets
 * back, and then — the important part — **connects to the address it checked**
 * rather than to the hostname.
 *
 * Resolving, checking, and then handing the hostname to the socket layer would
 * leave a window between the two lookups in which DNS can answer differently.
 * That window is the whole of the DNS rebinding attack, and it is not
 * theoretical: the standard exploit is a name with a one-second TTL that
 * answers publicly on the first query and 169.254.169.254 on the second.
 *
 * Pinning is done with the `lookup` option, which lets us supply the answer
 * instead of asking again. The Host header and TLS SNI still carry the real
 * hostname, so certificate validation is unaffected.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/**
 * Sent on every outbound request unless a call site overrides it.
 *
 * Exported because api.weather.gov *rejects* a request with no descriptive
 * agent naming the application and a contact — so this is a functional
 * requirement rather than politeness, and a second copy of the string
 * somewhere else is a version bump away from one of them being wrong.
 */
export const DEFAULT_USER_AGENT =
  'MaverickWall/0.1 (+https://github.com/ambient-home-systems/MaverickWall)';

/** Headers that must not survive a hop to another origin. */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-api-key'];

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Everything one hop can produce, before either entry point narrows it.
 *
 * `fetch` and `postJson` answer with different unions — there is no
 * `not-modified` for a POST, and only a POST keeps a non-2xx body — but one
 * function owns the socket, so one type has to cover both. It is assignable to
 * `FetchOutcome` (the extra `responseBody` is optional and `fetch` never asks
 * for it) and narrows to `PostJsonOutcome` by dropping the one case a POST
 * cannot reach.
 */
type WireOutcome =
  | {
      readonly status: 'ok';
      readonly body: string;
      readonly contentType: string;
      readonly finalUrl: string;
      readonly byteSize: number;
      readonly etag?: string;
      readonly lastModified?: string;
    }
  | { readonly status: 'not-modified'; readonly etag?: string; readonly lastModified?: string }
  | {
      readonly status: 'rejected';
      readonly code: FetchRejectionCode;
      readonly message: string;
      readonly networkOptions?: readonly NetworkOption[];
    }
  | {
      readonly status: 'failed';
      readonly code: FetchFailureCode;
      readonly message: string;
      readonly httpStatus?: number;
      readonly retryAfterSeconds?: number;
      readonly responseBody?: string;
      readonly finalUrl?: string;
      readonly credentialsDropped?: boolean;
    };

function rejected(
  code: FetchRejectionCode,
  message: string,
  networkOptions: readonly NetworkOption[] = [],
): WireOutcome {
  return {
    status: 'rejected',
    code,
    message,
    ...(networkOptions.length > 0 ? { networkOptions } : {}),
  };
}

interface FailureExtras {
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  /** The upstream's own words. Only ever set for a POST — see `keepErrorBody`. */
  readonly responseBody?: string;
}

/**
 * A socket error, written for someone standing in a kitchen.
 *
 * Node reports these as `connect ECONNREFUSED 127.0.0.1:8443` — an errno and a
 * socket address, which is a diagnosis for us and noise on a settings page.
 * That text was reaching the wizard's calendar step and the Calendars card's
 * "Last sync failed" verbatim. Keyed on the error code, never the message text
 * (the same rule the gzip branch below follows); a code this map does not know
 * keeps Node's own message, which is then the most diagnosable thing we hold.
 */
function networkErrorMessage(error: Error): string {
  switch ((error as NodeJS.ErrnoException).code) {
    case 'ECONNREFUSED':
      return 'The connection was refused — nothing is listening at that address and port.';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'The connection was cut off before the response arrived.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return 'That address cannot be reached from this machine.';
    default:
      return error.message;
  }
}

function failed(code: FetchFailureCode, message: string, extras: FailureExtras = {}): WireOutcome {
  return {
    status: 'failed',
    code,
    message,
    ...(extras.httpStatus !== undefined ? { httpStatus: extras.httpStatus } : {}),
    ...(extras.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: extras.retryAfterSeconds }
      : {}),
    ...(extras.responseBody !== undefined ? { responseBody: extras.responseBody } : {}),
  };
}

/** Node types a header as `string | string[]`; only the first value matters here. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Resolve, and refuse anything we would not talk to.
 *
 * `all: true` matters: a name can carry several A records, and checking only
 * the first leaves the rest unexamined. Every returned address has to pass,
 * because we do not control which one a retry would pick.
 */
async function resolveAndCheck(
  hostname: string,
  policy: UrlPolicy,
): Promise<{ ok: true; addresses: ResolvedAddress[] } | { ok: false; outcome: WireOutcome }> {
  const literal = parseIp(hostname);
  if (literal) {
    // Already an address; the URL guard has decided whether it is allowed.
    return {
      ok: true,
      addresses: [{ address: formatIp(literal), family: literal.version }],
    };
  }

  let records: { address: string; family: number }[];
  try {
    records = await new Promise((resolve, reject) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (error, result) => {
        if (error) reject(error);
        else resolve(result as { address: string; family: number }[]);
      });
    });
  } catch (error) {
    return {
      ok: false,
      outcome: rejected(
        'dns-failed',
        `Could not look up ${hostname}: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
    };
  }

  if (records.length === 0) {
    return { ok: false, outcome: rejected('dns-failed', `${hostname} did not resolve.`) };
  }

  const addresses: ResolvedAddress[] = [];
  for (const record of records) {
    const ip = parseIp(record.address);
    if (!ip) {
      return {
        ok: false,
        outcome: rejected('address-rejected', `${hostname} resolved to an unreadable address.`),
      };
    }

    const kind = classifyIp(ip);
    const permitted =
      kind === 'public' ||
      (policy.allowPrivateNetwork === true && isLocalNetwork(ip)) ||
      (policy.allowLoopback === true && kind === 'loopback');

    if (!permitted) {
      // Deliberately names the address. A household debugging why their
      // Nextcloud feed will not load needs to see that it resolved to a LAN
      // address, and the hostname is theirs already.
      return {
        ok: false,
        outcome: rejected(
          'address-rejected',
          // The diagnosis only. The remedy names a checkbox, and this file has
          // no idea what that checkbox is called — `http/html.ts` composes it
          // from `networkOptions` below, out of the same table that renders it.
          `${hostname} resolves to ${formatIp(ip)}, which is ${kind}.` +
            (isLocalNetwork(ip) || kind === 'loopback'
              ? ''
              : ' That is not a reachable public address.'),
          // The URL gate could not have known this: the name looks public and
          // only the resolver says otherwise. Naming the switch here is what
          // lets the form that shows this message also show the control.
          isLocalNetwork(ip)
            ? ['allowPrivateNetwork']
            : kind === 'loopback'
              ? ['allowLoopback']
              : [],
        ),
      };
    }

    addresses.push({ address: record.address, family: record.family === 6 ? 6 : 4 });
  }

  return { ok: true, addresses };
}

/**
 * A `lookup` implementation that returns a fixed answer.
 *
 * This is the pin. The socket layer never performs its own resolution, so the
 * address that was checked is the address that is connected to.
 */
function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  const first = addresses[0]!;
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      error: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all === true) {
      callback(
        null,
        addresses.map((entry) => ({ address: entry.address, family: entry.family })),
      );
    } else {
      callback(null, first.address, first.family);
    }
  };
}

/**
 * Decompress a response body.
 *
 * Announcing `accept-encoding` without decoding the result is a silent
 * corruption: `node:http` does not decompress, and calling `toString('utf8')`
 * on gzip bytes destroys them irreversibly — the magic number 1f 8b becomes
 * 1f ef bf bd and nothing downstream can tell what happened. It surfaced as a
 * calendar that would not parse, with no indication why.
 *
 * `maxOutputLength` is the defence against a compression bomb: a few hundred
 * kilobytes that expand to gigabytes. Capping only the compressed size would
 * not help, because the whole point of the attack is the ratio.
 */
function decodeBody(
  raw: Buffer,
  encoding: string | undefined,
  maxBytes: number,
): { ok: true; body: Buffer } | { ok: false; reason: 'too-large' | 'corrupt' } {
  const scheme = (encoding ?? '').trim().toLowerCase();
  if (scheme === '' || scheme === 'identity') return { ok: true, body: raw };

  try {
    const options = { maxOutputLength: maxBytes };
    if (scheme === 'gzip' || scheme === 'x-gzip') {
      return { ok: true, body: gunzipSync(raw, options) };
    }
    if (scheme === 'deflate') {
      return { ok: true, body: inflateSync(raw, options) };
    }
    if (scheme === 'br') {
      // Not advertised, but honoured if a server sends it anyway.
      return { ok: true, body: brotliDecompressSync(raw, options) };
    }
  } catch (error) {
    // Distinguished by error code rather than message text. Node reports an
    // exceeded maxOutputLength as ERR_BUFFER_TOO_LARGE and malformed input as
    // Z_DATA_ERROR; matching on wording would break on a Node upgrade and, more
    // to the point, was already wrong.
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'corrupt' };
  }

  // An encoding we do not understand. Better to say so than to hand the caller
  // bytes it will misread as text.
  return { ok: false, reason: 'corrupt' };
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  return undefined;
}

interface SingleRequestResult {
  readonly kind: 'done';
  readonly outcome: WireOutcome;
}

interface RedirectResult {
  readonly kind: 'redirect';
  readonly location: string;
}

/**
 * One request's shape, normalised, so one function owns the socket.
 *
 * `fetch` and `postJson` differ in five things and share everything else — the
 * URL guard, the resolve-and-check, the pin, the timeout, the streamed byte
 * ceiling and the decompression. Forking `performRequest` into a second copy
 * would put all six of those in two places, and the SSRF guard being forgotten
 * in one of two places is the whole reason there is one adapter at all.
 */
interface WireRequest {
  readonly method: 'GET' | 'POST';
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  readonly acceptContentTypes?: readonly string[];
  /**
   * Whether this request carried `if-none-match`/`if-modified-since`.
   *
   * A 304 is only an answer to a question that was asked. Unprompted it is a
   * broken server, and reading it as "nothing changed" would hand a caller a
   * `not-modified` for a request that could not produce one.
   */
  readonly conditional: boolean;
  /** Follow a 3xx, revalidating each hop, or refuse it outright. */
  readonly followRedirects: boolean;
  /** Serialised body. Absent for a GET, and a GET is the only thing without one. */
  readonly body?: Buffer;
  /** Keep a non-2xx body as the upstream's own diagnosis. See `readErrorBody`. */
  readonly keepErrorBody: boolean;
}

/**
 * Read a non-2xx body, truncating rather than refusing.
 *
 * The success path treats an oversized body as `too-large`, which is right
 * there: a caller asked for that document and half of it is worse than none.
 * Here the document *is* the diagnosis — `{"message": "..."}` from Home
 * Assistant — and a truncated sentence still diagnoses, so the cap clips
 * instead of failing the call that already failed. It is still a cap: an error
 * body is a stranger's bytes like any other.
 *
 * A body we cannot decompress yields nothing rather than mojibake, for the same
 * reason `decodeBody` refuses an encoding it does not know: handing back bytes
 * a caller will misread as text is worse than handing back silence.
 */
function readErrorBody(
  response: NodeJS.ReadableStream & { destroy(): void; headers: Record<string, string | string[] | undefined> },
  maxBytes: number,
  done: (text: string | undefined) => void,
): void {
  const chunks: Buffer[] = [];
  let received = 0;
  let stopped = false;

  const finishRead = (): void => {
    if (stopped) return;
    stopped = true;
    const decoded = decodeBody(
      Buffer.concat(chunks),
      headerValue(response.headers['content-encoding']),
      maxBytes,
    );
    done(decoded.ok ? decoded.body.toString('utf8') : undefined);
  };

  response.on('data', (chunk: Buffer) => {
    if (stopped) return;
    if (received + chunk.length >= maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - received)));
      response.destroy();
      finishRead();
      return;
    }
    received += chunk.length;
    chunks.push(chunk);
  });
  response.on('end', finishRead);
  response.on('error', () => {
    if (stopped) return;
    stopped = true;
    done(undefined);
  });
}

async function performRequest(
  target: ValidatedUrl,
  addresses: readonly ResolvedAddress[],
  request: WireRequest,
  headers: Record<string, string>,
): Promise<SingleRequestResult | RedirectResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SingleRequestResult | RedirectResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const url = new URL(target.href);
    const clientRequest = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        // The pin.
        lookup: pinnedLookup(addresses) as never,
        // Redirects are handled here so each hop can be revalidated.
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status === 304 && request.conditional) {
          response.resume();
          const etag = headerValue(response.headers.etag);
          const lastModified = headerValue(response.headers['last-modified']);
          finish({
            kind: 'done',
            outcome: {
              status: 'not-modified',
              ...(typeof etag === 'string' ? { etag } : {}),
              ...(typeof lastModified === 'string' ? { lastModified } : {}),
            },
          });
          return;
        }

        // 304 is excluded: it is not a redirect, and unprompted it falls
        // through to the generic non-2xx below rather than being reported as
        // one somebody could follow.
        if (status >= 300 && status < 400 && status !== 304) {
          const location = headerValue(response.headers.location);
          if (!request.followRedirects) {
            /*
             * Refused here rather than one hop later, and refused before the
             * body is read.
             *
             * A redirect is a request replayed at another address, and this
             * one carries a body and a bearer token. The only host a POST from
             * this application ever speaks to is the household's own Home
             * Assistant, so a 3xx off it is a misconfiguration or an attack and
             * there is no third reading worth preserving. `rejected` rather
             * than `failed` because it is not retryable and names a bad
             * address rather than a broken network.
             */
            response.resume();
            finish({
              kind: 'done',
              outcome: rejected(
                'redirect-rejected',
                `The server answered ${status} with a redirect. A POST is never replayed at ` +
                  `another address.`,
              ),
            });
            return;
          }
          response.resume();
          if (typeof location !== 'string' || location === '') {
            finish({
              kind: 'done',
              outcome: failed('http-error', `Redirect with no destination.`, { httpStatus: status }),
            });
            return;
          }
          finish({ kind: 'redirect', location });
          return;
        }

        if (status < 200 || status >= 300) {
          const retryAfter = parseRetryAfter(headerValue(response.headers['retry-after']));
          const extras = {
            httpStatus: status,
            ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
          };
          if (!request.keepErrorBody) {
            response.resume();
            finish({
              kind: 'done',
              outcome: failed('http-error', `The server answered ${status}.`, extras),
            });
            return;
          }
          readErrorBody(response as never, request.maxBytes, (text) => {
            finish({
              kind: 'done',
              outcome: failed('http-error', `The server answered ${status}.`, {
                ...extras,
                ...(text !== undefined && text !== '' ? { responseBody: text } : {}),
              }),
            });
          });
          return;
        }

        const accepted = request.acceptContentTypes ?? [];
        const type = mediaType(headerValue(response.headers['content-type']));
        if (accepted.length > 0 && !accepted.includes(type)) {
          // A dead feed URL answers with an HTML error page far more often
          // than it 404s. Checking the type turns a confusing parse failure
          // into an accurate message.
          response.destroy();
          finish({
            kind: 'done',
            outcome: failed(
              'unacceptable-content-type',
              `Expected ${accepted.join(' or ')} but the server sent ${type || 'nothing'}.`,
            ),
          });
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > request.maxBytes) {
            // Enforced while streaming. Content-Length is a claim, not a
            // promise, and a hostile server can simply keep sending.
            response.destroy();
            finish({
              kind: 'done',
              outcome: failed(
                'too-large',
                `The response is larger than ${Math.round(request.maxBytes / 1024 / 1024)} MB.`,
              ),
            });
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          const decoded = decodeBody(
            Buffer.concat(chunks),
            headerValue(response.headers['content-encoding']),
            request.maxBytes,
          );

          if (!decoded.ok) {
            finish({
              kind: 'done',
              outcome:
                decoded.reason === 'too-large'
                  ? failed(
                      'too-large',
                      `The response expands to more than ${Math.round(request.maxBytes / 1024 / 1024)} MB.`,
                    )
                  : failed(
                      'network-error',
                      'The response was compressed in a way we could not read.',
                    ),
            });
            return;
          }

          const etag = headerValue(response.headers.etag);
          const lastModified = headerValue(response.headers['last-modified']);
          finish({
            kind: 'done',
            outcome: {
              status: 'ok',
              body: decoded.body.toString('utf8'),
              contentType: type,
              finalUrl: target.href,
              // The decompressed size, which is what a caller cares about.
              byteSize: decoded.body.length,
              ...(typeof etag === 'string' ? { etag } : {}),
              ...(typeof lastModified === 'string' ? { lastModified } : {}),
            },
          });
        });

        response.on('error', (error) => {
          finish({ kind: 'done', outcome: failed('network-error', networkErrorMessage(error)) });
        });
      },
    );

    clientRequest.on('timeout', () => {
      clientRequest.destroy();
      finish({
        kind: 'done',
        outcome: failed('timeout', `No response within ${timeoutMs / 1000} seconds.`),
      });
    });

    clientRequest.on('error', (error) => {
      finish({ kind: 'done', outcome: failed('network-error', networkErrorMessage(error)) });
    });

    // `end(body)` rather than a write-then-end: the body is one already-encoded
    // buffer whose length the headers have already stated, so there is nothing
    // to stream and nothing that can disagree with `content-length`.
    if (request.body !== undefined) clientRequest.end(request.body);
    else clientRequest.end();
  });
}

export function createFetcher(): Fetcher {
  return {
    /**
     * GET, and **only** GET.
     *
     * There is deliberately no `method` and no `body` on `FetchRequest`, so the
     * sentence this boundary is worth keeping stays true: **no arbitrary method
     * and no household-authored body reaches the network.** Every user-supplied
     * URL in this product — calendar feeds, remote images, recipe modules,
     * catalogue sources — arrives here, and every one of them is a read.
     *
     * `postJson` below is the one exception and it is not a general one: fixed
     * verb, fixed content type, a body the adapter serialises, and no redirect
     * followed. Its only caller is the Home Assistant client's `callService`,
     * which is held to a two-member allowlist by `ha-write-boundary.test.ts`.
     */
    async fetch(request: FetchRequest): Promise<FetchOutcome> {
      try {
        const validated = validateOutboundUrl(request.url, request.policy);
        if (!validated.ok) {
          return rejected('url-rejected', validated.error.message);
        }

        let target = validated.value;

        const baseHeaders: Record<string, string> = {
          'user-agent': request.userAgent ?? DEFAULT_USER_AGENT,
          'accept-encoding': 'gzip, deflate',
          ...Object.fromEntries(
            Object.entries(request.headers ?? {}).map(([key, value]) => [
              key.toLowerCase(),
              value,
            ]),
          ),
        };
        if (request.conditional?.etag) baseHeaders['if-none-match'] = request.conditional.etag;
        if (request.conditional?.lastModified) {
          baseHeaders['if-modified-since'] = request.conditional.lastModified;
        }
        if ((request.acceptContentTypes ?? []).length > 0) {
          baseHeaders['accept'] = [...(request.acceptContentTypes ?? []), '*/*;q=0.1'].join(', ');
        }

        let headers = baseHeaders;
        /*
         * Whether a hop to another origin has taken a credential off the
         * request, tracked across the loop rather than derived afterwards.
         *
         * By the time a failure comes back, `headers` no longer holds what was
         * stripped and `target` no longer holds where it was stripped from —
         * the only place this is knowable is the moment the filter runs.
         */
        let credentialsDropped = false;

        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const resolution = await resolveAndCheck(target.hostname, request.policy);
          if (!resolution.ok) return resolution.outcome;

          const result = await performRequest(
            target,
            resolution.addresses,
            {
              method: 'GET',
              maxBytes: request.maxBytes,
              ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
              ...(request.acceptContentTypes !== undefined
                ? { acceptContentTypes: request.acceptContentTypes }
                : {}),
              conditional:
                request.conditional?.etag !== undefined ||
                request.conditional?.lastModified !== undefined,
              followRedirects: true,
              keepErrorBody: false,
            },
            headers,
          );
          if (result.kind === 'done') {
            if (result.outcome.status === 'ok') return { ...result.outcome, finalUrl: target.href };
            /*
             * A failure says where it got to, and whether a credential made it
             * there. `testFeed` cannot otherwise tell a wrong password from a
             * right one dropped across a redirect — the two are the same 401
             * (RFC 013 §4.4).
             */
            return result.outcome.status === 'failed'
              ? {
                  ...result.outcome,
                  finalUrl: target.href,
                  ...(credentialsDropped ? { credentialsDropped: true } : {}),
                }
              : result.outcome;
          }

          if (hop === MAX_REDIRECTS) {
            return rejected(
              'too-many-redirects',
              `Gave up after ${MAX_REDIRECTS} redirects.`,
            );
          }

          const next = validateRedirect(result.location, target, request.policy);
          if (!next.ok) {
            // The bypass this closes: the first request goes somewhere
            // harmless and the redirect points at the metadata endpoint.
            return rejected(
              'redirect-rejected',
              `The server redirected somewhere we will not follow: ${next.error.message}`,
            );
          }

          if (isCrossOrigin(target, next.value)) {
            // Credentials are scoped to the origin they were issued for.
            const kept = Object.entries(headers).filter(
              ([key]) => !SENSITIVE_HEADERS.includes(key),
            );
            // Recorded only when something was actually removed: a redirect
            // across origins on a request that carried no credential has
            // dropped nothing, and reporting otherwise would put a diagnosis
            // about a password on a feed that has none.
            if (kept.length !== Object.keys(headers).length) credentialsDropped = true;
            headers = Object.fromEntries(kept);
          }

          target = next.value;
        }

        return rejected('too-many-redirects', `Gave up after ${MAX_REDIRECTS} redirects.`);
      } catch (error) {
        // The contract is that this never throws.
        return failed(
          'network-error',
          error instanceof Error ? networkErrorMessage(error) : 'unknown error',
        );
      }
    },

    /**
     * One POST of a JSON document, at one address, with no second hop.
     *
     * Every guard `fetch` runs, runs here: the URL is validated against the
     * same `UrlPolicy`, the name is resolved and every address it answers with
     * is checked, the socket connects to the address that was checked rather
     * than to the hostname, the timeout is the same, and the byte ceiling is
     * enforced while streaming. What is *removed* is the loop — there is no
     * redirect to revalidate, because there is no redirect.
     *
     * `SENSITIVE_HEADERS` has nothing to do here for the same reason. It exists
     * so a bearer token does not survive a hop to another origin; with no hop,
     * the token cannot reach anywhere but the address the guard approved. That
     * is a stronger property than stripping, not a weaker one, and it is why
     * refusing a redirect is the security decision rather than an ergonomic
     * one.
     */
    async postJson(request: PostJsonRequest): Promise<PostJsonOutcome> {
      try {
        const validated = validateOutboundUrl(request.url, request.policy);
        if (!validated.ok) {
          return rejected('url-rejected', validated.error.message) as PostJsonOutcome;
        }
        const target = validated.value;

        let body: Buffer;
        try {
          // Serialised here, never by a caller. A caller that handed over text
          // could hand over something that is not JSON while the header says
          // it is — and a cycle in an object is a throw, which this contract
          // does not permit to escape.
          body = Buffer.from(JSON.stringify(request.body ?? null), 'utf8');
        } catch {
          return failed('network-error', 'That request body could not be written as JSON.') as PostJsonOutcome;
        }

        const headers: Record<string, string> = {
          'user-agent': request.userAgent ?? DEFAULT_USER_AGENT,
          'accept-encoding': 'gzip, deflate',
          ...Object.fromEntries(
            Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
          ),
          // Last, and deliberately not overridable by `request.headers`: the
          // body is JSON whatever a caller would rather say about it, and the
          // one thing this method asks for is JSON back.
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
        };

        const resolution = await resolveAndCheck(target.hostname, request.policy);
        if (!resolution.ok) return resolution.outcome as PostJsonOutcome;

        const result = await performRequest(
          target,
          resolution.addresses,
          {
            method: 'POST',
            maxBytes: request.maxBytes,
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
            // Not `acceptContentTypes`: the `accept` header above says what we
            // asked for, and refusing the *answer* on its content type would
            // throw away the `{"message": "..."}` that is the whole reason a
            // non-2xx body is kept at all.
            conditional: false,
            followRedirects: false,
            body,
            keepErrorBody: true,
          },
          headers,
        );

        if (result.kind === 'redirect') {
          // Unreachable: `followRedirects: false` turns a 3xx into a rejection
          // inside `performRequest`. Stated as a value rather than left to fall
          // through, because a contract that never throws cannot rely on a
          // branch being impossible.
          return rejected(
            'redirect-rejected',
            'The server answered with a redirect. A POST is never replayed at another address.',
          ) as PostJsonOutcome;
        }
        if (result.outcome.status === 'not-modified') {
          // Also unreachable: nothing here sends a conditional request, so
          // `performRequest` cannot produce one.
          return failed('http-error', 'The server answered 304 to a request that asked nothing.', {
            httpStatus: 304,
          }) as PostJsonOutcome;
        }
        return result.outcome;
      } catch (error) {
        return failed(
          'network-error',
          error instanceof Error ? networkErrorMessage(error) : 'unknown error',
        ) as PostJsonOutcome;
      }
    },
  };
}
