import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { Manifest } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { panelInput, renderFreeformEpaper } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * Home Assistant's `tile` look on a one-bit panel (plan item P5.3, decision D4).
 *
 * A tile on the wall is a filled circle in a colour; a panel has no colour, so
 * the tile says the one thing its colour said — "this is on, or this is wrong"
 * — the one way a still bit can: the disc is **solid**, with the mark knocked
 * out of it, for a reading whose tone is `active` or `alert`, and a **ring**
 * with the mark inked inside it for one that is neither. Each tile is an
 * outlined rounded box, and every rectangle is a function of the box and the
 * number of readings, never of the words (the refresh contract in `render.ts`).
 *
 * Asked by decoding frames, which is how every panel claim in this repository
 * is settled, and **the list is pinned to hashes rendered on a clean worktree
 * of `3b2aab2`**, the commit this landed on — so "a list widget draws exactly
 * what it drew" is a measurement against the renderer before this change, not
 * this renderer agreeing with itself. The readings carry everything a tile
 * reads (a tone, a time, a level) precisely so the pin can see a list that
 * started reading one of them.
 */

const TODAY = '2026-08-22';

interface Reading {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly glyph?: string | undefined;
  readonly mode: string;
  readonly stale: boolean;
  readonly tone: 'active' | 'alert' | null;
  readonly changedAt: number | null;
  readonly level?: number | undefined;
}

const HOUSE: readonly Reading[] = [
  { key: 'a1b2c3d4', label: 'Front door', value: 'Open', unit: null, glyph: 'door', mode: 'icon_state', stale: false, tone: 'alert', changedAt: 1_787_000_000_000 },
  { key: 'b1b2c3d4', label: 'Kitchen', value: '19.4', unit: '°C', glyph: 'temperature', mode: 'label_value', stale: false, tone: null, changedAt: 1_787_000_060_000 },
  { key: 'c1b2c3d4', label: 'Living room lamp', value: 'On · 60%', unit: null, glyph: 'light', mode: 'label_value', stale: false, tone: 'active', changedAt: 1_787_000_120_000, level: 60 },
  { key: 'd1b2c3d4', label: 'Bedroom blind', value: 'Open · 40%', unit: null, glyph: 'cover', mode: 'value', stale: true, tone: 'active', changedAt: null, level: 40 },
];

function manifestOf(readings: readonly Reading[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [{ date: TODAY, shifts: [], events: [] }],
    sources: [],
    panels: { home: { readings, note: null } },
  } as unknown as Manifest;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

function frameOf(manifest: Manifest, config: Record<string, unknown>, size: Size = { width: 800, height: 480 }): Framebuffer {
  return renderFreeformEpaper(
    buildEpaperModel(manifest),
    manifest,
    [{ type: 'homeassistant', x: 0, y: 0, w: 1, h: 1, z: 0, config }],
    size,
  );
}

function bitsOf(fb: Framebuffer, size: Size = { width: 800, height: 480 }): string {
  let bits = '';
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) bits += fb.get(x, y) ? '1' : '0';
  }
  return bits;
}

const hashOf = (bits: string): string => createHash('sha256').update(bits).digest('hex').slice(0, 16);

/**
 * The first tile's top edge in an 800-wide frame: its row, and the run of ink
 * that is the edge. Row 0 and the outer columns are the widget's own frame, so
 * the search starts inside it — a first draft took "the first row with ink",
 * which is the frame border, compared two identical borders and could not see
 * a tile move at all.
 */
function firstTileEdge(bits: string): { readonly row: number; readonly start: number; readonly length: number } {
  for (let y = 2; y < 480; y++) {
    const row = bits.slice(y * 800 + 3, y * 800 + 797);
    const start = row.indexOf('1');
    if (start < 0) continue;
    const end = row.indexOf('0', start);
    return { row: y, start: start + 3, length: (end < 0 ? row.length : end) - start };
  }
  throw new Error('no tile drawn');
}

describe('a list on a panel is the list it was', () => {
  /*
   * Rendered on a clean worktree of 3b2aab2 with this exact fixture, and on
   * this tree, and compared: identical at every size and config. A list that
   * began to read the tone, the time or the level — or a tile look that leaked
   * into the list's path — moves one of these.
   */
  const PINNED: Readonly<Record<string, string>> = {
    '800x480 none': '9a6d97d7c5eb8287',
    '800x480 list': '9a6d97d7c5eb8287',
    '800x480 value': '8d4d9fef7f99dba6',
    '800x480 all': '9a712e6fcd1944cd',
    '800x480 count': 'ec55637ab04f232e',
    '480x800 none': '45b1b938b23da7a2',
    '480x800 list': '45b1b938b23da7a2',
    '480x800 value': '0d0355ca2631df5d',
    '480x800 all': 'fec991f45f5c3796',
    '480x800 count': 'fdeea9e53ea4cbd9',
    '1872x1404 none': 'd2413e94775afc1b',
    '1872x1404 list': 'd2413e94775afc1b',
    '1872x1404 value': 'f29045f15ac4b4af',
    '1872x1404 all': '07f16faae5c57070',
    '1872x1404 count': '19d938d7db8c6fcd',
  };
  const CONFIGS: Readonly<Record<string, Record<string, unknown>>> = {
    none: {},
    list: { variant: 'list' },
    value: { fields: ['value'] },
    all: { fields: ['icon', 'label', 'value'] },
    count: { count: 2 },
  };

  for (const size of [
    { width: 800, height: 480 },
    { width: 480, height: 800 },
    { width: 1872, height: 1404 },
  ]) {
    it(`draws the frame 3b2aab2 drew, at ${size.width}x${size.height}`, () => {
      for (const [name, config] of Object.entries(CONFIGS)) {
        const label = `${size.width}x${size.height} ${name}`;
        expect(hashOf(bitsOf(frameOf(manifestOf(HOUSE), config, size), size)), label).toBe(PINNED[label]);
      }
    });
  }

  it('hashes a list panel’s input exactly as before, and a tile’s differently', () => {
    /*
     * The frame's ETag hashes what each widget reads (`panelInput`, P3.5). A
     * list reads the slice as it always has, so no list panel refreshes for
     * this change; a tile names its look beside the same slice, so a widget
     * that stored `variant: 'tile'` while the panel still drew the list gets a
     * new frame now that it draws tiles.
     */
    const manifest = manifestOf(HOUSE);
    const home = (manifest as unknown as { panels: Record<string, unknown> }).panels['home'];
    expect(panelInput('homeassistant', manifest, {})).toEqual({ kind: 'panel', panel: home });
    expect(panelInput('homeassistant', manifest, { variant: 'list' })).toEqual({ kind: 'panel', panel: home });
    expect(panelInput('homeassistant', manifest, { variant: 'tile' })).toEqual({ kind: 'panel', panel: home, look: 'tile' });
  });
});

describe('tiles on a panel', () => {
  const one = (reading: Partial<Reading>): Manifest =>
    manifestOf([{ ...HOUSE[0]!, ...reading } as Reading]);

  it('draws tiles, not the list, when a widget asks for them', () => {
    expect(bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile' }))).not.toBe(bitsOf(frameOf(manifestOf(HOUSE), {})));
  });

  it('fills the disc for a reading that is on or wrong, and rings it for one that is neither', () => {
    const lit = frameOf(one({ tone: 'active', glyph: undefined }), { variant: 'tile' });
    const idle = frameOf(one({ tone: null, glyph: undefined }), { variant: 'tile' });
    const alert = frameOf(one({ tone: 'alert', glyph: undefined }), { variant: 'tile' });
    // One bit has one way to say either, and says both the same way.
    expect(bitsOf(alert)).toBe(bitsOf(lit));
    // The only difference between lit and idle is ink added inside the ring —
    // the disc filled in, and nothing taken away anywhere.
    const a = bitsOf(lit);
    const b = bitsOf(idle);
    let added = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      expect(`${a[i]}${b[i]}`, `pixel ${i}: idle has ink the filled disc does not`).toBe('10');
      added++;
    }
    expect(added, 'filling the disc drew nothing').toBeGreaterThan(50);
  });

  it('knocks the mark out of a filled disc and inks it inside a ring', () => {
    for (const tone of ['active', null] as const) {
      const marked = bitsOf(frameOf(one({ tone, glyph: 'door' }), { variant: 'tile' }));
      const bare = bitsOf(frameOf(one({ tone, glyph: undefined }), { variant: 'tile' }));
      let changed = 0;
      for (let i = 0; i < marked.length; i++) {
        if (marked[i] === bare[i]) continue;
        changed++;
        // On a filled disc every pixel of the mark is ink taken away; in a
        // ring, every pixel is ink added. Never both in one frame.
        expect(`${marked[i]}${bare[i]}`, `${tone ?? 'idle'} pixel ${i}`).toBe(tone === null ? '10' : '01');
      }
      expect(changed, `${tone ?? 'idle'}: the mark drew nothing`).toBeGreaterThan(20);
    }
  });

  it('draws the bar at the reading’s level, and none without one or without being asked', () => {
    const width = (level: number | undefined): number => {
      const bits = bitsOf(frameOf(one({ tone: 'active', level }), { variant: 'tile', showBar: true }));
      const bare = bitsOf(frameOf(one({ tone: 'active', level: 0 }), { variant: 'tile', showBar: true }));
      // The columns the fill adds over an empty track, counted once each.
      const columns = new Set<number>();
      for (let i = 0; i < bits.length; i++) if (bits[i] !== bare[i]) columns.add(i % 800);
      return columns.size;
    };
    const full = width(100);
    expect(full, 'a full bar filled nothing').toBeGreaterThan(40);
    /*
     * A full bar is the whole track, less the track's two end strokes, which
     * are ink whatever the level. Held to the drawn track rather than only to
     * itself, or a bar drawn at half of every level agrees with its own
     * half-full "full" — which is how the first draft of this passed a mutant.
     * Its second draft held it to the tile's top edge, which carries the
     * corners' pixels and is four wider than the track; the track is found
     * instead, as the first long run below that edge that is shorter than it.
     */
    const empty = bitsOf(frameOf(one({ tone: 'active', level: 0 }), { variant: 'tile', showBar: true }));
    const edge = firstTileEdge(empty);
    let track = 0;
    for (let y = edge.row + 1; y < 480 && track === 0; y++) {
      for (const run of empty.slice(y * 800 + 3, y * 800 + 797).split('0')) {
        if (run.length > 0.9 * edge.length && run.length < edge.length) track = run.length;
      }
    }
    expect(track, 'no track drawn under the tile').toBeGreaterThan(0);
    expect(Math.abs(full - (track - 2)), `full ${full} against a track of ${track}`).toBeLessThanOrEqual(1);
    for (const level of [25, 60]) {
      expect(Math.abs(width(level) - Math.round((full * level) / 100)), `level ${level}`).toBeLessThanOrEqual(2);
    }
    // No level: no track either — the tile is the tile it is without a bar.
    const noLevel = bitsOf(frameOf(one({ tone: 'active', level: undefined }), { variant: 'tile', showBar: true }));
    expect(noLevel).toBe(bitsOf(frameOf(one({ tone: 'active', level: undefined }), { variant: 'tile' })));
    // A level the household did not ask to see draws nothing.
    expect(bitsOf(frameOf(one({ level: 60 }), { variant: 'tile' }))).toBe(
      bitsOf(frameOf(one({ level: undefined }), { variant: 'tile' })),
    );
  });

  it('refuses a level outside 0-100 rather than drawing a bar full over it', () => {
    const refused = bitsOf(frameOf(one({ tone: 'active', level: 140 }), { variant: 'tile', showBar: true }));
    expect(refused).toBe(bitsOf(frameOf(one({ tone: 'active', level: undefined }), { variant: 'tile', showBar: true })));
  });

  it('never says when it changed: a panel shows one picture for up to an hour', () => {
    const asked = bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile', showChanged: true }));
    expect(asked).toBe(bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile' })));
  });

  it('keeps every tile where it was when the words change and the count does not', () => {
    /*
     * The refresh contract: a tile's rectangle is a function of the box and
     * how many readings there are, never of what they say. Two houses with the
     * same four readings saying different things draw their outlines in the
     * same places — every pixel of the one outline row the first tiles share is
     * the same, and the frames differ inside the tiles and nowhere else.
     */
    const other = HOUSE.map((reading, index) => ({
      ...reading,
      label: ['Hall', 'Utility room ceiling light', 'Sun', 'X'][index]!,
      value: ['Closed', '-3.2', 'Off', 'Opening · 5%'][index]!,
    }));
    const a = bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile' }));
    const b = bitsOf(frameOf(manifestOf(other), { variant: 'tile' }));
    expect(a).not.toBe(b);
    const edgeA = firstTileEdge(a);
    expect(firstTileEdge(b), 'the first tile moved').toEqual(edgeA);
    // And every tile along that row: the whole edge row is the same.
    const top = edgeA.row;
    expect(b.slice(top * 800, top * 800 + 800), 'a tile along the first row moved').toBe(a.slice(top * 800, top * 800 + 800));
  });

  it('honours the layout and a hidden state, which each move the frame', () => {
    const base = bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile' }));
    expect(bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile', tileLayout: 'vertical' }))).not.toBe(base);
    expect(bitsOf(frameOf(manifestOf(HOUSE), { variant: 'tile', hideState: true }))).not.toBe(base);
  });
});
