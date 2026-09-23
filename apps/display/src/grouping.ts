/**
 * Group and Ungroup, as arithmetic on a list of boxes (RFC 014 §5.1).
 *
 * A group is a box whose children carry its id as `parentId` and their own
 * `x`/`y`/`w`/`h` as fractions of *its* box. Making one is therefore a
 * change of coordinates — from fractions of the layout to fractions of the
 * union of what was selected — and taking one apart is the same change the
 * other way. Both are pure, and both are here rather than in `boot()` for the
 * reason `history.ts`, `placement.ts` and `canvas-state.ts` are: there is no
 * DOM in this package's test suite, and a rule that lives inside a click
 * handler is a rule nothing can check. What the editor adds is one `record()`
 * before either, so each is one undo step however many boxes it moves.
 *
 * Nothing on the glass moves when a group is made. It is written `free`, so
 * its children draw at their stored fractions — the exact rectangles they
 * had — and the wall is identical before and after; only when the household
 * picks a row, a column or a grid does the group start placing them from
 * order. An ungroup restores those stored fractions whatever the layout was,
 * which is what the fractions are kept for.
 */

import { childCells, groupChildren, parentIdOf, topLevelWidgets } from './group-cells.js';
import { childOnCanvas, type Box } from './placement.js';

/** A widget as this module needs it: a box with an id, a type, a z and maybe a parent. */
export interface Grouped extends Box {
  readonly id: string;
  readonly type: string;
  readonly z: number;
  readonly parentId?: string | undefined;
  readonly config?: Record<string, unknown> | undefined;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The smallest rectangle holding every box. Empty input is the empty box at the origin. */
export function unionBox(boxes: readonly Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: round3(left), y: round3(top), w: round3(right - left), h: round3(bottom - top) };
}

/**
 * Whether a selection can become a group: two or more boxes, every one on
 * the layout itself, and none already a group. Nesting is one level and is
 * refused on the server twice; refusing it here is what keeps the Group
 * button honest rather than a control that posts a 400.
 */
export function canGroup(widgets: readonly Grouped[], ids: readonly string[]): boolean {
  if (ids.length < 2) return false;
  const byId = new Map(widgets.map((w) => [w.id, w]));
  return ids.every((id) => {
    const widget = byId.get(id);
    return widget !== undefined && widget.type !== 'group' && parentIdOf(widget) === undefined;
  });
}

/** Whether the one selected box is a group that can be taken apart. */
export function canUngroup(widgets: readonly Grouped[], ids: readonly string[]): boolean {
  if (ids.length !== 1) return false;
  const widget = widgets.find((w) => w.id === ids[0]);
  return widget !== undefined && widget.type === 'group' && parentIdOf(widget) === undefined;
}

/**
 * `z` rewritten as consecutive integers, per scope: the layout's own boxes
 * 0..n in their order, and each group's children 0..m in theirs. The two
 * scales are never sorted against each other, which is the rule the server
 * reads rows by, and the overlay draws its stacking from this.
 */
export function renumberZ<T extends Grouped>(widgets: readonly T[]): T[] {
  const arrival = new Map<string, number>(widgets.map((w, index) => [w.id, index]));
  const byZ = (a: T, b: T): number => a.z - b.z || (arrival.get(a.id) ?? 0) - (arrival.get(b.id) ?? 0);
  const out: T[] = [];
  const top = topLevelWidgets(widgets).slice().sort(byZ);
  top.forEach((widget, index) => out.push({ ...widget, z: index }));
  const children = groupChildren(widgets);
  for (const widget of top) {
    (children.get(widget.id) ?? []).forEach((child, index) => out.push({ ...child, z: index }));
  }
  return out;
}

/**
 * The selected boxes become the children of one new group, `free`, at the
 * union of their rectangles. Each child's box is rewritten as fractions of
 * that union to three places — the form it is saved in — and its `z` as its
 * place among its siblings; the group takes the highest `z` of what it
 * absorbed, so it stacks where the top of the selection did.
 *
 * Returns the whole list, so the caller replaces its canvas in one
 * assignment; a selection that cannot be grouped comes back unchanged.
 */
export function groupWidgets<T extends Grouped>(
  widgets: readonly T[],
  ids: readonly string[],
  groupId: string,
): T[] {
  if (!canGroup(widgets, ids)) return widgets.slice();
  const members = widgets.filter((w) => ids.includes(w.id)).sort((a, b) => a.z - b.z);
  const union = unionBox(members);
  const group = {
    id: groupId,
    type: 'group',
    x: union.x,
    y: union.y,
    w: union.w,
    h: union.h,
    z: Math.max(...members.map((m) => m.z)),
    config: { layout: 'free' },
  } as unknown as T;
  const children = members.map((member, index) => ({
    ...member,
    parentId: groupId,
    x: round3(union.w > 0 ? (member.x - union.x) / union.w : 0),
    y: round3(union.h > 0 ? (member.y - union.y) / union.h : 0),
    w: round3(union.w > 0 ? member.w / union.w : 1),
    h: round3(union.h > 0 ? member.h / union.h : 1),
    z: index,
  }));
  const rest = widgets.filter((w) => !ids.includes(w.id));
  return renumberZ([...rest, group, ...children]);
}

/**
 * A group taken apart: its children come back onto the layout at the
 * rectangles their stored fractions describe, stacked where the group was,
 * and the group's row goes. The stored fractions rather than the cells an
 * ordered layout drew them in — a row put the boxes where the row wanted
 * them, and this is the household asking for their own arrangement back.
 */
export function ungroupWidget<T extends Grouped>(widgets: readonly T[], groupId: string): T[] {
  if (!canUngroup(widgets, [groupId])) return widgets.slice();
  const group = widgets.find((w) => w.id === groupId) as T;
  const members = (groupChildren(widgets).get(groupId) ?? []) as T[];
  const restored = members.map((child, index) => {
    const { parentId: _gone, ...rest } = child;
    void _gone;
    return { ...rest, ...childOnCanvas(group, child), z: group.z + index } as T;
  });
  const others = widgets
    .filter((w) => w.id !== groupId && parentIdOf(w) !== groupId)
    .map((w) => (parentIdOf(w) === undefined && w.z > group.z ? { ...w, z: w.z + members.length } : w));
  return renumberZ([...others, ...restored]);
}

/**
 * Where a box is on the layout: its own fractions for a box on the layout,
 * and for a child the cell its group gives it — from the order in a row, a
 * column or a grid, and from its stored fractions in a `free` group —
 * resolved through the parent's box. The one place the overlay asks, so a
 * child's drag box and the wall's own placement cannot disagree.
 */
export function canvasBoxOf(widgets: readonly Grouped[], widget: Grouped): Box {
  const parentId = parentIdOf(widget);
  if (parentId === undefined) return { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
  const parent = widgets.find((w) => w.id === parentId);
  if (parent === undefined) return { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
  const siblings = groupChildren(widgets).get(parentId) ?? [];
  const index = siblings.findIndex((one) => one.id === widget.id);
  const cell = childCells(parent.config, siblings)[index];
  if (cell === undefined) return childOnCanvas(parent, widget);
  return childOnCanvas(parent, cell);
}

/**
 * Which of a group's cells a point on the layout is over, for reordering a
 * child in a row, a column or a grid by dragging it: the index of the cell
 * whose rectangle holds the point, or the nearest cell by centre when the
 * point has left the group. Nothing for a `free` group, where dragging moves.
 */
export function cellIndexAt(
  widgets: readonly Grouped[],
  groupId: string,
  point: { readonly x: number; readonly y: number },
): number | undefined {
  const group = widgets.find((w) => w.id === groupId);
  if (group === undefined) return undefined;
  const siblings = groupChildren(widgets).get(groupId) ?? [];
  const cells = childCells(group.config, siblings);
  if (cells.length === 0) return undefined;
  const local = {
    x: group.w > 0 ? (point.x - group.x) / group.w : 0,
    y: group.h > 0 ? (point.y - group.y) / group.h : 0,
  };
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  cells.forEach((cell, index) => {
    if (local.x >= cell.x && local.x < cell.x + cell.w && local.y >= cell.y && local.y < cell.y + cell.h) {
      best = index;
      bestDistance = -1;
      return;
    }
    if (bestDistance < 0) return;
    const dx = local.x - (cell.x + cell.w / 2);
    const dy = local.y - (cell.y + cell.h / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * A child moved to another place in its group's order — the reorder a drag
 * or an arrow key performs in a row, a column or a grid. Siblings shift to
 * make room and every child's `z` is renumbered from the new order; nothing
 * outside the group changes. Out of range clamps to the ends.
 */
export function moveChildTo<T extends Grouped>(widgets: readonly T[], childId: string, index: number): T[] {
  const child = widgets.find((w) => w.id === childId);
  const parentId = child === undefined ? undefined : parentIdOf(child);
  if (child === undefined || parentId === undefined) return widgets.slice();
  const siblings = (groupChildren(widgets).get(parentId) ?? []) as T[];
  const from = siblings.findIndex((one) => one.id === childId);
  if (from === -1) return widgets.slice();
  const to = Math.min(siblings.length - 1, Math.max(0, Math.trunc(index)));
  if (to === from) return widgets.slice();
  const order = siblings.slice();
  order.splice(from, 1);
  order.splice(to, 0, child);
  const z = new Map(order.map((one, at) => [one.id, at]));
  return widgets.map((w) => (z.has(w.id) ? { ...w, z: z.get(w.id) as number } : w));
}
