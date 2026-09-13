import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { todoListHandle, type Manifest } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { EPAPER_RENDERER_VERSION } from '../src/epaper/frame.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';

/**
 * The To-do widget on a panel, drawing a Home Assistant list (RFC 012 §6.3).
 *
 * Two things are held here and they fail differently. **A widget with no
 * `list` is byte-identical to what it drew before this existed** — pinned
 * against hashes taken from the renderer as it was on `main` the day this
 * landed, at three panel sizes and three configs, because "absent means the
 * typed items" is the reading the wall takes and a panel that read the key any
 * other way would be `shifts[0]` for the sixth time. And **a widget naming a
 * list draws that list**, resolved through the same handle the manifest mints,
 * with `showDone` bringing the completed items back as filled boxes.
 */

const HANDLE = todoListHandle('todo.shopping');

function manifest(withPanel = true): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [],
    sources: [],
    panels: withPanel
      ? {
          todo: {
            lists: [
              {
                key: HANDLE,
                name: 'Shopping',
                canTick: true,
                open: 2,
                items: [
                  { id: 'h1', summary: 'Milk', done: false, due: null, position: 0 },
                  { id: 'h2', summary: 'Eggs — free range', done: false, due: null, position: 1 },
                  { id: 'h3', summary: 'Bread', done: true, due: null, position: 2 },
                ],
              },
            ],
          },
        }
      : {},
  } as unknown as Manifest;
}

const BOX = { x: 0.05, y: 0.05, w: 0.5, h: 0.6 } as const;

function frame(config: Record<string, unknown>, size: readonly [number, number], withPanel = true): string {
  const m = manifest(withPanel);
  const widget: PlacedEpaperWidget = { type: 'todo', ...BOX, z: 0, config };
  const fb: Framebuffer = renderFreeformEpaper(buildEpaperModel(m), m, [widget], {
    width: size[0],
    height: size[1],
  });
  let bits = '';
  for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) bits += fb.get(x, y) ? '1' : '0';
  return bits;
}

const sha = (bits: string): string => createHash('sha256').update(bits).digest('hex');

/**
 * The frames as `main` drew them before `list` existed, hashed.
 *
 * Taken by rendering the same three configs at the same three sizes through
 * the previous `widgets.ts` — with an empty `panels`, since no panel existed —
 * in a scratch test, then deleted. A hash rather than a stored frame, so a
 * regression fails on one line rather than on a diff of 900,000 bits; the
 * mechanism is the same one the QR test learned from: decode, do not look.
 */
const BEFORE: readonly {
  readonly size: readonly [number, number];
  readonly config: Record<string, unknown>;
  readonly hash: string;
}[] = [
  { size: [800, 480], config: { items: ['Milk', 'Bread', 'A rather longer line about the bins'] }, hash: '0a37e6fb2f110676bacecac4b95a36e79cd62880940de9b8ce7661cbbc810164' },
  { size: [800, 480], config: { items: ['Milk'], showTitle: true, title: 'Shopping' }, hash: 'ebd91da566ea6176ecf3ad951a0fd04d90cba22f301911dee9ccfb37f2462b62' },
  { size: [800, 480], config: {}, hash: '8a7d45306f6540043619d2273173f31a11e4a5dbf436a4e03a326104a8bc23e5' },
  { size: [1872, 1404], config: { items: ['Milk', 'Bread', 'A rather longer line about the bins'] }, hash: '30ebea7d69d99ed7500380f333c7877515fbcbe56d52aacdc80869422918db49' },
  { size: [1872, 1404], config: { items: ['Milk'], showTitle: true, title: 'Shopping' }, hash: '8cc1e26e36a37e17510effe25e5787110117d492805a7587d19a9e80ed494fb2' },
  { size: [1872, 1404], config: {}, hash: '4db1dde73b1f8385392be3eaf482fd2b4ea303248b66adef6dafa8ec59c45060' },
  { size: [400, 300], config: { items: ['Milk', 'Bread', 'A rather longer line about the bins'] }, hash: '6e379a14f1b9100ea18092aa2ce0cbd78b0da0f5eeb234d0d437008af4871f60' },
  { size: [400, 300], config: { items: ['Milk'], showTitle: true, title: 'Shopping' }, hash: '307b9fb8d74f8bf21aa58de6c35c285e0c0292685c8c3a969f1ddf709bf39e35' },
  { size: [400, 300], config: {}, hash: '4ccf7bc042817c2ccf485959799848d23933d2c75f02eaa27d3d589ef1f29c34' },
];

describe('a widget with no list draws the typed items, byte for byte as before', () => {
  for (const { size, config, hash } of BEFORE) {
    it(`${size[0]}x${size[1]} ${JSON.stringify(config)}`, () => {
      // With no panel, as the old renderer had; and with the panel present,
      // which the old renderer never saw — the key is absent, so it is unread.
      expect(sha(frame(config, size, false))).toBe(hash);
      expect(sha(frame(config, size, true))).toBe(hash);
    });
  }

  it('reads an empty string as an absence, and ignores showDone on a typed list', () => {
    const typed = { items: ['Milk', 'Bread'] };
    const at = [800, 480] as const;
    expect(frame({ ...typed, list: '' }, at)).toBe(frame(typed, at));
    expect(frame({ ...typed, showDone: true }, at)).toBe(frame(typed, at));
  });
});

describe('a widget naming a list draws that list', () => {
  const at = [800, 480] as const;

  it('draws the open items and not the completed one, and moves ink to say so', () => {
    const listed = frame({ list: 'todo.shopping' }, at);
    const typed = frame({ items: ['Milk', 'Eggs — free range'] }, at);
    // The same two open items typed by hand draw the same rows: one renderer,
    // one row, whichever source the words came from.
    expect(listed).toBe(typed);
    // And a list with a third, completed, item is not the frame with it drawn.
    expect(listed).not.toBe(frame({ items: ['Milk', 'Eggs — free range', 'Bread'] }, at));
  });

  it('brings the completed item back with showDone, as a filled box', () => {
    const without = frame({ list: 'todo.shopping' }, at);
    const withDone = frame({ list: 'todo.shopping', showDone: true }, at);
    expect(withDone).not.toBe(without);
    // Not merely a third row: the same three items typed draw an *empty* third
    // box, so the frame with a filled one differs from that too.
    expect(withDone).not.toBe(frame({ items: ['Milk', 'Eggs — free range', 'Bread'] }, at));
  });

  it('leaves the typed items where they are, unread while a list is named', () => {
    // A household who tries a list and comes back finds their lines untouched,
    // and while the list is chosen those lines change nothing on the panel.
    expect(frame({ list: 'todo.shopping', items: ['Something else'] }, at)).toBe(
      frame({ list: 'todo.shopping' }, at),
    );
  });

  it('says so when the list is not in the panel, rather than drawing typed items', () => {
    const missing = frame({ list: 'todo.read_only', items: ['Milk'] }, at);
    expect(missing).not.toBe(frame({ items: ['Milk'] }, at));
    expect(missing.includes('1')).toBe(true);
    // And the same when there is no panel at all — the minute between a list
    // being un-watched and the widget being omitted.
    expect(frame({ list: 'todo.shopping' }, at, false)).toBe(missing);
  });

  it('resolves the stored entity id through the manifest’s own handle', () => {
    // The panel is keyed by `todoListHandle`; the widget stores the entity id.
    // A renderer matching on the raw id would find nothing and draw the note.
    expect(frame({ list: 'todo.shopping' }, at)).not.toBe(frame({ list: 'todo.nope' }, at));
    expect(HANDLE).not.toBe('todo.shopping');
    expect(HANDLE).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the renderer version', () => {
  it('was bumped for the pixel change, so a panel with a list on it re-downloads', () => {
    expect(EPAPER_RENDERER_VERSION).toBeGreaterThanOrEqual(9);
  });
});
