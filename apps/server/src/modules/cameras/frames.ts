/**
 * Whole JPEG frames out of a camera's MJPEG stream (plan item M6.2, RFC 007
 * §5.1).
 *
 * A stream is a `multipart/x-mixed-replace` body that never ends, and cameras
 * and integrations disagree about its boundaries in every way a header can be
 * wrong — so the boundary is not read at all. A frame is found by its own
 * structure: a start-of-image marker, then the JPEG's segments walked by their
 * lengths, then the compressed data scanned for the marker that ends it. That
 * is what makes it safe against a picture that carries a whole second JPEG
 * inside it (an EXIF thumbnail, in an APP1 segment, with its own start and end
 * markers): a segment is skipped by its length, so a marker inside one is
 * never read as the frame's own. Anything between frames — part headers, a
 * boundary line, a byte of junk — is passed over looking for the next start.
 *
 * **Resumable**, because a stream arrives in chunks cut anywhere: the walk
 * remembers where it got to, and bytes are appended to one growing buffer
 * rather than concatenated per chunk, which on a 4 MB frame in 64 KB pieces
 * would copy a quarter of a gigabyte a frame. Pure: bytes in, frames out, no
 * clock and no socket, so it is tested at every byte offset a network could
 * split it at.
 *
 * **A frame is capped in bytes.** The stream is not — it is meant to go on —
 * but a frame is held in memory to be handed to every wall watching, and a
 * source that sends one enormous frame is a memory bomb on a small box. Over
 * the cap is an error, and the caller drops the upstream (RFC 007 §5.1).
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;

type State =
  /** Looking for the start of a frame. */
  | 'seek'
  /** Inside a frame, expecting a marker at `cursor`. */
  | 'marker'
  /** In compressed data, looking for the next marker that is not stuffing or a restart. */
  | 'entropy';

export interface FrameParser {
  /** The bytes as they arrived; the whole frames they completed, in order. */
  push(chunk: Uint8Array): Uint8Array[];
}

export class FrameTooLarge extends Error {
  constructor(readonly cap: number) {
    super(`A frame was larger than ${Math.round(cap / 1024 / 1024)} MB.`);
  }
}

export function createFrameParser(maxFrameBytes: number): FrameParser {
  let buffer = new Uint8Array(64 * 1024);
  /** Bytes in `buffer` from 0 to `length` are unread or part of the frame in progress. */
  let length = 0;
  /** Where the frame in progress starts. */
  let start = 0;
  /** Where the walk resumes. */
  let cursor = 0;
  let state: State = 'seek';

  const append = (chunk: Uint8Array): void => {
    if (length + chunk.length > buffer.length) {
      let size = buffer.length;
      while (size < length + chunk.length) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(chunk, length);
    length += chunk.length;
  };

  /** Drop everything before `from`, keeping the walk's positions true. */
  const discard = (from: number): void => {
    buffer.copyWithin(0, from, length);
    length -= from;
    start -= from;
    cursor -= from;
  };

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      append(chunk);
      const frames: Uint8Array[] = [];
      for (;;) {
        if (state === 'seek') {
          let found = -1;
          for (let i = cursor; i + 1 < length; i++) {
            if (buffer[i] === 0xff && buffer[i + 1] === SOI) {
              found = i;
              break;
            }
          }
          if (found < 0) {
            // Keep a trailing 0xFF: it may be the first half of a start marker.
            const keep = length > 0 && buffer[length - 1] === 0xff ? length - 1 : length;
            cursor = keep;
            discard(keep);
            return frames;
          }
          discard(found);
          start = 0;
          cursor = 2;
          state = 'marker';
          continue;
        }

        if (cursor - start > maxFrameBytes) {
          // Lose the frame and everything held for it; the caller decides what a source doing this deserves.
          length = 0;
          start = 0;
          cursor = 0;
          state = 'seek';
          throw new FrameTooLarge(maxFrameBytes);
        }

        if (state === 'marker') {
          // Fill bytes: a marker may be preceded by any number of 0xFF.
          while (cursor < length && buffer[cursor] === 0xff && cursor + 1 < length && buffer[cursor + 1] === 0xff) cursor++;
          if (cursor + 1 >= length) return frames;
          if (buffer[cursor] !== 0xff) {
            // Not a JPEG after all, or a frame cut short: look for the next start.
            state = 'seek';
            cursor = start + 1;
            continue;
          }
          const marker = buffer[cursor + 1] as number;
          if (marker === EOI) {
            const end = cursor + 2;
            frames.push(buffer.slice(start, end));
            cursor = end;
            state = 'seek';
            continue;
          }
          if (marker === SOI) {
            // A start inside a frame's segment list means the last one was cut short.
            start = cursor;
            cursor += 2;
            continue;
          }
          if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            cursor += 2;
            continue;
          }
          if (cursor + 3 >= length) return frames;
          const segment = ((buffer[cursor + 2] as number) << 8) | (buffer[cursor + 3] as number);
          if (segment < 2) {
            state = 'seek';
            cursor = start + 1;
            continue;
          }
          if (cursor + 2 + segment > length) {
            // Not all here yet; the cap above still applies to what is.
            if (cursor + 2 + segment - start > maxFrameBytes) {
              cursor += 2 + segment;
              continue;
            }
            return frames;
          }
          cursor += 2 + segment;
          if (marker === SOS) state = 'entropy';
          continue;
        }

        // Entropy-coded data: 0xFF is followed by 0x00 (stuffing) or a restart
        // marker inside it; anything else is the next marker.
        let next = -1;
        for (let i = cursor; i + 1 < length; i++) {
          if (buffer[i] !== 0xff) continue;
          const after = buffer[i + 1] as number;
          if (after === 0x00 || after === 0xff || (after >= 0xd0 && after <= 0xd7)) continue;
          next = i;
          break;
        }
        if (next < 0) {
          // Resume at the last byte, which may be half a marker.
          cursor = Math.max(cursor, length - 1);
          if (cursor - start > maxFrameBytes) continue;
          return frames;
        }
        cursor = next;
        state = 'marker';
      }
    },
  };
}
