import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { wallCardCanvas, wallHungAs, type CardCanvas } from '../src/http/wall-hung.js';

/**
 * Which canvas a wall card draws (RFC 016 §4.1), as a pure function of the
 * row — and held to the display's own definition of "landscape".
 *
 * The RFC's draft read the portrait canvas for every wall, which is the wrong
 * arrangement on every wall hung on its side. The pick here uses the inputs
 * `apps/display/src/orientation.ts` uses, in its order, and the four
 * functions it needs are transcribed from that file character for character:
 * the display bundle has no bundler and the server cannot import it, so the
 * seam is the one `tier-parity` and `month-spans-parity` sit at, and this is
 * the test that keeps a transcription a transcription.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY = readFileSync(join(HERE, '..', '..', 'display', 'src', 'orientation.ts'), 'utf8');
const SERVER = readFileSync(join(HERE, '..', 'src', 'http', 'wall-hung.ts'), 'utf8');

/** Every exported function in a file, as `name` → its whole text after the name. */
function functionBodies(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /export function (\w+)\(([\s\S]*?)\n\}\n/g;
  for (const match of source.matchAll(pattern)) {
    out[match[1] as string] = (match[2] as string).replace(/\r/g, '');
  }
  return out;
}

describe('the transcription', () => {
  const TRANSCRIBED = ['normaliseRotation', 'normaliseOrientation', 'canvasFor', 'resolveLayout'] as const;

  it('carries the four functions of orientation.ts character for character', () => {
    const display = functionBodies(DISPLAY);
    const server = functionBodies(SERVER);
    for (const name of TRANSCRIBED) {
      expect(display[name], `${name} is not in orientation.ts`).toBeDefined();
      expect(server[name], `${name} is not in wall-hung.ts`).toBeDefined();
      expect(server[name], `${name} has drifted from orientation.ts`).toBe(display[name]);
    }
  });

  it('transcribes nothing else from orientation.ts, so a fifth function is a decision', () => {
    // The type scale, `pxPerArcminute` and `geometryFor` belong to the wall
    // alone; a server that grew a copy of one would be a second reader of a
    // rule the wall owns. Listed so the day one appears it has to be argued.
    const server = Object.keys(functionBodies(SERVER)).sort();
    expect(server).toEqual([...TRANSCRIBED, 'wallCardCanvas', 'wallHungAs'].sort());
  });
});

describe('which way a wall is hung', () => {
  it('follows the pinned orientation over everything else', () => {
    expect(wallHungAs({ orientation: 'landscape', rotation: 0, reportW: 1080, reportH: 1920 })).toBe('landscape');
    expect(wallHungAs({ orientation: 'portrait', rotation: 90, reportW: 1920, reportH: 1080 })).toBe('portrait');
  });

  it('else reads the reported viewport, turned through the rotation', () => {
    expect(wallHungAs({ orientation: 'auto', rotation: 0, reportW: 1920, reportH: 1080 })).toBe('landscape');
    expect(wallHungAs({ orientation: 'auto', rotation: 0, reportW: 1080, reportH: 1920 })).toBe('portrait');
    // A quarter turn swaps the axes: a landscape viewport hung sideways is portrait.
    expect(wallHungAs({ orientation: 'auto', rotation: 90, reportW: 1920, reportH: 1080 })).toBe('portrait');
    expect(wallHungAs({ orientation: 'auto', rotation: 270, reportW: 1080, reportH: 1920 })).toBe('landscape');
    // A half turn does not.
    expect(wallHungAs({ orientation: 'auto', rotation: 180, reportW: 1920, reportH: 1080 })).toBe('landscape');
    // A square canvas is portrait, exactly as the display reads one.
    expect(wallHungAs({ orientation: 'auto', rotation: 0, reportW: 1000, reportH: 1000 })).toBe('portrait');
  });

  it('else turns a nominal portrait viewport through the rotation alone', () => {
    expect(wallHungAs({ orientation: 'auto', rotation: 90, reportW: null, reportH: null })).toBe('landscape');
    expect(wallHungAs({ orientation: 'auto', rotation: 270 })).toBe('landscape');
    expect(wallHungAs({ orientation: 'auto', rotation: 180, reportW: null, reportH: null })).toBe('portrait');
    // Half a report is no report.
    expect(wallHungAs({ orientation: 'auto', rotation: 90, reportW: 1920, reportH: null })).toBe('landscape');
    expect(wallHungAs({ orientation: 'auto', rotation: 0, reportW: 0, reportH: 1080 })).toBe('portrait');
  });

  it('else portrait', () => {
    expect(wallHungAs({})).toBe('portrait');
    expect(wallHungAs({ orientation: null, rotation: null, reportW: null, reportH: null })).toBe('portrait');
    // A rotation that is not a quarter turn rounds to the nearest one, exactly
    // as the display rounds it — 40 is no turn, and 45 would be a quarter turn.
    expect(wallHungAs({ orientation: 'sideways', rotation: 40 })).toBe('portrait');
    expect(wallHungAs({ orientation: 'sideways', rotation: 45 })).toBe('landscape');
  });
});

describe('which canvas the card draws', () => {
  const box = (id: string): CardCanvas['widgets'][number] => ({
    id, type: 'clock', x: 0.1, y: 0.1, w: 0.4, h: 0.3, z: 0, config: {},
  });
  const portrait: CardCanvas = { aspect: 0.5625, widgets: [box('p')] };
  const landscape: CardCanvas = { aspect: 1.7778, widgets: [box('l')] };
  const empty = (aspect: number): CardCanvas => ({ aspect, widgets: [] });

  it('draws the canvas the wall is hung for', () => {
    expect(wallCardCanvas({ orientation: 'landscape' }, portrait, landscape)).toEqual({
      hung: 'landscape', canvas: 'landscape', ...landscape,
    });
    expect(wallCardCanvas({ orientation: 'portrait' }, portrait, landscape)).toEqual({
      hung: 'portrait', canvas: 'portrait', ...portrait,
    });
  });

  it('draws the other canvas when that one is empty, which is what the wall letterboxes', () => {
    expect(wallCardCanvas({ orientation: 'landscape' }, portrait, empty(1.7778))).toEqual({
      hung: 'landscape', canvas: 'portrait', ...portrait,
    });
    expect(wallCardCanvas({ orientation: 'portrait' }, empty(0.5625), landscape)).toEqual({
      hung: 'portrait', canvas: 'landscape', ...landscape,
    });
  });

  it('draws an empty canvas at its own aspect when both are empty — the "nothing yet" note', () => {
    expect(wallCardCanvas({ orientation: 'landscape' }, empty(0.5625), empty(1.7778))).toEqual({
      hung: 'landscape', canvas: 'landscape', aspect: 1.7778, widgets: [],
    });
  });

  it('carries the canvas background it draws, and none when there is none', () => {
    const painted: CardCanvas = { ...landscape, background: { type: 'solid', color: '#112233' } };
    expect(wallCardCanvas({ orientation: 'landscape' }, portrait, painted).background).toEqual({
      type: 'solid', color: '#112233',
    });
    expect('background' in wallCardCanvas({ orientation: 'portrait' }, portrait, painted)).toBe(false);
  });
});
