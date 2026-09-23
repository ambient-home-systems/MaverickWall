import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { groupCells } from '../src/epaper/group-cells.js';

/**
 * The two copies of the group placement must not drift (RFC 014 §5.1).
 *
 * `apps/display/src/group-cells.ts` decides where a group's children go on
 * the wall and `apps/server/src/epaper/group-cells.ts` is that file
 * transcribed, so the panel following a wall places every child in the same
 * fraction of the same box. The display bundle has no bundler and the server
 * cannot import it, so the module is written twice and this holds everything
 * from the transcription marker on to being character-identical — the seam
 * `tier-parity`, `epaper-ladder-parity` and `month-spans-parity` sit at, and
 * the strongest form it takes: not the table alone but every function body,
 * because a panel that rounded a cell differently would draw a child a pixel
 * from where the wall does, for exactly the boxes where it matters.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY = join(HERE, '..', '..', 'display', 'src', 'group-cells.ts');
const PANEL = join(HERE, '..', 'src', 'epaper', 'group-cells.ts');
const MARKER = '/* ---- transcribed, and nothing else';

function transcribed(path: string): string {
  const source = readFileSync(path, 'utf8');
  const from = source.indexOf(MARKER);
  if (from < 0) throw new Error(`no transcription marker in ${path}`);
  return source.slice(from).replace(/\r/g, '');
}

describe('the group placement, on both renderers', () => {
  it('reads the files it claims to, so a rename fails loudly', () => {
    expect(readFileSync(DISPLAY, 'utf8')).toContain('Where a group puts its children');
    expect(readFileSync(PANEL, 'utf8')).toContain('transcribed, and nothing else');
  });

  it('is character-identical from the marker on', () => {
    expect(transcribed(PANEL)).toBe(transcribed(DISPLAY));
  });

  it('exports a working table on the panel side', () => {
    // A transcription that parses is not the same as one that is imported —
    // the panel renderer reads this copy, so it has to answer.
    expect(groupCells({ layout: 'grid', columns: 2 }, 3)).toHaveLength(3);
  });
});
