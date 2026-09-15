/**
 * The room between the widgets on a wall, as a CSS length (RFC 014 §4.4).
 *
 * Pure, and its own module for the reason `widget-options.ts`, `ink.ts`,
 * `ladder.ts`, `placement.ts`, `omission.ts` and `tiers.ts` are: there is no
 * DOM in this package's test suite, so a rule resolved inside a
 * `style.setProperty` call is a rule nothing can check.
 *
 * The wall's boxes tile, so the only room between two of them is twice the
 * `.fw` padding. This answers the *gutter* — the whole distance between two
 * adjacent widgets' content — and `.fw` halves it, which is why step 4 is
 * `--s4` and draws the `calc(var(--s4) / 2)` per side the stylesheet has
 * always carried.
 */

/**
 * Step to gutter, and the table is the spec.
 *
 * `0px` rather than `0` at the bottom because this is substituted into a
 * `calc()`: `calc(0 / 2)` is invalid — a bare zero in `calc` has no unit to
 * divide — and an invalid custom-property substitution makes the whole
 * declaration compute to its unset value, which for `padding` is `0` by
 * accident rather than by design. Getting the right pixels for the wrong
 * reason at exactly one step is how the next edit to this file breaks
 * silently.
 */
export const GUTTER_STEPS: readonly string[] = [
  '0px',
  'var(--s1)',
  'var(--s2)',
  'var(--s3)',
  'var(--s4)',
];

/**
 * What to write into `--fw-gutter`, or `undefined` to write nothing.
 *
 * `undefined` is the load-bearing answer and the whole of rule nine here: the
 * property is *removed* rather than set to a fallback, so `.fw`'s
 * `var(--fw-gutter, var(--s4))` reaches its own fallback and the wall draws
 * exactly what it drew before this existed. Read defensively because a
 * manifest is a document from a server that may be older or newer than this
 * bundle — a step this table has never heard of is no choice recorded, not a
 * wall with no spacing.
 */
export function gutterValue(step: unknown): string | undefined {
  if (typeof step !== 'number' || !Number.isInteger(step)) return undefined;
  return GUTTER_STEPS[step];
}
