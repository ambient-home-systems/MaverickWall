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
 * A group made by Group is *ordered* from the start — a row when what was
 * selected sat side by side, a column when it sat one above the other
 * (`defaultGroupLayout`) — so making one visibly does something: the boxes
 * take equal cells of their union and move as one from then on. It used to
 * be written `free`, which drew every child at the exact rectangle it had,
 * and a household reported that as Group doing nothing at all: nothing on
 * the glass changed, nothing said the boxes were grouped, and the only
 * effect anybody could find was that each box would no longer leave the
 * union. `free` is still on the group's own settings for the household who
 * wants their arrangement kept and merely moved together. Either way the
 * children's own fractions are what they were given at grouping time, and
 * an ungroup restores them whatever the layout became — which is what the
 * fractions are kept for.
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
 * Which group Ungroup would take apart for this selection: the one selected
 * group, or the group every selected box is a child of. The second half is
 * the reason this exists beside `canUngroup`. A group's own box sits under
 * its children, so what a household has under the pointer after pressing
 * Group is a child, and an Ungroup that only answered to the group's own box
 * was a control they could not find — "there is no way to ungroup them".
 * Nothing for a selection that mixes groups, children of different groups,
 * or boxes on the layout.
 */
export function ungroupTarget(widgets: readonly Grouped[], ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined;
  if (canUngroup(widgets, ids)) return ids[0];
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const parents = new Set<string | undefined>();
  for (const id of ids) {
    const widget = byId.get(id);
    parents.add(widget === undefined ? undefined : parentIdOf(widget));
  }
  if (parents.size !== 1) return undefined;
  const [parentId] = parents;
  return parentId !== undefined && canUngroup(widgets, [parentId]) ? parentId : undefined;
}

/**
 * The layout a new group starts in: `row` when the selection's centres are
 * spread more across than down, `column` otherwise. Two boxes side by side
 * become a row and two stacked become a column, which is the arrangement
 * the household already had, tidied — where a fixed `row` would stack two
 * vertically arranged boxes into a horizontal strip of two and read as the
 * group breaking the layout it was asked to hold together.
 */
export function defaultGroupLayout(members: readonly Box[]): 'row' | 'column' {
  if (members.length < 2) return 'row';
  const xs = members.map((m) => m.x + m.w / 2);
  const ys = members.map((m) => m.y + m.h / 2);
  const across = Math.max(...xs) - Math.min(...xs);
  const down = Math.max(...ys) - Math.min(...ys);
  return across >= down ? 'row' : 'column';
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
 * The selected boxes become the children of one new group at the union of
 * their rectangles, laid out as a row or a column by `defaultGroupLayout`.
 * Each child's box is rewritten as fractions of that union to three places —
 * the form it is saved in, and what an ungroup restores — and its `z` as its
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
    config: { layout: defaultGroupLayout(members) },
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
