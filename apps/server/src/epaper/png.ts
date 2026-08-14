/**
 * A 1-bit grayscale PNG encoder (RFC 006).
 *
 * The e-paper endpoint has to hand ESPHome's `online_image` and Home
 * Assistant's Generic Camera an ordinary PNG. A headless browser to draw a
 * calendar would be the wrong trade against "one container" and a ~482MB
 * image, and a rasterization library is a dependency for a fully specified
 * problem — so, like the QR encoder, we emit the bytes ourselves.
 *
 * A 1-bit grayscale PNG is small by construction: signature, an `IHDR` naming
 * the dimensions, one `IDAT` that is nothing but `zlib.deflate` of the
 * scanlines (each prefixed with filter byte 0), and `IEND`. The only Node
 * surface used is `node:zlib` — standard library, allowed in `apps/server`,
 * kept out of `core` whose runtime surface is the audited `globals.d.ts`.
 *
 * The one convention that matters: the framebuffer stores `1 = ink (dark)`,
 * but PNG grayscale reads `0 = black, 1 = white`. So a framebuffer byte is
 * bit-inverted on the way in — ink ends up black. The round-trip test decodes
 * a known frame and asserts exactly that, because an inverted panel is the
 * defect that passes every structural check.
 */
import { deflateSync } from 'node:zlib';

import type { Framebuffer } from './framebuffer.js';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG (and zlib) CRC-32. Hand-rolled to stay independent of the Node version. */
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

/** Length + type + data + CRC(type+data), the PNG chunk frame. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** Encode a framebuffer as a 1-bit grayscale PNG. Ink renders black. */
export function encodePng1bit(fb: Framebuffer): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, fb.width);
  ihdrView.setUint32(4, fb.height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive (we use filter 0 per row)
  ihdr[12] = 0; // interlace: none

  // Scanlines: one filter byte, then the row's bytes with ink inverted so the
  // PNG's "1 = white" leaves drawn pixels black. Padding bits past the width
  // are inverted too; PNG ignores them.
  const raw = new Uint8Array((fb.stride + 1) * fb.height);
  for (let y = 0; y < fb.height; y++) {
    const rowStart = y * (fb.stride + 1);
    raw[rowStart] = 0; // filter type: None
    for (let b = 0; b < fb.stride; b++) {
      raw[rowStart + 1 + b] = ~fb.bits[y * fb.stride + b]! & 0xff;
    }
  }

  const idat = deflateSync(raw);
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
