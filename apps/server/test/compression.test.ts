import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install, type Installation } from './browser-harness.js';
import { acceptsGzip, gzipped, isCompressible } from '../src/http/compress.js';

/**
 * What a wall actually downloads.
 *
 * Nothing this server sent was compressed. Measured on a cold load of a paired
 * 1080x1920 wall: twenty requests, 571,386 bytes, and `content-encoding`
 * missing from every one of them although the browser asked for gzip on all
 * twenty. `display.css` is 125,814 bytes on the wire and 39,231 gzipped;
 * `render.js` is 143,034 and 44,202.
 *
 * The warm path was never the problem and is asserted here unchanged — every
 * one of these carries a content ETag and answers a conditional request with a
 * bare 304. What was missing is the cold one: a tablet paired this afternoon,
 * a kiosk whose cache was cleared, a wall coming back after the container was
 * reinstalled. That is the moment the product promises a calendar rather than
 * a waiting screen, and it was paying four times over for it.
 *
 * Driven through the real app against the real bundle on disk rather than a
 * stub, because the thing under test is a *header* and a body somebody else
 * has to decode. Every assertion below gunzips what came back and compares it
 * to what the identity request returns — "it said gzip" is not the claim.
 */

let home: Installation;

beforeAll(async () => {
  home = await install();
}, 120_000);

afterAll(async () => {
  await home?.dispose();
});

const GZIP = { 'accept-encoding': 'gzip, deflate, br' };

interface Wire {
  readonly status: number;
  /** The bytes **as sent**, still encoded. */
  readonly body: Buffer;
  readonly encoding: string | undefined;
  readonly vary: string | undefined;
  readonly etag: string | undefined;
}

/**
 * One request, read off the socket rather than through `fetch`.
 *
 * `undici` — which is what `home.call` and every browser use — decompresses a
 * gzipped body before anyone sees it, which is exactly right for a client and
 * exactly wrong for a test about what went over the wire: the first draft of
 * this file asked `fetch` for the bytes and got the decoded file back, so
 * `gunzipSync` threw "incorrect header check" on a response that was perfectly
 * correct. `node:http` hands over what arrived.
 */
function wire(base: string, path: string, headers: Record<string, string>): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            encoding: res.headers['content-encoding'] as string | undefined,
            vary: res.headers['vary'] as string | undefined,
            etag: res.headers['etag'] as string | undefined,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Both representations of one path, and the bytes each actually carries. */
async function bothWays(path: string): Promise<{ identity: Wire; gzip: Wire }> {
  return {
    identity: await wire(home.base, path, { 'accept-encoding': 'identity' }),
    gzip: await wire(home.base, path, GZIP),
  };
}

describe('the display bundle', () => {
  /*
   * The two files that are most of the download, named rather than discovered:
   * a loop over whatever the directory happens to hold would go quietly green
   * on a build that produced nothing.
   */
  for (const file of ['display.css', 'render.js']) {
    it(`sends ${file} gzipped, and it decodes to exactly the same bytes`, async () => {
      const { identity, gzip } = await bothWays(`/assets/${file}`);

      expect(identity.status).toBe(200);
      expect(identity.body.byteLength).toBeGreaterThan(20_000);
      expect(identity.encoding).toBeUndefined();

      expect(gzip.encoding).toBe('gzip');
      // The claim is not "a header said gzip". It is that a wall can decode it
      // and get the file — anything else is a screen that draws nothing at all.
      expect(gunzipSync(gzip.body).equals(identity.body)).toBe(true);

      // And that it was worth doing. `display.css` measured 125,814 → 39,231
      // and `render.js` 143,034 → 44,202; half is a floor either clears with
      // room, and a threshold this loose cannot go red over a routine edit.
      expect(gzip.body.byteLength).toBeLessThan(identity.body.byteLength / 2);
    });
  }

  it('varies on accept-encoding, on the body and on the 304 alike', async () => {
    const { identity, gzip } = await bothWays('/assets/display.css');
    expect(identity.vary).toBe('accept-encoding');
    expect(gzip.vary).toBe('accept-encoding');

    /*
     * Without this a shared cache between the server and a wall may hand a
     * gzipped body to a client that never asked for one, and a wall that
     * cannot decode its own stylesheet draws nothing. The 304 carries it too,
     * because a 304 is the answer a cache stores against.
     */
    const revalidated = await wire(home.base, '/assets/display.css', {
      ...GZIP,
      'if-none-match': gzip.etag ?? '',
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.vary).toBe('accept-encoding');
  });

  it('keeps one ETag across both encodings, so a warm wall still gets its 304', async () => {
    const { identity, gzip } = await bothWays('/assets/display.css');
    /*
     * Deliberately the same tag: it names the *file*, and both representations
     * decode to it. A wall that cached the plain bytes and later asks with
     * `Accept-Encoding: gzip` — which is what happens when a kiosk browser
     * updates — is right to be told nothing has changed, and re-downloading
     * 126 KB to learn that is the cost of getting this wrong.
     */
    expect(gzip.etag).toBe(identity.etag);
    expect(identity.etag).toMatch(/^"[0-9a-f]{32}"$/);

    const revalidated = await wire(home.base, '/assets/display.css', {
      'accept-encoding': 'identity',
      'if-none-match': gzip.etag ?? '',
    });
    expect(revalidated.status).toBe(304);
  });

  it('leaves a file already compressed alone', async () => {
    /*
     * A woff2 is a compressed container and a PNG is compressed pixels, and
     * neither must go out with a `content-encoding` on it.
     *
     * **This proves the outcome and not the reason, and saying so is the
     * point.** Two guards can produce it — the content-type allowlist, and
     * `gzipped`'s refusal to return anything larger than it was given — and a
     * woff2 trips the second whichever way the first is written. Measured:
     * deleting the allowlist leaves this test green. So the guard that stops
     * the CPU being spent at all is asserted where it can actually fail, on
     * the predicate itself, below.
     */
    const font = await wire(home.base, '/assets/fonts/roboto-flex.woff2', GZIP);
    expect(font.status).toBe(200);
    expect(font.encoding).toBeUndefined();
  });

  it('leaves a short file alone, because the framing would cost more', async () => {
    // `clock.js` is 753 bytes; a gzip header and trailer alone are 18 of them.
    const { identity, gzip } = await bothWays('/assets/clock.js');
    expect(identity.body.byteLength).toBeLessThan(1024);
    expect(gzip.encoding).toBeUndefined();
  });

  it('honours a refusal spelled as a q-value', async () => {
    /*
     * `gzip;q=0` is a client saying no, and it reads as a yes to anything that
     * only looks for the word. Rare in a browser and not rare in the kiosk
     * shells and proxies that end up in front of a wall — and the failure mode
     * is a screen that cannot decode what it was sent.
     */
    const refused = await wire(home.base, '/assets/display.css', {
      'accept-encoding': 'gzip;q=0, identity',
    });
    expect(refused.encoding).toBeUndefined();
  });
});

describe('the manifest', () => {
  it('is gzipped, and decodes to the document the wall was built', async () => {
    /*
     * The one response on the wall's hot path: every screen in the house asks
     * for it every sixty seconds, for months. Measured at 20,519 bytes.
     */
    const link = await home.pairLink();
    const token = new URL(link).searchParams.get('token') ?? '';
    const paired = await home.call(`/pair?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    const read = async (encoding: string): Promise<Wire> => {
      const response = await wire(home.base, '/d/manifest', { cookie, 'accept-encoding': encoding });
      expect(response.status).toBe(200);
      return response;
    };

    const identity = await read('identity');
    const gzip = await read('gzip');

    expect(identity.encoding).toBeUndefined();
    expect(gzip.encoding).toBe('gzip');
    // Worth doing at all: measured at 20,519 bytes, going out every sixty
    // seconds to every screen in the house.
    expect(gzip.body.byteLength).toBeLessThan(identity.body.byteLength / 2);

    /*
     * Parsed rather than compared byte for byte, and that is the point rather
     * than a looseness. `manifestEtag` drops `generatedAt` from its preimage,
     * so two manifests a moment apart share an ETag and differ in their bytes
     * — which is exactly why the route compresses what it just serialised
     * instead of caching a body against that key. What has to hold is that the
     * document decodes and is the household's, not that two polls are equal.
     */
    const decoded = JSON.parse(gunzipSync(gzip.body).toString('utf8')) as {
      manifestVersion: number;
      generatedAt: number;
      days: unknown[];
    };
    expect(decoded.manifestVersion).toBe(1);
    expect(Array.isArray(decoded.days)).toBe(true);
    expect(decoded.generatedAt).toBeGreaterThan(0);
  }, 60_000);

  it('still answers a conditional poll with a bare 304 and the clock header', async () => {
    /*
     * The wall syncs its clock from `x-server-time` on *every* answer, 304
     * included — so a change to how the body is sent must not touch the
     * cheap path a settled wall spends all day on.
     */
    const link = await home.pairLink();
    const token = new URL(link).searchParams.get('token') ?? '';
    const paired = await home.call(`/pair?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const first = await wire(home.base, '/d/manifest', { cookie, 'accept-encoding': 'gzip' });
    const etag = first.etag ?? '';
    expect(etag).not.toBe('');

    const again = await new Promise<{ status: number; serverTime: string | undefined; bytes: number }>(
      (resolve, reject) => {
        const url = new URL('/d/manifest', home.base);
        const req = request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { cookie, 'accept-encoding': 'gzip', 'if-none-match': etag },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                serverTime: res.headers['x-server-time'] as string | undefined,
                bytes: Buffer.concat(chunks).byteLength,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(again.status).toBe(304);
    expect(again.serverTime).toBeDefined();
    expect(again.bytes).toBe(0);
  }, 60_000);
});

/**
 * The three decisions, asked directly.
 *
 * Everything above measures an outcome over a socket, which is the right way
 * to test a header — and is exactly why one of those assertions cannot go red
 * for its own reason: a woff2 is refused by the size check whether or not the
 * content-type allowlist exists, so deleting the allowlist leaves that test
 * green. These are pure functions with no server in the way, so each guard can
 * be broken on its own and seen to fail.
 */
describe('the decisions themselves', () => {
  it('compresses text and refuses what is already compressed', () => {
    for (const type of [
      'text/css; charset=utf-8',
      'text/javascript; charset=utf-8',
      'text/html; charset=utf-8',
      'application/json; charset=utf-8',
      'application/manifest+json',
      'image/svg+xml',
    ]) {
      expect(isCompressible(type), `${type} should compress`).toBe(true);
    }
    /*
     * The half that costs something when it is wrong: CPU spent on the one box
     * that also fetches and expands everybody's calendars, to make a file
     * slightly larger. A wall caches the font for a year and the panel frames
     * are pixels.
     */
    for (const type of ['font/woff2', 'image/png', 'image/jpeg', 'application/octet-stream']) {
      expect(isCompressible(type), `${type} should be left alone`).toBe(false);
    }
  });

  it('reads a q-value as the refusal it is', () => {
    expect(acceptsGzip('gzip')).toBe(true);
    expect(acceptsGzip('gzip, deflate, br')).toBe(true);
    expect(acceptsGzip('br, gzip;q=0.8')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
    // The one that reads as a yes to anything that only looks for the word.
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('gzip;q=0, identity')).toBe(false);
    expect(acceptsGzip('br')).toBe(false);
    expect(acceptsGzip('identity')).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });

  it('never answers with more bytes than it was given', () => {
    // Rule nine at the smallest scale there is. Random bytes do not compress,
    // and a short body cannot: both come back as "send what you had".
    const noise = Buffer.alloc(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
    expect(gzipped(noise, 'application/json')).toBeUndefined();
    expect(gzipped(Buffer.from('short'.repeat(20)), 'text/css')).toBeUndefined();

    const text = Buffer.from('.a{color:red}'.repeat(400));
    const packed = gzipped(text, 'text/css');
    expect(packed).toBeDefined();
    expect((packed as Buffer).byteLength).toBeLessThan(text.byteLength);
  });
});
