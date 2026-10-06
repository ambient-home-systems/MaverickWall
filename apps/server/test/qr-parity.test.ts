import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The wall and the panel encode one QR code, and this proves it by reading the
 * files (plan item M5.3).
 *
 * A QR code widget is drawn as an SVG on a wall and in the editor's preview,
 * and as one bit on a panel that may be following that wall. The display
 * bundle has no bundler and the server cannot import it, so the encoder and
 * the payload builder are written twice — and the blocks between their markers
 * are **character-identical**, which this compares. Two encoders disagreeing
 * would be a wall and a panel that showed different codes for one network, and
 * nothing short of decoding both would ever notice.
 *
 * **The server is the spec here**, unlike the clock face: `http/qr.ts` is the
 * encoder the pairing code has shipped on and the one the decode tests hold.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PAIRS = [
  {
    marker: 'qr-encoder',
    server: join(HERE, '..', 'src', 'http', 'qr.ts'),
    display: join(HERE, '..', '..', 'display', 'src', 'qr.ts'),
  },
  {
    marker: 'qr-payload',
    server: join(HERE, '..', 'src', 'api', 'qr-payload.ts'),
    display: join(HERE, '..', '..', 'display', 'src', 'qr-payload.ts'),
  },
] as const;

function block(path: string, marker: string): string {
  const source = readFileSync(path, 'utf8');
  const begin = `/* ${marker}:begin */`;
  const end = `/* ${marker}:end */`;
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  expect(start, `${path} has no ${begin}`).toBeGreaterThanOrEqual(0);
  expect(stop, `${path} has no ${end}`).toBeGreaterThan(start);
  // Exactly one of each: a second pair would leave half a module unguarded.
  expect(source.indexOf(begin, start + 1), `${path} has two ${begin}`).toBe(-1);
  return source.slice(start, stop + end.length);
}

describe('one QR encoder, written twice', () => {
  for (const pair of PAIRS) {
    it(`holds the ${pair.marker} block character for character in both bundles`, () => {
      const server = block(pair.server, pair.marker);
      const display = block(pair.display, pair.marker);
      // A long block: name the first line that differs, not two pages of text.
      const a = server.split('\n');
      const b = display.split('\n');
      const first = a.findIndex((line, index) => line !== b[index]);
      expect(first === -1 ? null : `line ${first + 1}: ${a[first]} | ${b[first]}`).toBeNull();
      expect(display).toBe(server);
    });
  }

  it('leaves nothing outside the block in the display copies but a comment', () => {
    for (const pair of PAIRS) {
      const source = readFileSync(pair.display, 'utf8');
      const outside = source.replace(block(pair.display, pair.marker), '');
      // A header comment and blank lines, and no code of the bundle's own.
      expect(outside.replace(/\/\*\*[\s\S]*?\*\//g, '').trim(), pair.display).toBe('');
    }
  });
});
