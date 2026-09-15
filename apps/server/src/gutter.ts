/**
 * How much room a wall leaves between the widgets on it (RFC 014 §4.4).
 *
 * A step on the spacing scale `display.css` already declares, stored per
 * screen as `screens.layout_gutter` and carried to the wall in the manifest.
 * Pure, and its own module for the reason `wall-sizes.ts` is one: the bounds
 * are read by a form, by manifest assembly and by a test, and a rule that
 * lives inside a handler is a rule that can only be reached through a server,
 * one case at a time.
 *
 * **What the steps are, and why the top one is today's spacing.** The wall's
 * boxes tile — they share edges and reach the edge of the layout — so the only
 * room between two of them is twice the `.fw` padding and nothing else. That
 * padding is `calc(var(--s4) / 2)`, which makes today's gutter exactly `--s4`,
 * and `--s4` is also the whole of the spacing scale's second permission: *a
 * widget box spends at most step 4, total, per axis*. So a gutter airier than
 * today would be canvas spacing spent out of the widget's own budget, on a
 * fixed layout with no scrollbar, where chrome competes with content for every
 * pixel. Five steps down to nothing, and the top of the ladder is where the
 * wall already stood.
 *
 * Going airier than today is therefore a *layout* change — room the boxes do
 * not own, which on a canvas whose boxes tile means they stop tiling — rather
 * than a spacing one, and is deliberately not this.
 */

/** The steps a household can choose, `0` (touching) through `GUTTER_MAX`. */
export const GUTTER_MIN = 0;
export const GUTTER_MAX = 4;

/**
 * The step a wall with no choice recorded draws.
 *
 * Null in the column and this value are the *same pixels* — `.fw`'s padding is
 * `calc(var(--s4) / 2)` whether the property is absent or set to `var(--s4)` —
 * which is what lets the settings control honestly check a segment on a wall
 * that has never been asked. They are not the same *manifest*: null is spread
 * out of the document entirely, so a household who never opens the setting
 * sends the bytes they sent before this column existed and no stored ETag
 * churns.
 */
export const GUTTER_DEFAULT_STEP = 4;

/**
 * What each step is called where a household reads it.
 *
 * Named for where the wall already stands rather than around a midpoint: step
 * 4 is what every wall drew before this existed, so it is *Normal* and
 * everything under it is tighter. Calling the middle step "Normal" would be a
 * control that quietly tightens a wall when somebody picks the option its own
 * label says is the ordinary one — the kind of lie this admin has already paid
 * for twice ("an option that does nothing is worse than an option not
 * offered", one turn of the screw along).
 */
export const GUTTER_LABELS: readonly string[] = [
  'None',
  'Very tight',
  'Tight',
  'Snug',
  'Normal',
];

/**
 * A stored or submitted value read as a step, or `undefined`.
 *
 * **Refused rather than clamped**, which is `physicalWall`'s rule beside it and
 * for the same reason: a hand-edited `9` clamped to `4` is a confident answer
 * to a question nobody asked, where dropping it draws the wall the household
 * had yesterday. Absent, null, a fraction, a string and anything outside the
 * ladder all come back `undefined`, which every reader downstream treats as
 * "no choice recorded".
 */
export function canvasGutterStep(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < GUTTER_MIN || value > GUTTER_MAX) return undefined;
  return value;
}
