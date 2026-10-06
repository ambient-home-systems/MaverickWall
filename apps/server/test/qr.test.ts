import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeQr, generatorPoly, qrSvg, versionBits } from '../src/http/qr.js';
import { qrPixels } from './qr-decode.js';

/**
 * The QR encoder's structure.
 *
 * These check the parts of the format that are fixed by the specification and
 * that a person can reason about — finder patterns, timing, sizing, the dark
 * module. They are necessary and nowhere near sufficient: a QR can satisfy all
 * of them and still fail to scan because the data placement or the mask is
 * wrong. The only test that settles that is decoding one, which happens in the
 * browser against a real detector rather than here.
 */

const URL_LIKE = 'http://192.168.1.10:8080/pair?token=hHyELWZJzKOkHr8AzgPdtitq7HTbLlmTVKhw03s5IUg';

describe('sizing', () => {
  it('picks a version big enough and reports the right module count', () => {
    const small = encodeQr('hello');
    expect(small?.version).toBe(1);
    expect(small?.size).toBe(21);

    const url = encodeQr(URL_LIKE);
    // A pairing URL is about 90 bytes, which does not fit below version 5.
    expect(url?.version).toBeGreaterThanOrEqual(4);
    expect(url?.size).toBe((url?.version ?? 0) * 4 + 17);
  });

  it('refuses rather than guessing when the payload is too long', () => {
    // A QR nobody can scan is worse than a URL somebody has to type, because
    // the first one looks like it works.
    expect(encodeQr('x'.repeat(5000))).toBeUndefined();
  });
});

describe('the fixed patterns', () => {
  const matrix = encodeQr(URL_LIKE);

  it('puts a finder in three corners and not the fourth', () => {
    const at = (r: number, c: number): boolean => (matrix?.modules[r] as boolean[])[c] as boolean;
    const size = matrix?.size ?? 0;
    for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      // The outer ring is dark and the ring inside it is light.
      expect(at(row, column)).toBe(true);
      expect(at(row, column + 6)).toBe(true);
      expect(at(row + 1, column + 1)).toBe(false);
      expect(at(row + 3, column + 3)).toBe(true);
    }
  });

  it('alternates the timing patterns', () => {
    const size = matrix?.size ?? 0;
    for (let index = 8; index < size - 8; index++) {
      const expected = index % 2 === 0;
      expect((matrix?.modules[6] as boolean[])[index]).toBe(expected);
      expect((matrix?.modules[index] as boolean[])[6]).toBe(expected);
    }
  });

  it('sets the dark module, which is always set', () => {
    const size = matrix?.size ?? 0;
    expect((matrix?.modules[size - 8] as boolean[])[8]).toBe(true);
  });

  it('is deterministic', () => {
    expect(encodeQr(URL_LIKE)).toEqual(encodeQr(URL_LIKE));
  });
});

describe('the generator polynomial', () => {
  it('has one more coefficient than its degree and starts at one', () => {
    for (const degree of [10, 16, 18, 22, 24, 26]) {
      const poly = generatorPoly(degree);
      expect(poly).toHaveLength(degree + 1);
      expect(poly[0]).toBe(1);
    }
  });
});

describe('the SVG', () => {
  it('is self-contained and carries a quiet zone', () => {
    // Rule three: no third-party origin, and nothing to fetch.
    const svg = qrSvg(encodeQr('hello') as never);
    expect(svg).toContain('<svg');
    // `xmlns` is a namespace name rather than an address anything fetches, so
    // what matters is that nothing references an external resource.
    expect(svg).not.toContain('href');
    expect(svg).not.toContain('url(');
    expect(svg).not.toContain('<image');
    // 21 modules plus four on each side.
    expect(svg).toContain('viewBox="0 0 29 29"');
  });
});

describe('read back by an independent decoder', () => {
  /*
   * The only check that settles a QR code is somebody else's reader. `jsqr` is
   * a test-only dependency, never in the image. Every byte length this encoder
   * accepts, 1 to 213, across all ten versions: versions 7 to 10 drew codes
   * that decoded as nothing until their version information was written, and
   * every structural assertion above passed over them.
   */
  it('decodes every length the encoder accepts, in every version', () => {
    const versions = new Set<number>();
    const unread: number[] = [];
    for (let length = 1; length <= 213; length++) {
      const text = 'x'.repeat(length);
      const matrix = encodeQr(text);
      expect(matrix, `refused ${length} bytes`).toBeDefined();
      versions.add(matrix!.version);
      const { data, side } = qrPixels(matrix!);
      if (jsQR(data, side, side)?.data !== text) unread.push(length);
    }
    expect(unread).toEqual([]);
    expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(encodeQr('x'.repeat(214))).toBeUndefined();
    // 213 encodes, each trying all eight masks, and 213 decodes: about two
    // seconds alone and over five beside the browser suite, so it is given a
    // budget rather than fewer lengths — every length is the claim.
  }, 30_000);

  it('decodes text that is not ASCII, and a Wi-Fi code with its escapes', () => {
    for (const text of ['Café — Wi-Fi für Gäste', 'WIFI:T:WPA;S:Home\;Net;P:pa\:ss\\word;;']) {
      const { data, side } = qrPixels(encodeQr(text)!);
      expect(jsQR(data, side, side)?.data).toBe(text);
    }
  });

  it('writes the version information the standard publishes', () => {
    // ISO/IEC 18004 Annex D: version 7 is 0x07C94, version 10 is 0x0A4D3.
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(10)).toBe(0x0a4d3);
  });
});
