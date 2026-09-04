import { gzipSync } from 'node:zlib';

/**
 * gzip, for a wall on the other side of a house.
 *
 * Nothing this server sent was compressed. Measured on a cold load of a paired
 * 1080x1920 wall: twenty requests, 571,386 bytes, and `content-encoding`
 * absent from every one of them although the browser had asked for gzip on all
 * twenty. `display.css` alone is 125,814 bytes — 84,176 of which are the
 * comments this project writes on purpose and has no reason to put on a
 * household's Wi-Fi — and it gzips to 39,231. `render.js` goes 143,034 to
 * 44,202. The bundle as a whole goes from about 571 KB to about 180 KB.
 *
 * The *warm* case was already right and is untouched: every one of these
 * carries a content-derived ETag, a conditional request is answered with a
 * bare 304, and the service worker serves the shell from the device and
 * refreshes behind the reader. What was missing is the **cold** case — a new
 * tablet, a kiosk whose cache was cleared, a screen paired this afternoon,
 * a wall coming back after somebody reinstalled the container — which is the
 * exact moment the product promises a calendar in milliseconds rather than a
 * waiting screen.
 *
 * gzip and not brotli, deliberately. Brotli at a quality worth having costs
 * roughly ten times the CPU for about five per cent more bytes, on hardware
 * that is often a Raspberry Pi running the one container hard rule 8 asks for,
 * and every screen in the house asks for the same files. One encoding,
 * understood by everything back to the browsers rule two exists for, and the
 * static half of it computed once per build rather than once per request
 * (`static.ts` holds the result beside the ETag).
 */

/**
 * Below this, the framing costs more than the saving.
 *
 * gzip adds an 18-byte header and trailer plus a deflate block, so a short
 * module can come back *larger* than it went in — `clock.js` is 753 bytes and
 * is left exactly as it is. `gzipped` checks the outcome as well, but refusing
 * up front is cheaper than compressing to find out.
 */
const FLOOR_BYTES = 1024;

/**
 * What is worth compressing: text, and nothing else.
 *
 * An allowlist rather than a denylist, because being wrong costs differently
 * in each direction. A text type missing from this list is a response that
 * stays as large as it is today — no worse than before this file existed. A
 * *compressed* type wrongly on it — the woff2 a wall already caches for a
 * year, an e-paper PNG, a household's own photograph — is CPU spent to make a
 * file very slightly bigger, on the one box that also has to fetch and expand
 * everybody's calendars.
 */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|manifest\+json)|image\/svg\+xml)/;

export function isCompressible(contentType: string): boolean {
  return COMPRESSIBLE.test(contentType);
}

/**
 * Whether the caller asked for gzip.
 *
 * `gzip;q=0` is a *refusal* and reads as an acceptance to anything that only
 * looks for the word — which is the whole reason this is parsed rather than
 * matched. `*` counts, since a client that will take anything will take this.
 */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false;
  for (const entry of header.split(',')) {
    const parts = entry.trim().toLowerCase().split(';');
    const name = parts[0]?.trim() ?? '';
    if (name !== 'gzip' && name !== '*') continue;
    const q = parts.slice(1).map((part) => part.trim()).find((part) => part.startsWith('q='));
    if (q !== undefined && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

/**
 * The gzipped body, or nothing at all.
 *
 * Never throws, and never answers with something larger than it was given.
 * Both are rule nine at the smallest scale a rule can be applied at: a wall
 * that cannot be sent 39 KB of stylesheet must be sent 126 KB of stylesheet,
 * not an error — so every refusal here falls back to the bytes that were
 * already going to be sent.
 *
 * Level 9 rather than the default 6, because the expensive half of this is
 * computed once per build and cached beside the file (`static.ts`); the only
 * thing paying per request is the manifest, where the difference between the
 * two levels on twenty kilobytes is under a millisecond and the bytes go over
 * somebody's Wi-Fi every sixty seconds for months.
 */
export function gzipped(body: Buffer, contentType: string): Buffer | undefined {
  if (body.byteLength < FLOOR_BYTES) return undefined;
  if (!isCompressible(contentType)) return undefined;
  try {
    const out = gzipSync(body, { level: 9 });
    return out.byteLength < body.byteLength ? out : undefined;
  } catch {
    return undefined;
  }
}
