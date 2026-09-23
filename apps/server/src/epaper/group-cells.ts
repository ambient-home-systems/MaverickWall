/**
 * `apps/display/src/group-cells.ts`, transcribed, and nothing else (RFC 014
 * §5.1).
 *
 * The panel places a group's children from the same cells the wall does, so a
 * panel following a wall cannot disagree with it about where a child sits —
 * one stored value read two ways is the fault this repository keeps paying
 * for. The display bundle has no bundler and the server cannot import it, so
 * the module is written twice and `group-cells-parity.test.ts` holds
 * everything from the marker below to being character-identical, the seam
 * `tier-parity`, `epaper-ladder-parity` and `month-spans-parity` already sit
 * at. Edit the display's copy first; this one follows it.
 */

/* ---- transcribed, and nothing else ------------------------------------ */

/** The layouts a group offers, in the order the schema names them. */
export const GROUP_LAYOUTS = ['row', 'column', 'grid'] as const;
export type GroupLayout = (typeof GROUP_LAYOUTS)[number];

/** A grid's width in cells when the household has not said; the schema's own bounds. */
export const GROUP_COLUMNS_DEFAULT = 2;
export const GROUP_COLUMNS_MIN = 2;
export const GROUP_COLUMNS_MAX = 4;

/** One child's place, as fractions 0..1 of the group's inner box. */
export interface GroupCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Which layout a group's config asks for. **Absent means `row`**, and so does
 * anything the table does not name — a config is JSON this process wrote at
 * some version, and a value a newer server knows must draw *something* here.
 */
export function groupLayoutOf(config: unknown): GroupLayout {
  const raw =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['layout'] : undefined;
  return raw === 'column' || raw === 'grid' ? raw : 'row';
}

/**
 * How many cells across a `grid` draws. Absent means two; out of the schema's
 * own bounds is refused back to the default rather than clamped, the rule
 * `canvasGutterStep` states for a hand-edited value.
 */
export function groupColumnsOf(config: unknown): number {
  const raw =
    typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['columns'] : undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return GROUP_COLUMNS_DEFAULT;
  return raw >= GROUP_COLUMNS_MIN && raw <= GROUP_COLUMNS_MAX ? raw : GROUP_COLUMNS_DEFAULT;
}

/**
 * The cells a group of `count` children divides its inner box into, in child
 * order — the first cell is the first child's.
 *
 * Equal shares, no gap: the boxes tile, exactly as the canvas's own do, and
 * the room between two children is what each child's own box spends on its
 * padding, twice. A grid fills row by row, `columns` across, and a last row
 * with fewer children than columns leaves its trailing cells empty rather than
 * stretching the children in it — a child's width is a property of the
 * layout, and a box that changes width when a sibling is removed is the
 * reflow a fixed canvas exists not to do.
 */
export function groupCells(config: unknown, count: number): GroupCell[] {
  const n = Math.max(0, Math.trunc(count));
  if (n === 0) return [];
  const layout = groupLayoutOf(config);
  if (layout === 'row') {
    return Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0, w: 1 / n, h: 1 }));
  }
  if (layout === 'column') {
    return Array.from({ length: n }, (_, i) => ({ x: 0, y: i / n, w: 1, h: 1 / n }));
  }
  const columns = groupColumnsOf(config);
  const rows = Math.ceil(n / columns);
  return Array.from({ length: n }, (_, i) => ({
    x: (i % columns) / columns,
    y: Math.floor(i / columns) / rows,
    w: 1 / columns,
    h: 1 / rows,
  }));
}

/** A widget that sits inside a group, read defensively off any document. */
export function parentIdOf(widget: { readonly parentId?: unknown }): string | undefined {
  return typeof widget.parentId === 'string' && widget.parentId !== '' ? widget.parentId : undefined;
}

/**
 * Every group's children, by the group's id, each list in `z` order — the
 * order the cells above are handed out in. Stable for equal `z`, so two
 * children a template placed at the same level keep the template's order.
 *
 * A child whose parent is not a group in `widgets` is left out: the server
 * refuses that row twice already, and a bundle reading a document it did not
 * write must not draw a box at fractions of a box that is not there.
 */
export function groupChildren<
  T extends { readonly id: string; readonly type: string; readonly z: number; readonly parentId?: unknown },
>(widgets: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const widget of widgets) {
    if (widget.type === 'group' && parentIdOf(widget) === undefined) out.set(widget.id, []);
  }
  const arrival = new Map<T, number>();
  widgets.forEach((widget, index) => {
    const parent = parentIdOf(widget);
    if (parent === undefined || widget.type === 'group') return;
    arrival.set(widget, index);
    out.get(parent)?.push(widget);
  });
  for (const children of out.values()) {
    children.sort((a, b) => a.z - b.z || (arrival.get(a) ?? 0) - (arrival.get(b) ?? 0));
  }
  return out;
}

/**
 * The widgets placed on the canvas itself: everything with no parent, and
 * never a group that names one (nesting is one level, refused here as it is
 * on the server).
 */
export function topLevelWidgets<T extends { readonly type: string; readonly parentId?: unknown }>(
  widgets: readonly T[],
): T[] {
  return widgets.filter((widget) => parentIdOf(widget) === undefined);
}
