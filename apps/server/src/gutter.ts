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
 * **A step is paid for out of two budgets.** The spacing scale declares three
 * permissions and two of them bear on the room between two widgets: *a widget
 * box spends at most step 4 on padding, total, per axis*, and *the canvas
 * spends at most step 5 between the boxes it holds*. The wall has always spent
 * the whole of the first and **none** of the second — the boxes tile, so the
 * only room between two of them is twice the `.fw` padding, which is
 * `calc(var(--s4) / 2)` a side and `--s4` in total.
 *
 * So the ladder is one number a household picks and the renderer decides how
 * to pay. Steps 0-4 come out of the widget's own padding and the boxes go on
 * tiling; steps 5 and 6 hold that padding at its permission and spend the
 * **canvas** budget instead, by taking room out of the box rectangle so the
 * wall's own ground shows between the widgets. `apps/display/src/gutter.ts`
 * holds the table and `boxRect` the placement rule; nothing here needs to know
 * which budget a step draws on, only that the ladder has seven rungs.
 *
 * **The airier half was declined once and the refusal was wrong**, which is
 * worth one sentence because the reasoning read well. It said a gutter past
 * `--s4` "would be canvas spacing spent out of the widget's own budget" — true
 * of spending it as *padding*, and it treated that as the only mechanism. The
 * canvas has a budget of its own and had never spent a pixel of it.
 */

/** The steps a household can choose, `0` (touching) through `GUTTER_MAX`. */
export const GUTTER_MIN = 0;
export const GUTTER_MAX = 6;

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
 * Named around where the wall already stands rather than around the middle of
 * the list: step 4 is what every wall drew before this existed, so it is
 * *Normal*, everything under it is tighter and the two above it are airier.
 * Calling the *middle* step "Normal" would be a control that quietly tightens
 * a wall when somebody picks the option its own label says is the ordinary one
 * — the kind of lie this admin has already paid for twice ("an option that
 * does nothing is worse than an option not offered", one turn of the screw
 * along). With the ladder open at both ends that name now sits where it
 * belongs, four rungs up a list of seven, and it is still the one a wall
 * nobody has asked comes back checked on.
 */
export const GUTTER_LABELS: readonly string[] = [
  'None',
  'Very tight',
  'Tight',
  'Snug',
  'Normal',
  'Roomy',
  'Airy',
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
