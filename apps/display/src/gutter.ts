/**
 * The room between the widgets on a wall, as CSS lengths (RFC 014 §4.4).
 *
 * Pure, and its own module for the reason `widget-options.ts`, `ink.ts`,
 * `ladder.ts`, `placement.ts`, `omission.ts` and `tiers.ts` are: there is no
 * DOM in this package's test suite, so a rule resolved inside a
 * `style.setProperty` call is a rule nothing can check.
 *
 * **A step is paid for out of two budgets, and which one matters.** The
 * spacing scale declares three permissions, and two of them bear on the space
 * between two widgets: *a widget box spends at most step 4 on padding, total,
 * per axis*, and *the canvas spends at most step 5 between the boxes it
 * holds*. The wall has always spent the whole of the first and **none** of the
 * second — the boxes tile, so the only room between two of them is twice the
 * `.fw` padding, which is `calc(var(--s4) / 2)` a side and `--s4` in total.
 *
 * So the ladder is one household-facing number and the renderer decides how to
 * pay for it. Up to `--s4` it comes out of the widget's own padding, which is
 * what shipped first. Past that the padding stays at its permission and the
 * **canvas** pays, by taking room out of the box rectangle — the boxes stop
 * tiling and the wall's own ground shows between them. That is the honest
 * reading of "room the boxes do not own", and it is why the two halves are
 * separate properties rather than one larger padding: a widget box that spent
 * `--s5` on padding would be spending the canvas's budget out of its own, on a
 * fixed layout with no scrollbar where chrome competes with content for every
 * pixel.
 *
 * The two mechanisms are not interchangeable even where the arithmetic agrees.
 * For a widget with no background of its own they move the content by the same
 * distance — but on a theme that draws a widget as a card (Panels), padding
 * grows the card and an inset opens a gap *between* cards, which is the thing
 * a household asking for an airier wall is actually asking for.
 */

/** What a step costs, and out of whose budget. */
export interface GutterStep {
  /**
   * The widget box's own padding, as the whole gutter — `.fw` halves it, so
   * two adjacent boxes are separated by this and nothing else while the boxes
   * still tile. Never past `--s4`, which is that box's whole permission.
   */
  readonly padding: string;
  /**
   * What the canvas takes out of each box edge that is **not** the edge of the
   * layout. `0px` below step 5, where the boxes still tile.
   */
  readonly canvas: string;
}

/**
 * Step to what it spends, and the table is the spec.
 *
 * `0px` rather than `0` throughout because both values are substituted into a
 * `calc()`: `calc(0 / 2)` is invalid — a bare zero in `calc` has no unit to
 * divide — and an invalid custom-property substitution makes the whole
 * declaration compute to its unset value, which for `padding` is `0` by
 * accident rather than by design. Getting the right pixels for the wrong
 * reason at exactly one step is how the next edit to this file breaks
 * silently.
 *
 * Step 4 is what every wall drew before any of this existed, and the two above
 * it are the canvas budget arriving: `--s3` and then `--s5`, its stated
 * ceiling. Those two rungs are the *canvas's* spend rather than the total,
 * because the permission is written on the canvas's spend; the totals they
 * produce (`--s4 + --s3` and `--s4 + --s5`) are a sum of two budgets rather
 * than a spacing value anybody declares, and no rung has to name them.
 */
export const GUTTER_STEPS: readonly GutterStep[] = [
  { padding: '0px', canvas: '0px' },
  { padding: 'var(--s1)', canvas: '0px' },
  { padding: 'var(--s2)', canvas: '0px' },
  { padding: 'var(--s3)', canvas: '0px' },
  { padding: 'var(--s4)', canvas: '0px' },
  { padding: 'var(--s4)', canvas: 'var(--s3)' },
  { padding: 'var(--s4)', canvas: 'var(--s5)' },
];

/**
 * The step the wall draws when no household has chosen — today's spacing.
 *
 * Not a value this module ever writes: an unchosen wall gets *no* properties
 * at all, so `.fw`'s own `var(--fw-gutter, var(--s4))` fallback is what draws
 * it. This names the rung those pixels correspond to, so the settings control
 * can honestly check a segment on a wall that has never been asked.
 */
export const GUTTER_DEFAULT_STEP = 4;

/**
 * What a step spends, or `undefined` to write nothing.
 *
 * `undefined` is the load-bearing answer and the whole of rule nine here: the
 * properties are *removed* rather than set to a fallback, so `.fw`'s
 * `var(--fw-gutter, var(--s4))` reaches its own fallback, `boxRect` places the
 * box exactly where it was authored, and the wall draws precisely what it drew
 * before any of this existed. Read defensively because a manifest is a
 * document from a server that may be older or newer than this bundle — a step
 * this table has never heard of is no choice recorded, not a wall with no
 * spacing.
 */
export function gutterStepFor(step: unknown): GutterStep | undefined {
  if (typeof step !== 'number' || !Number.isInteger(step)) return undefined;
  return GUTTER_STEPS[step];
}

/**
 * How close to the edge of the layout a box counts as being on it.
 *
 * A box's rect is a fraction the editor wrote from a drag and a snap grid of
 * twenty-fourths, so an edge lands on `0` and `1` exactly in practice — but a
 * template's own fractions are authored by hand and `0.9999` is a rect
 * somebody meant to reach the edge. A twentieth of a per cent is under a pixel
 * on every wall this project measures.
 */
const EDGE = 0.0005;

/**
 * Where a box is drawn, once the canvas has taken its share.
 *
 * **A box gives up half the gutter on each side that is not the edge of the
 * layout**, which is the whole of the placement rule and the reason it can be
 * decided per box with no adjacency graph: two boxes that share an edge each
 * give up half of it and end up a full gutter apart, and a box against the
 * edge of the layout keeps that side.
 *
 * That last half is deliberate rather than incidental. Classic's boxes were
 * reworked to *tile* — sharing edges and reaching the edge of the layout —
 * because the wall was losing a third of itself to margins it did not need,
 * and insetting every side would hand a border of air straight back. An airier
 * wall opens the seams between widgets; it does not shrink the picture.
 */
export interface BoxRect {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly height: string;
  /**
   * How much this box lost on each axis, in total.
   *
   * `--bw`/`--bh` stay the *authored* fractions, because that is what a
   * template wrote and what the editor reads back — so a widget that sizes its
   * own type against its box (`--buw`/`--buh`: the clock, the countdown, the
   * image) would be sizing for room the canvas has just taken away, and a
   * `nowrap` clock would clip by exactly the gutter. `.fw` subtracts these,
   * and `0px` is the arithmetic identity that keeps an unchosen wall's
   * computed values untouched.
   */
  readonly insetX: string;
  readonly insetY: string;
}

export function boxRect(
  widget: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  canvasGutter: string | undefined,
): BoxRect {
  const pct = (value: number): string => `${value * 100}%`;
  const plain = {
    left: pct(widget.x),
    top: pct(widget.y),
    width: pct(widget.w),
    height: pct(widget.h),
    insetX: '0px',
    insetY: '0px',
  };
  if (canvasGutter === undefined || canvasGutter === '0px') return plain;

  const half = `calc(${canvasGutter} / 2)`;
  const atLeft = widget.x <= EDGE;
  const atTop = widget.y <= EDGE;
  const atRight = widget.x + widget.w >= 1 - EDGE;
  const atBottom = widget.y + widget.h >= 1 - EDGE;

  // A box that reaches every edge — a full-bleed background, say — is the
  // whole layout and has no seam with anything, so it is left alone.
  if (atLeft && atTop && atRight && atBottom) return plain;

  const lost = (a: boolean, b: boolean): string => {
    const sides = (a ? 0 : 1) + (b ? 0 : 1);
    if (sides === 0) return '0px';
    return sides === 1 ? half : `calc(${half} + ${half})`;
  };
  const insetX = lost(atLeft, atRight);
  const insetY = lost(atTop, atBottom);
  const shrink = (size: string, inset: string): string =>
    inset === '0px' ? size : `calc(${size} - ${inset})`;
  return {
    left: atLeft ? plain.left : `calc(${plain.left} + ${half})`,
    top: atTop ? plain.top : `calc(${plain.top} + ${half})`,
    width: shrink(plain.width, insetX),
    height: shrink(plain.height, insetY),
    insetX,
    insetY,
  };
}
