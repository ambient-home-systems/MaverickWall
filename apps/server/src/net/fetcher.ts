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
const DEFAULT_USER_AGENT = 'MaverickWall/0.1 (+https://github.com/ambient-home-systems/MaverickWall)';

/** Headers that must not survive a hop to another origin. */
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-api-key'];

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

function rejected(code: FetchRejectionCode, message: string): FetchOutcome {
  return { status: 'rejected', code, message };
}

interface FailureExtras {
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
}

function failed(code: FetchFailureCode, message: string, extras: FailureExtras = {}): FetchOutcome {
  return {
    status: 'failed',
    code,
    message,
    ...(extras.httpStatus !== undefined ? { httpStatus: extras.httpStatus } : {}),
    ...(extras.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: extras.retryAfterSeconds }
      : {}),
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
): Promise<{ ok: true; addresses: ResolvedAddress[] } | { ok: false; outcome: FetchOutcome }> {
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
          `${hostname} resolves to ${formatIp(ip)}, which is ${kind}. ` +
            (isLocalNetwork(ip)
              ? 'Turn on "allow local network" for this source if that is intended.'
              : kind === 'loopback'
                ? 'Turn on "allow loopback" for this source if that is intended.'
                : 'That is not a reachable public address.'),
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
  readonly outcome: FetchOutcome;
}

interface RedirectResult {
  readonly kind: 'redirect';
  readonly location: string;
}

async function performRequest(
  target: ValidatedUrl,
  addresses: readonly ResolvedAddress[],
  request: FetchRequest,
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
        method: 'GET',
        headers,
        // The pin.
        lookup: pinnedLookup(addresses) as never,
        // Redirects are handled here so each hop can be revalidated.
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;

        if (status === 304) {
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

        if (status >= 300 && status < 400) {
          const location = headerValue(response.headers.location);
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
          response.resume();
          const retryAfter = parseRetryAfter(headerValue(response.headers['retry-after']));
          finish({
            kind: 'done',
            outcome: failed('http-error', `The server answered ${status}.`, {
              httpStatus: status,
              ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
            }),
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
          finish({ kind: 'done', outcome: failed('network-error', error.message) });
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
      finish({ kind: 'done', outcome: failed('network-error', error.message) });
    });

    clientRequest.end();
  });
}

export function createFetcher(): Fetcher {
  return {
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

        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const resolution = await resolveAndCheck(target.hostname, request.policy);
          if (!resolution.ok) return resolution.outcome;

          const result = await performRequest(target, resolution.addresses, request, headers);
          if (result.kind === 'done') {
            return result.outcome.status === 'ok'
              ? { ...result.outcome, finalUrl: target.href }
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
            headers = Object.fromEntries(
              Object.entries(headers).filter(([key]) => !SENSITIVE_HEADERS.includes(key)),
            );
          }

          target = next.value;
        }

        return rejected('too-many-redirects', `Gave up after ${MAX_REDIRECTS} redirects.`);
      } catch (error) {
        // The contract is that this never throws.
        return failed(
          'network-error',
          error instanceof Error ? error.message : 'unknown error',
        );
      }
    },
  };
}
