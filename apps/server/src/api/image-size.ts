/**
 * How big a picture is, as a wall will draw it, from the first bytes of the
 * file (plan item M3.7).
 *
 * A slideshow pairs two portrait photos side by side in a wide box, so the
 * server has to know which photos are portrait before a wall asks for any of
 * them. Every picture this application serves has been sniffed already
 * (`sniffImage`); this reads a little further into the same header for the
 * width and height. Pure, with no I/O, so a test hands it real bytes.
 *
 * **A JPEG's EXIF orientation is applied.** A camera writes a portrait photo
 * as a landscape raster with a tag saying "turn me", and a browser honours the
 * tag (`image-orientation: from-image` is the default), so a photo from a NAS
 * folder is drawn upright and has to be measured upright. Orientations 5 to 8
 * are the quarter turns, and swap the two sides.
 *
 * It answers `undefined` for anything it cannot read — a truncated header, a
 * file that is not a picture — and the slideshow shows that photo on its own,
 * which is what it did before this existed.
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** The largest side this believes: a header claiming more is not a photograph. */
const MAX_SIDE = 65_535;

function sane(width: number, height: number): ImageSize | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return undefined;
  return { width, height };
}

export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12) return undefined;
  // PNG: the IHDR chunk is always first, so its width and height sit at 16 and 20.
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (b.length < 24 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
    return sane(b.readUInt32BE(16), b.readUInt32BE(20));
  }
  // GIF: the logical screen, little-endian.
  const gif = b.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return sane(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return webpSize(b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
  return undefined;
}

function webpSize(b: Buffer): ImageSize | undefined {
  if (b.length < 30) return undefined;
  const chunk = b.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') return sane(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  if (chunk === 'VP8 ') {
    // A key frame's start code, then two 14-bit sides.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return sane(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return undefined;
    const bits = b.readUInt32LE(21);
    return sane((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return undefined;
}

/** The start-of-frame markers that carry a size: every SOFn but DHT (C4), JPG (C8) and DAC (CC). */
function isFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(b: Buffer): ImageSize | undefined {
  let orientation = 1;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1] ?? 0;
    // Fill bytes, and the markers that carry no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return undefined;
    const body = at + 4;
    if (marker === 0xe1 && body + 6 <= b.length && b.subarray(body, body + 6).toString('latin1') === 'Exif\0\0') {
      orientation = exifOrientation(b.subarray(body + 6, Math.min(b.length, at + 2 + length))) ?? orientation;
    }
    if (isFrame(marker)) {
      if (body + 5 > b.length) return undefined;
      const height = b.readUInt16BE(body + 1);
      const width = b.readUInt16BE(body + 3);
      return orientation >= 5 && orientation <= 8 ? sane(height, width) : sane(width, height);
    }
    at += 2 + length;
  }
  return undefined;
}

/** Tag 0x0112 of IFD0, read in whichever byte order the TIFF header names. */
function exifOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const order = tiff.subarray(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return undefined;
  const little = order === 'II';
  const u16 = (offset: number): number => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset: number): number => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}
