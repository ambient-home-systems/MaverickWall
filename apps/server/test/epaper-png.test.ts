import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { Framebuffer, rotate } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';

/**
 * The framebuffer and the PNG encoder, checked by decoding rather than looking.
 *
 * An inverted panel — ink where paper should be — passes every structural
 * check a person can reason about (right size, valid chunks, scannable file)
 * and is only caught by reading a known frame back out. So this decodes the
 * PNG the encoder produced, CRC and all, and asserts that a drawn pixel really
 * comes out black. It is the e-paper equivalent of the QR encoder's
 * decode-in-the-browser test.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  /** True where the pixel is black (grayscale sample 0). */
  black: boolean[][];
}

/** A deliberately independent decoder: parse chunks, verify CRCs, unpack bits. */
function decodePng(png: Uint8Array): DecodedPng {
  for (let i = 0; i < SIGNATURE.length; i++) {
    expect(png[i]).toBe(SIGNATURE[i]);
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let ihdr: { width: number; height: number; bitDepth: number; colourType: number } | undefined;
  const idatParts: Uint8Array[] = [];
  let sawEnd = false;

  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = view.getUint32(offset + 8 + length);
    const crcInput = png.subarray(offset + 4, offset + 8 + length);
    expect(crc32(crcInput)).toBe(declaredCrc);

    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      ihdr = { width: d.getUint32(0), height: d.getUint32(4), bitDepth: data[8]!, colourType: data[9]! };
    } else if (type === 'IDAT') {
      idatParts.push(data.slice());
    } else if (type === 'IEND') {
      sawEnd = true;
    }
    offset += 12 + length;
  }

  expect(ihdr).toBeDefined();
  expect(sawEnd).toBe(true);
  const { width, height, bitDepth, colourType } = ihdr!;

  const merged = new Uint8Array(idatParts.reduce((n, p) => n + p.length, 0));
  let mo = 0;
  for (const p of idatParts) {
    merged.set(p, mo);
    mo += p.length;
  }
  const raw = inflateSync(merged);
  const stride = (width + 7) >> 3;

  const black: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    expect(raw[rowStart]).toBe(0); // filter: None, as the encoder writes
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) {
      const byte = raw[rowStart + 1 + (x >> 3)]!;
      const sample = (byte >> (7 - (x & 7))) & 1;
      row.push(sample === 0); // grayscale 0 is black
    }
    black.push(row);
  }
  return { width, height, bitDepth, colourType, black };
}

describe('the PNG header', () => {
  it('declares a 1-bit grayscale image of the right size', () => {
    const fb = new Framebuffer(800, 480);
    const decoded = decodePng(encodePng1bit(fb));
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(480);
    expect(decoded.bitDepth).toBe(1);
    expect(decoded.colourType).toBe(0);
  });
});

describe('ink renders black', () => {
  it('round-trips drawn pixels as black and blank pixels as white', () => {
    // A width that is not a multiple of 8 exercises the row padding.
    const fb = new Framebuffer(13, 6);
    fb.set(0, 0); // top-left corner, first bit of the row
    fb.set(12, 0); // top-right, last real bit before padding
    fb.set(5, 3);
    fb.fillRect(2, 4, 4, 2); // a small filled block

    const decoded = decodePng(encodePng1bit(fb));
    for (let y = 0; y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) {
        expect(decoded.black[y]![x]).toBe(fb.get(x, y));
      }
    }
    // Spot the corners explicitly so a padding-bit mistake cannot hide.
    expect(decoded.black[0]![0]).toBe(true);
    expect(decoded.black[0]![12]).toBe(true);
    expect(decoded.black[0]![1]).toBe(false);
  });

  it('a cleared frame is entirely white, a filled frame entirely black', () => {
    const white = decodePng(encodePng1bit(new Framebuffer(20, 4)));
    expect(white.black.every((row) => row.every((b) => b === false))).toBe(true);

    const filledFb = new Framebuffer(20, 4);
    filledFb.clear(true);
    const black = decodePng(encodePng1bit(filledFb));
    expect(black.black.every((row) => row.every((b) => b === true))).toBe(true);
  });
});

describe('framebuffer primitives', () => {
  it('computes stride from width, rounding up to whole bytes', () => {
    expect(new Framebuffer(800, 10).stride).toBe(100);
    expect(new Framebuffer(13, 10).stride).toBe(2);
    expect(new Framebuffer(8, 10).stride).toBe(1);
    expect(new Framebuffer(9, 10).stride).toBe(2);
  });

  it('clips off-canvas draws instead of throwing or wrapping', () => {
    const fb = new Framebuffer(8, 8);
    fb.set(-1, 0);
    fb.set(8, 0);
    fb.set(0, 99);
    expect(fb.bits.every((byte) => byte === 0)).toBe(true);
    expect(fb.get(-1, 0)).toBe(false);
  });

  it('strokeRect draws only the border', () => {
    const fb = new Framebuffer(10, 10);
    fb.strokeRect(1, 1, 5, 5);
    expect(fb.get(1, 1)).toBe(true); // corner
    expect(fb.get(5, 5)).toBe(true); // opposite corner
    expect(fb.get(3, 1)).toBe(true); // top edge
    expect(fb.get(3, 3)).toBe(false); // interior is untouched
  });
});

describe('rotation', () => {
  it('leaves 0° identical', () => {
    const fb = new Framebuffer(4, 2);
    fb.set(0, 0);
    const r = rotate(fb, 0);
    expect([r.width, r.height]).toEqual([4, 2]);
    expect(r.get(0, 0)).toBe(true);
  });

  it('swaps dimensions for 90° and 270°, keeps them for 180°', () => {
    const fb = new Framebuffer(4, 2);
    expect([rotate(fb, 90).width, rotate(fb, 90).height]).toEqual([2, 4]);
    expect([rotate(fb, 270).width, rotate(fb, 270).height]).toEqual([2, 4]);
    expect([rotate(fb, 180).width, rotate(fb, 180).height]).toEqual([4, 2]);
  });

  it('moves the top-left pixel clockwise and loses no ink', () => {
    const fb = new Framebuffer(4, 2);
    fb.set(0, 0);
    const ink = (f: Framebuffer): number => {
      let n = 0;
      for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (f.get(x, y)) n++;
      return n;
    };
    const r90 = rotate(fb, 90);
    // Turning clockwise, the top-left corner lands at the top-right.
    expect(r90.get(r90.width - 1, 0)).toBe(true);
    expect(ink(r90)).toBe(1);
    // Two turns is a 180° point reflection: (0,0) → (w-1, h-1).
    const r180 = rotate(fb, 180);
    expect(r180.get(3, 1)).toBe(true);
    expect(ink(r180)).toBe(1);
  });
});
