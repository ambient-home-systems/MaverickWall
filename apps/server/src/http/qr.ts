/**
 * A QR encoder, because the alternative is a third-party origin.
 *
 * Rule three forbids fetching anything from outside the container, and a
 * pairing link is exactly the thing nobody wants to type on a television
 * remote. A dependency would also do, but this is a small, fully specified
 * problem with a fixed answer, and shipping it means the image is one file
 * fewer to audit at the next version bump.
 *
 * Deliberately narrow: byte mode, error correction level M, and whichever of
 * versions 1–10 the payload fits. A pairing URL is around seventy characters,
 * which lands in version 4 or 5. Anything longer than version 10 holds is
 * refused rather than guessed at — a QR nobody can scan is worse than a URL
 * somebody has to type, because the first one looks like it works.
 */

/** Total codewords and EC codewords per block, for level M, versions 1–10. */
const VERSION_SPEC: readonly {
  readonly totalCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1Data: number;
  readonly group2Blocks: number;
  readonly group2Data: number;
}[] = [
  { totalCodewords: 26, ecPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 44, ecPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 70, ecPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 100, ecPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 134, ecPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 172, ecPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 196, ecPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0 },
  { totalCodewords: 242, ecPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39 },
  { totalCodewords: 292, ecPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37 },
  { totalCodewords: 346, ecPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44 },
];

/** Where the alignment pattern centres sit, per version. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// --- GF(256) ---------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let index = 0; index < 255; index++) {
    EXP[index] = x;
    LOG[x] = index;
    x <<= 1;
    // The QR field polynomial, x^8 + x^4 + x^3 + x^2 + 1.
    if (x & 0x100) x ^= 0x11d;
  }
  for (let index = 255; index < 512; index++) EXP[index] = EXP[index - 255] as number;
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** The generator polynomial for `degree` error-correction codewords. */
export function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let index = 0; index < degree; index++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position++) {
      next[position] = (next[position] as number) ^ (poly[position] as number);
      next[position + 1] =
        (next[position + 1] as number) ^ mul(poly[position] as number, EXP[index] as number);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder: the EC codewords for one block. */
export function ecCodewords(data: readonly number[], count: number): number[] {
  const generator = generatorPoly(count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < count; index++) {
      remainder[index] = (remainder[index] as number) ^ mul(generator[index + 1] as number, factor);
    }
  }
  return remainder;
}

// --- encoding --------------------------------------------------------------

function bitsFor(version: number): number {
  // Byte-mode character count is 8 bits below version 10, 16 bits from 10 up.
  return version < 10 ? 8 : 16;
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= VERSION_SPEC.length; version++) {
    const spec = VERSION_SPEC[version - 1];
    if (spec === undefined) continue;
    const dataCodewords =
      spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
    // 4 bits mode + the character count + the payload itself.
    const needed = Math.ceil((4 + bitsFor(version) + byteLength * 8) / 8);
    if (needed <= dataCodewords) return version;
  }
  return -1;
}

function interleave(data: readonly number[], version: number): number[] {
  const spec = VERSION_SPEC[version - 1] as (typeof VERSION_SPEC)[number];
  const blocks: number[][] = [];
  let cursor = 0;
  for (let index = 0; index < spec.group1Blocks; index++) {
    blocks.push(data.slice(cursor, cursor + spec.group1Data));
    cursor += spec.group1Data;
  }
  for (let index = 0; index < spec.group2Blocks; index++) {
    blocks.push(data.slice(cursor, cursor + spec.group2Data));
    cursor += spec.group2Data;
  }
  const ecBlocks = blocks.map((block) => ecCodewords(block, spec.ecPerBlock));

  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let index = 0; index < longest; index++) {
    for (const block of blocks) if (index < block.length) out.push(block[index] as number);
  }
  for (let index = 0; index < spec.ecPerBlock; index++) {
    for (const block of ecBlocks) out.push(block[index] as number);
  }
  return out;
}

const PAD = [0xec, 0x11];

function toCodewords(text: string, version: number): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = VERSION_SPEC[version - 1] as (typeof VERSION_SPEC)[number];
  const dataCodewords = spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;

  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let index = width - 1; index >= 0; index--) bits.push((value >> index) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, bitsFor(version));
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a byte boundary, then alternating pad codewords.
  const capacityBits = dataCodewords * 8;
  for (let index = 0; index < 4 && bits.length < capacityBits; index++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset++) byte = (byte << 1) | (bits[index + offset] as number);
    codewords.push(byte);
  }
  while (codewords.length < dataCodewords) {
    codewords.push(PAD[codewords.length % 2] as number);
  }
  return codewords;
}

// --- matrix ----------------------------------------------------------------

type Grid = (0 | 1 | null)[][];

function placeFinder(grid: Grid, row: number, column: number): void {
  for (let y = -1; y <= 7; y++) {
    for (let x = -1; x <= 7; x++) {
      const gridY = row + y;
      const gridX = column + x;
      const line = grid[gridY];
      if (line === undefined || gridX < 0 || gridX >= grid.length) continue;
      const onRing = (y >= 0 && y <= 6 && (x === 0 || x === 6)) || (x >= 0 && x <= 6 && (y === 0 || y === 6));
      const inCore = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      line[gridX] = onRing || inCore ? 1 : 0;
    }
  }
}

/**
 * Reserve the format-information cells so data placement skips them.
 *
 * Row and column 6 are skipped: that is the timing pattern, which runs the
 * whole way across and is *not* part of the format region. Overwriting it
 * leaves a code that looks right and scans as nothing.
 *
 * The vertical run is seven cells, rows `size-1` down to `size-7`. Row
 * `size-8` is the dark module and belongs to nobody else.
 */
function reserveFormat(grid: Grid, size: number): void {
  for (let index = 0; index < 9; index++) {
    if (index !== 6) {
      const row8 = grid[8] as (0 | 1 | null)[];
      if (row8[index] === null) row8[index] = 0;
      const line = grid[index] as (0 | 1 | null)[];
      if (line[8] === null) line[8] = 0;
    }
  }
  for (let index = 0; index < 8; index++) {
    (grid[8] as (0 | 1 | null)[])[size - 1 - index] = 0;
  }
  for (let index = 0; index < 7; index++) {
    (grid[size - 1 - index] as (0 | 1 | null)[])[8] = 0;
  }
}

function buildGrid(version: number): Grid {
  const size = version * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () => new Array<0 | 1 | null>(size).fill(null));

  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);

  // Timing patterns.
  for (let index = 8; index < size - 8; index++) {
    const bit: 0 | 1 = index % 2 === 0 ? 1 : 0;
    (grid[6] as (0 | 1 | null)[])[index] = bit;
    (grid[index] as (0 | 1 | null)[])[6] = bit;
  }

  // Alignment patterns, skipping the three finder corners.
  const centres = ALIGNMENT[version - 1] ?? [];
  for (const row of centres) {
    for (const column of centres) {
      const nearFinder =
        (row <= 8 && column <= 8) || (row <= 8 && column >= size - 9) || (row >= size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          const edge = Math.max(Math.abs(y), Math.abs(x));
          (grid[row + y] as (0 | 1 | null)[])[column + x] = edge === 1 ? 0 : 1;
        }
      }
    }
  }

  reserveFormat(grid, size);
  // After the reservation, which sweeps the column this sits in.
  (grid[size - 8] as (0 | 1 | null)[])[8] = 1;
  return grid;
}

const MASKS: readonly ((row: number, column: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Format information for level M with a given mask, BCH-encoded and masked. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // 00 is level M
  let value = data << 10;
  for (let index = 4; index >= 0; index--) {
    if ((value >> (10 + index)) & 1) value ^= 0b10100110111 << index;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function placeData(grid: Grid, codewords: readonly number[], size: number): void {
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    const column = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        const line = grid[row] as (0 | 1 | null)[];
        if (line[x] !== null) continue;
        const byte = codewords[bitIndex >> 3] ?? 0;
        line[x] = ((byte >> (7 - (bitIndex & 7))) & 1) as 0 | 1;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

function penalty(grid: readonly (readonly (0 | 1 | null)[])[], size: number): number {
  let score = 0;
  const at = (r: number, c: number): number => ((grid[r] as (0 | 1 | null)[])[c] as number) ?? 0;

  // Rule 1: runs of five or more.
  for (let line = 0; line < size; line++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let index = 1; index < size; index++) {
        const current = horizontal ? at(line, index) : at(index, line);
        const previous = horizontal ? at(line, index - 1) : at(index - 1, line);
        if (current === previous) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const first = at(row, column);
      if (first === at(row, column + 1) && first === at(row + 1, column) && first === at(row + 1, column + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 sequence.
  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const reversed = [...pattern].reverse();
  for (let line = 0; line < size; line++) {
    for (let index = 0; index + 11 <= size; index++) {
      for (const horizontal of [true, false]) {
        const window = Array.from({ length: 11 }, (_, offset) =>
          horizontal ? at(line, index + offset) : at(index + offset, line),
        );
        if (
          window.every((bit, offset) => bit === pattern[offset]) ||
          window.every((bit, offset) => bit === reversed[offset])
        ) {
          score += 40;
        }
      }
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) dark += at(row, column);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
  readonly version: number;
}

/** Encode text, or undefined when it will not fit a version this supports. */
export function encodeQr(text: string): QrMatrix | undefined {
  const byteLength = new TextEncoder().encode(text).length;
  const version = chooseVersion(byteLength);
  if (version < 0) return undefined;

  const codewords = interleave(toCodewords(text, version), version);
  const size = version * 4 + 17;

  let best: { grid: Grid; score: number; mask: number } | undefined;
  for (let mask = 0; mask < 8; mask++) {
    const grid = buildGrid(version);
    const reserved = grid.map((line) => line.map((cell) => cell !== null));
    placeData(grid, codewords, size);

    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        if ((reserved[row] as boolean[])[column]) continue;
        if ((MASKS[mask] as (r: number, c: number) => boolean)(row, column)) {
          const line = grid[row] as (0 | 1 | null)[];
          line[column] = (line[column] === 1 ? 0 : 1) as 0 | 1;
        }
      }
    }

    // Format information, written after masking because it is not masked by it.
    /*
     * Format information, twice, written after masking because it carries its
     * own BCH code and is not masked by the data mask.
     *
     * Placed most-significant bit first. Writing it the other way round
     * produces a code that satisfies every structural check — finders, timing,
     * the dark module — and decodes as nothing at all, which is exactly the
     * failure a person cannot see by looking at it.
     *
     * The coordinates are listed rather than computed because both copies step
     * around row and column 6, and an expression that encodes those two jumps
     * is harder to check against the specification than the list is.
     */
    const format = formatBits(mask);
    const bits = Array.from({ length: 15 }, (_, index) => ((format >> (14 - index)) & 1) as 0 | 1);

    const firstCopy: readonly (readonly [number, number])[] = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    const secondCopy: readonly (readonly [number, number])[] = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
      [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
    ];

    for (const [index, position] of firstCopy.entries()) {
      (grid[position[0]] as (0 | 1 | null)[])[position[1]] = bits[index] as 0 | 1;
    }
    for (const [index, position] of secondCopy.entries()) {
      (grid[position[0]] as (0 | 1 | null)[])[position[1]] = bits[index] as 0 | 1;
    }

    const score = penalty(grid, size);
    if (best === undefined || score < best.score) best = { grid, score, mask };
  }

  const chosen = best as { grid: Grid };
  return {
    size,
    version,
    modules: chosen.grid.map((line) => line.map((cell) => cell === 1)),
  };
}

/**
 * The matrix as an SVG.
 *
 * One path of rectangles rather than one element per module: a version 5 code
 * is 1369 modules and that many DOM nodes on a settings page is wasteful for
 * something nobody interacts with.
 */
export function qrSvg(matrix: QrMatrix, pixels = 220): string {
  const quiet = 4;
  const span = matrix.size + quiet * 2;
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if ((matrix.modules[row] as boolean[])[column]) {
        parts.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" ` +
    `viewBox="0 0 ${span} ${span}" role="img" aria-label="Pairing QR code">` +
    `<rect width="${span}" height="${span}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/></svg>`
  );
}
