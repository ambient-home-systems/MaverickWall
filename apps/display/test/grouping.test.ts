import { describe, expect, it } from 'vitest';

import {
  canGroup,
  canUngroup,
  canvasBoxOf,
  cellIndexAt,
  defaultGroupLayout,
  groupWidgets,
  moveChildTo,
  renumberZ,
  ungroupTarget,
  ungroupWidget,
  unionBox,
  type Grouped,
} from '../src/grouping.js';
import { canvasSnapshot, widgetsForSave } from '../src/canvas-state.js';
import { childOnCanvas } from '../src/placement.js';

/**
 * Group and Ungroup as arithmetic (RFC 014 §5.1).
 *
 * The property everything here serves is the round trip: grouping and then
 * ungrouping is the identity on where every box is, to the three places the
 * canvas is saved in. A group is made a row or a column, so grouping *does*
 * move the boxes on the glass — into equal cells of their union — and what
 * makes the round trip hold anyway is that each child keeps the fractions it
 * was given at grouping time, which is what an ungroup restores.
 * `browser-editor.test.ts` §11 measures the same on a real page; this is the
 * arithmetic those pixels come from.
 */

const clock: Grouped = { id: 'c', type: 'clock', x: 0.05, y: 0.02, w: 0.3, h: 0.12, z: 0 };
const weather: Grouped = { id: 'w', type: 'weather', x: 0.4, y: 0.04, w: 0.25, h: 0.1, z: 1 };
const shift: Grouped = { id: 's', type: 'shift', x: 0.7, y: 0.02, w: 0.25, h: 0.14, z: 2 };
const month: Grouped = { id: 'm', type: 'calendar', x: 0.05, y: 0.2, w: 0.9, h: 0.7, z: 3 };
const wall: readonly Grouped[] = [clock, weather, shift, month];

describe('the union of a selection', () => {
  it('is the smallest rectangle holding every box, to three places', () => {
    expect(unionBox([clock, weather, shift])).toEqual({ x: 0.05, y: 0.02, w: 0.9, h: 0.14 });
    expect(unionBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('what may be grouped', () => {
  it('needs two or more boxes on the layout itself, none of them a group', () => {
    expect(canGroup(wall, ['c'])).toBe(false);
    expect(canGroup(wall, ['c', 'w'])).toBe(true);
    expect(canGroup(wall, ['c', 'nope'])).toBe(false);
    const grouped = groupWidgets(wall, ['c', 'w'], 'g');
    // A child, and a group: neither may go into another group.
    expect(canGroup(grouped, ['c', 's'])).toBe(false);
    expect(canGroup(grouped, ['g', 's'])).toBe(false);
    expect(canUngroup(grouped, ['g'])).toBe(true);
    expect(canUngroup(grouped, ['s'])).toBe(false);
    expect(canUngroup(grouped, ['g', 's'])).toBe(false);
  });

  it('names the group Ungroup acts on: the selected group, or the group every selected box is a child of', () => {
    const grouped = groupWidgets(wall, ['c', 'w'], 'g');
    expect(ungroupTarget(grouped, ['g'])).toBe('g');
    // A child is what a household has under the pointer after Group.
    expect(ungroupTarget(grouped, ['c'])).toBe('g');
    expect(ungroupTarget(grouped, ['c', 'w'])).toBe('g');
    // A mixed selection names nothing: a child with a box on the layout, a
    // child with its own group, two boxes on the layout, or nothing at all.
    expect(ungroupTarget(grouped, ['c', 's'])).toBeUndefined();
    expect(ungroupTarget(grouped, ['g', 'c'])).toBeUndefined();
    expect(ungroupTarget(grouped, ['s', 'm'])).toBeUndefined();
    expect(ungroupTarget(grouped, [])).toBeUndefined();
    expect(ungroupTarget(grouped, ['nope'])).toBeUndefined();
  });
});

describe('the layout a new group starts in', () => {
  it('is a row for boxes side by side and a column for boxes one above the other', () => {
    expect(defaultGroupLayout([clock, weather, shift])).toBe('row');
    expect(defaultGroupLayout([clock, month])).toBe('column');
    // Spread equally both ways reads as a row; one box has nothing to compare.
    expect(defaultGroupLayout([clock, { x: 0.35, y: 0.32, w: 0.3, h: 0.12 }])).toBe('row');
    expect(defaultGroupLayout([clock])).toBe('row');
  });
});

describe('making a group', () => {
  const grouped = groupWidgets(wall, ['c', 'w', 's'], 'g');
  const group = grouped.find((w) => w.id === 'g') as Grouped;
  const children = grouped.filter((w) => w.parentId === 'g');

  it('puts the group at the union and the children inside it as fractions of it', () => {
    expect(group).toMatchObject({ type: 'group', x: 0.05, y: 0.02, w: 0.9, h: 0.14, config: { layout: 'row' } });
    expect(children.map((c) => c.id)).toEqual(['c', 'w', 's']);
    // The clock sat at the union's own corner; the shift's right edge is the union's.
    expect(children[0]).toMatchObject({ x: 0, y: 0, w: 0.333, h: 0.857, z: 0 });
    expect(children[2]).toMatchObject({ x: 0.722, y: 0, w: 0.278, h: 1, z: 2 });
  });

  it('keeps each child’s own rectangle as its stored fractions, which is what an ungroup restores', () => {
    for (const before of [clock, weather, shift]) {
      const after = grouped.find((w) => w.id === before.id) as Grouped;
      const stored = childOnCanvas(group, after);
      expect(Math.abs(stored.x - before.x)).toBeLessThan(0.002);
      expect(Math.abs(stored.y - before.y)).toBeLessThan(0.002);
      expect(Math.abs(stored.w - before.w)).toBeLessThan(0.002);
      expect(Math.abs(stored.h - before.h)).toBeLessThan(0.002);
    }
  });

  it('draws the three side by side as a row of equal cells, so Group visibly makes one thing of them', () => {
    // Three boxes across the top band become a row: thirds of the union, and
    // the weather — which sat in the middle at a quarter of the width — is
    // drawn at the same width as its neighbours. `free` would have left every
    // box exactly where it was, which is what a household read as Group doing
    // nothing.
    const drawn = children.map((child) => canvasBoxOf(grouped, child));
    expect(drawn.map((box) => box.w)).toEqual([0.3, 0.3, 0.3]);
    expect(drawn.map((box) => box.x)).toEqual([0.05, 0.35, 0.65]);
    expect(drawn[1]!.w).not.toBeCloseTo(weather.w, 3);
    expect(drawn.every((box) => box.y === 0.02 && box.h === 0.14)).toBe(true);
  });

  it('stacks the group where the top of the selection was, and renumbers per scope', () => {
    // The month was above all three; the group takes their place below it.
    expect(grouped.filter((w) => w.parentId === undefined).map((w) => [w.id, w.z])).toEqual([
      ['g', 0],
      ['m', 1],
    ]);
    expect(children.map((c) => c.z)).toEqual([0, 1, 2]);
  });

  it('leaves a selection that cannot be grouped exactly as it was', () => {
    expect(groupWidgets(wall, ['c'], 'g')).toEqual(wall);
  });
});

describe('taking a group apart', () => {
  it('is the inverse of making one, to the three places the layout is saved in', () => {
    const grouped = groupWidgets(wall, ['c', 'w', 's'], 'g');
    const back = ungroupWidget(grouped, 'g');
    // The same save body: `canvas-state` is the comparison the save bar reads.
    expect(canvasSnapshot({ aspect: 0.5625, widgets: back })).toBe(canvasSnapshot({ aspect: 0.5625, widgets: wall }));
  });

  it('restores the stored fractions whatever layout the group was in', () => {
    // A row placed the three in thirds; the household asks for their own
    // arrangement back, which is what the fractions were kept for.
    const grouped = groupWidgets(wall, ['c', 'w', 's'], 'g').map((w) =>
      w.id === 'g' ? { ...w, config: { layout: 'row' } } : w,
    );
    const inRow = canvasBoxOf(grouped, grouped.find((w) => w.id === 'w') as Grouped);
    expect(inRow.x).not.toBeCloseTo(weather.x, 3);
    const back = ungroupWidget(grouped, 'g');
    expect(back.find((w) => w.id === 'w')).toMatchObject({ x: 0.4, y: 0.04, w: 0.25, h: 0.1 });
    expect(back.some((w) => w.type === 'group')).toBe(false);
    expect(back.every((w) => w.parentId === undefined)).toBe(true);
  });

  it('leaves anything that is not a group alone', () => {
    expect(ungroupWidget(wall, 'c')).toEqual(wall);
  });
});

describe('where a child is on the layout', () => {
  // A row as Group makes it, and the same group set `free` by the household.
  const asRow = groupWidgets(wall, ['c', 'w', 's'], 'g');
  const grouped = asRow.map((w) => (w.id === 'g' ? { ...w, config: { layout: 'free' } } : w));

  it('is its stored fractions through the group in a free group, and its cell in a row', () => {
    const free = canvasBoxOf(grouped, grouped.find((w) => w.id === 'w') as Grouped);
    expect(free.x).toBeCloseTo(0.4, 2);
    const row = canvasBoxOf(asRow, asRow.find((w) => w.id === 'w') as Grouped);
    expect(row).toEqual({ x: 0.35, y: 0.02, w: 0.3, h: 0.14 });
  });

  it('answers which cell a point is over, and the nearest cell outside the group', () => {
    expect(cellIndexAt(asRow, 'g', { x: 0.1, y: 0.05 })).toBe(0);
    expect(cellIndexAt(asRow, 'g', { x: 0.5, y: 0.05 })).toBe(1);
    expect(cellIndexAt(asRow, 'g', { x: 0.9, y: 0.5 })).toBe(2);
    expect(cellIndexAt(grouped, 'g', { x: 0.9, y: 0.5 })).toBeDefined();
    expect(cellIndexAt(asRow, 'nope', { x: 0, y: 0 })).toBeUndefined();
  });

  it('reorders a child among its siblings and nothing else', () => {
    const moved = moveChildTo(asRow, 'c', 2);
    expect(moved.filter((w) => w.parentId === 'g').sort((a, b) => a.z - b.z).map((w) => w.id)).toEqual(['w', 's', 'c']);
    expect(moved.find((w) => w.id === 'm')).toEqual(asRow.find((w) => w.id === 'm'));
    expect(moveChildTo(asRow, 'c', 99).find((w) => w.id === 'c')?.z).toBe(2);
    expect(moveChildTo(asRow, 'm', 1)).toEqual(asRow);
  });
});

describe('the save body of a grouped layout', () => {
  it('posts the layout’s boxes first, then each child with its parent and a z of its own', () => {
    const grouped = groupWidgets(wall, ['c', 'w', 's'], 'g');
    const rows = widgetsForSave(grouped);
    expect(rows.map((r) => [r.id, r.z, r.parentId])).toEqual([
      ['g', 0, undefined],
      ['m', 1, undefined],
      ['c', 0, 'g'],
      ['w', 1, 'g'],
      ['s', 2, 'g'],
    ]);
    expect(JSON.stringify(rows[0])).not.toContain('parentId');
  });

  it('renumbers per scope, stably', () => {
    const out = renumberZ([
      { id: 'a', type: 'clock', x: 0, y: 0, w: 1, h: 1, z: 7 },
      { id: 'g', type: 'group', x: 0, y: 0, w: 1, h: 1, z: 3 },
      { id: 'k', type: 'notes', x: 0, y: 0, w: 1, h: 1, z: 9, parentId: 'g' },
      { id: 'j', type: 'notes', x: 0, y: 0, w: 1, h: 1, z: 4, parentId: 'g' },
    ]);
    expect(out.map((w) => [w.id, w.z])).toEqual([['g', 0], ['a', 1], ['j', 0], ['k', 1]]);
  });
});
