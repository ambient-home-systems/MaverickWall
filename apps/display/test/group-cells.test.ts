import { describe, expect, it } from 'vitest';

import {
  GROUP_COLUMNS_DEFAULT,
  groupCells,
  groupChildren,
  groupColumnsOf,
  groupLayoutOf,
  topLevelWidgets,
} from '../src/group-cells.js';

/**
 * Where a group puts its children (RFC 014 §5.1), as a pure table.
 *
 * The property every assertion here serves is the stability contract: a cell
 * is a function of the layout and the child count and of nothing a child
 * draws, so the same arrangement always answers the same rectangles. The
 * wall's and the panel's placements both read this, and
 * `group-cells-parity.test.ts` on the server holds the two copies together.
 */

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

describe('groupCells', () => {
  it('divides a row across and a column down, equally and edge to edge', () => {
    const row = groupCells({ layout: 'row' }, 3);
    expect(row.map((c) => [c.x, c.w])).toEqual([[0, 1 / 3], [1 / 3, 1 / 3], [2 / 3, 1 / 3]]);
    expect(row.every((c) => c.y === 0 && c.h === 1)).toBe(true);
    const column = groupCells({ layout: 'column' }, 4);
    expect(column.map((c) => [c.y, c.h])).toEqual([[0, 0.25], [0.25, 0.25], [0.5, 0.25], [0.75, 0.25]]);
    expect(column.every((c) => c.x === 0 && c.w === 1)).toBe(true);
    // The boxes tile: the shares add to the whole and nothing overlaps.
    expect(sum(row.map((c) => c.w))).toBeCloseTo(1, 12);
    expect(sum(column.map((c) => c.h))).toBeCloseTo(1, 12);
  });

  it('fills a grid row by row, columns across, and leaves a short last row short', () => {
    const grid = groupCells({ layout: 'grid', columns: 3 }, 5);
    expect(grid).toEqual([
      { x: 0, y: 0, w: 1 / 3, h: 0.5 },
      { x: 1 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 0.5 },
      { x: 0, y: 0.5, w: 1 / 3, h: 0.5 },
      // A child alone on the last row keeps its column's width: a box that
      // grew when a sibling was removed would be the reflow a fixed canvas
      // exists not to do.
      { x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5 },
    ]);
  });

  it('reads nothing but the layout and the count', () => {
    // Two configs that differ in everything a child could carry, and in the
    // keys a group does not read, answer the same cells.
    const a = groupCells({ layout: 'row', title: 'Utilities', count: 9, text: 'x' }, 3);
    const b = groupCells({ layout: 'row' }, 3);
    expect(a).toEqual(b);
  });

  it('answers nothing for no children, and row for a layout it does not know', () => {
    expect(groupCells({ layout: 'row' }, 0)).toEqual([]);
    expect(groupCells(undefined, 2)).toEqual(groupCells({ layout: 'row' }, 2));
    expect(groupLayoutOf({ layout: 'spiral' })).toBe('row');
    expect(groupLayoutOf(null)).toBe('row');
    expect(groupLayoutOf({ layout: 'grid' })).toBe('grid');
  });

  it('takes its grid width from `columns`, within the schema’s bounds, else two', () => {
    expect(groupColumnsOf({ columns: 4 })).toBe(4);
    expect(groupColumnsOf({ columns: 2 })).toBe(2);
    expect(groupColumnsOf({})).toBe(GROUP_COLUMNS_DEFAULT);
    // Refused back to the default rather than clamped, like a gutter step.
    expect(groupColumnsOf({ columns: 9 })).toBe(GROUP_COLUMNS_DEFAULT);
    expect(groupColumnsOf({ columns: 1 })).toBe(GROUP_COLUMNS_DEFAULT);
    expect(groupColumnsOf({ columns: 2.5 })).toBe(GROUP_COLUMNS_DEFAULT);
    expect(groupColumnsOf({ columns: '3' })).toBe(GROUP_COLUMNS_DEFAULT);
  });
});

describe('groupChildren and topLevelWidgets', () => {
  const widgets = [
    { id: 'g', type: 'group', z: 0 },
    { id: 'c2', type: 'notes', z: 2, parentId: 'g' },
    { id: 'c0', type: 'clock', z: 0, parentId: 'g' },
    { id: 'c1', type: 'weather', z: 1, parentId: 'g' },
    { id: 'cal', type: 'calendar', z: 1 },
    // A child whose parent is not on this canvas, and a group inside a group.
    { id: 'orphan', type: 'notes', z: 0, parentId: 'nope' },
    { id: 'nested', type: 'group', z: 0, parentId: 'g' },
  ];

  it('hands each group its children in z order, and nobody an orphan', () => {
    const children = groupChildren(widgets);
    expect([...children.keys()]).toEqual(['g']);
    expect(children.get('g')?.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('keeps arrival order between equal z, so a template’s order is the row’s', () => {
    const tied = [
      { id: 'g', type: 'group', z: 0 },
      { id: 'b', type: 'notes', z: 0, parentId: 'g' },
      { id: 'a', type: 'clock', z: 0, parentId: 'g' },
    ];
    expect(groupChildren(tied).get('g')?.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('places on the canvas only what names no parent', () => {
    expect(topLevelWidgets(widgets).map((w) => w.id)).toEqual(['g', 'cal']);
    // A `parentId` that is not a string is no parent — a document from a server
    // this bundle did not ship with is read, never trusted.
    expect(topLevelWidgets([{ id: 'x', type: 'clock', parentId: 7 }]).map((w) => w.id)).toEqual(['x']);
  });
});
