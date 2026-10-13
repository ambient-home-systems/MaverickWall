import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFrameParser, FrameTooLarge } from '../src/modules/cameras/frames.js';

/**
 * The frame parser (plan item M6.2, RFC 007 §11): real JPEG bytes in a
 * multipart body, split at every byte offset a network could cut it at, must
 * come out as the same whole frames. A parser that works at one chunking is a
 * parser that works on one network.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'camera');
const A = new Uint8Array(readFileSync(join(DIR, 'frame-a.jpg')));
const B = new Uint8Array(readFileSync(join(DIR, 'frame-b.jpg')));
/** Frame A with frame B carried inside an APP1 segment, as an EXIF thumbnail is. */
const THUMB = new Uint8Array(readFileSync(join(DIR, 'frame-thumbnail.jpg')));
const CAP = 4 * 1024 * 1024;

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
const join2 = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));

/** A part the way Home Assistant's proxy writes one. */
const part = (frame: Uint8Array, boundary = 'frame', length = frame.length): Uint8Array =>
  join2(ascii(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`), frame, ascii('\r\n'));

const same = (got: Uint8Array[], want: Uint8Array[]): void => {
  expect(got.length).toBe(want.length);
  got.forEach((frame, i) => expect(Buffer.from(frame).equals(Buffer.from(want[i] as Uint8Array)), `frame ${i}`).toBe(true));
};

const parseIn = (body: Uint8Array, pieces: number[]): Uint8Array[] => {
  const parser = createFrameParser(CAP);
  const out: Uint8Array[] = [];
  let at = 0;
  for (const cut of [...pieces, body.length]) {
    out.push(...parser.push(body.subarray(at, cut)));
    at = cut;
  }
  return out;
};

describe('the frame parser', () => {
  // Core's own loop writes the first frame twice; a parser must shrug at it.
  const body = join2(part(A), part(A), part(B), part(THUMB), part(B));
  const want = [A, A, B, THUMB, B];

  it('reads whole frames in one piece', () => {
    same(parseIn(body, []), want);
  });

  it('reads the same frames split at every byte offset', () => {
    for (let cut = 1; cut < body.length; cut++) same(parseIn(body, [cut]), want);
  });

  it('reads the same frames a byte at a time', () => {
    same(parseIn(body, Array.from({ length: body.length - 1 }, (_, i) => i + 1)), want);
  });

  it('does not take a JPEG carried inside a frame for the frame', () => {
    const frames = parseIn(part(THUMB), []);
    expect(frames).toHaveLength(1);
    expect((frames[0] as Uint8Array).length).toBe(THUMB.length);
  });

  it('ignores a boundary the header did not announce and a length that lies', () => {
    const lying = join2(part(A, 'wrong', 12), ascii('junk between parts'), part(B, 'other', 999_999));
    same(parseIn(lying, []), [A, B]);
  });

  it('recovers when a frame is cut short by the next one', () => {
    const cut = join2(part(A.subarray(0, Math.floor(A.length / 2))), part(B));
    same(parseIn(cut, []), [B]);
  });

  it('refuses a frame over the cap, and reads on after it', () => {
    const parser = createFrameParser(4_000);
    const big = join2(A, new Uint8Array(0));
    // A frame padded past the cap inside a segment, then an ordinary one.
    const padded = join2(big.subarray(0, 2), ascii('\xff\xfe'), new Uint8Array([0x10, 0x00]), new Uint8Array(4_094).fill(0x20), big.subarray(2));
    expect(() => parser.push(part(padded))).toThrow(FrameTooLarge);
    // The same parser reads the next frame as ever.
    same(parser.push(part(B)), [B]);
  });

  it('refuses a frame that never ends once it passes the cap, without waiting for its end', () => {
    const parser = createFrameParser(10_000);
    // Into the compressed data, where nothing but a marker can end it.
    const sos = Buffer.from(A).indexOf(Buffer.from([0xff, 0xda]));
    expect(sos).toBeGreaterThan(0);
    const header = A.subarray(0, sos + 20);
    expect(() => {
      parser.push(header);
      for (let i = 0; i < 50; i++) parser.push(new Uint8Array(1_000).fill(0x11));
    }).toThrow(FrameTooLarge);
  });
});
