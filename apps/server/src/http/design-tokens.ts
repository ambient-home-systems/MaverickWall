/**
 * The admin's colour schemes — hand-picked, not generated.
 *
 * These replaced a Material 3 tonal palette derived from the Board amber. The
 * problem with a generated ramp is not that the numbers were wrong; it is that
 * a tonal engine tints *every* surface with the seed, so the whole admin sat on
 * a brown-black (`#18120B`) and read as an app wearing somebody's wallpaper.
 * A wall calendar's settings should look like a fixture in a house, so the
 * neutrals here are neutral — a faintly cool graphite in the dark scheme, warm
 * paper in the light one — and exactly one hue carries the brand.
 *
 * Hand-picked also means these are *facts*, not outputs: nothing regenerates
 * them, no script has to be re-run to read them, and changing one is a diff a
 * person can review. `test/design-tokens.test.ts` holds every pair to the
 * contrast it needs, so a future adjustment cannot quietly go unreadable.
 *
 * This is a much smaller vocabulary than the thirty-odd roles it replaced —
 * three surfaces, three inks, two rules, one accent and the status hues. A role
 * exists here only where the design paints one thing on another; the sprawl of
 * M3 container/on-container pairs mostly encoded distinctions this admin never
 * drew.
 *
 * The household's *wall* themes are a separate matter and still generate from a
 * seed on purpose (`api/theme-generator.ts`) — there the seed is a colour the
 * household chose for their own kitchen, which is the case a tonal engine is
 * actually for.
 */

/** The brand amber, from the mark. The one hue either scheme is allowed. */
export const BRAND_AMBER = '#E8A33D';

export interface AdminScheme {
  /** Emitted as `--mw-<role>`. */
  readonly color: Readonly<Record<string, string>>;
}

/**
 * Dark: the default, and the one that matters most.
 *
 * A household opens these settings from a phone, in a kitchen, usually in the
 * evening — so the ground is a graphite that stays calm under a lamp rather
 * than the pure black that makes an OLED phone strobe on every scroll. The
 * three surfaces are 4-6 points of luminance apart, which is enough to separate
 * a card from the page without a shadow doing it.
 *
 * The accent is the mark's amber unchanged: on these grounds it clears 4.5:1
 * everywhere it lands, so the brand colour and the accessible colour are the
 * same value and nobody has to keep two in step.
 */
const DARK: AdminScheme = {
  color: {
    // Grounds, page outward to raised.
    'bg': '#14161A',
    'surface': '#1A1D22',
    'surface-2': '#22262C',
    'surface-3': '#2A2F36',
    // Text, in descending importance. `ink-3` is placeholder and disabled text
    // only — it is deliberately the one role below 4.5:1, and nothing
    // essential is ever set in it.
    'ink': '#E9EBEE',
    'ink-2': '#A9B0B9',
    'ink-3': '#7C848E',
    // Two rules, because a divider inside a card and a border around a control
    // are different jobs: the first must not be seen, the second must.
    'line': '#2E333A',
    'line-strong': '#3D444D',
    // The accent, its text colour, and the wash used for a selected ground.
    'accent': '#E8A33D',
    'accent-ink': '#241703',
    'accent-soft': '#3B3226',
    'accent-soft-ink': '#F3C079',
    // Status. Each hue has a `-soft` ground so a tag can be tinted rather than
    // filled — a solid status chip is loud on a page that may carry six of
    // them. `night` is the shift palette's blue, kept so a rota preview in the
    // admin and the same rota on the wall are not two different blues.
    'danger': '#FF8A80',
    'danger-ink': '#3A0906',
    'danger-soft': '#3F2E31',
    'ok': '#5FD08A',
    'ok-soft': '#253A33',
    'warn': '#F0B429',
    'warn-soft': '#3C3523',
    'night': '#7CA0E0',
    'night-soft': '#2A3240',
    // The keyboard ring, and the wash behind a modal.
    'focus': '#E8A33D',
    'scrim': 'rgba(0,0,0,.58)',
  },
};

/**
 * Light: warm paper rather than white.
 *
 * `#F7F6F4` and a white card is the same relationship the dark scheme has —
 * the page is the darker ground and the card lifts off it — so one set of
 * component rules works in both without a single scheme-specific override.
 *
 * The accent is *not* the brand amber here. `#E8A33D` on white is 2.16:1, so
 * the identity colour and a readable colour genuinely cannot be the same value
 * on this ground; `#8C5C0C` is the same hue walked down until it clears 4.5:1
 * against all three surfaces and against its own soft wash. This is the same
 * derivation the add-on logo's wordmark made for the same reason, and it is
 * derived for the constraint rather than lifted from a brand token — so nobody
 * should "correct" it back to the amber.
 */
const LIGHT: AdminScheme = {
  color: {
    'bg': '#F7F6F4',
    'surface': '#FFFFFF',
    'surface-2': '#F1EFEC',
    'surface-3': '#E7E4E0',
    'ink': '#1A1C1F',
    'ink-2': '#5A6169',
    'ink-3': '#7E858D',
    'line': '#E2DFDA',
    'line-strong': '#CBC7C1',
    'accent': '#8C5C0C',
    'accent-ink': '#FFFFFF',
    'accent-soft': '#EFE8DD',
    'accent-soft-ink': '#6B4608',
    'danger': '#B3261E',
    'danger-ink': '#FFFFFF',
    'danger-soft': '#F6E5E4',
    'ok': '#1E7A4A',
    'ok-soft': '#E9F2ED',
    'warn': '#8A5A00',
    'warn-soft': '#F4EEE2',
    'night': '#2F5D8C',
    'night-soft': '#E2E8EF',
    'focus': '#8C5C0C',
    'scrim': 'rgba(0,0,0,.32)',
  },
};

export const ADMIN_SCHEMES: Readonly<Record<'dark' | 'light', AdminScheme>> = {
  dark: DARK,
  light: LIGHT,
};

/**
 * The type scale.
 *
 * Ten roles where the M3 scale had fifteen, and the difference is not
 * tidiness: M3's scale is drawn for a phone held at arm's length, so it tracks
 * body text *out* (`+0.5px` on body-large, `+0.1px` on labels) and sets every
 * heading at weight 400. Loose and light is exactly wrong for the brief here —
 * a settings screen that has to stay legible at a glance, sometimes across a
 * kitchen. So headings are 650, tracking goes negative as size goes up the way
 * optical sizing wants, and body tracking is zero.
 *
 * Sizes are px because this stylesheet sizes in px throughout, and the admin is
 * a browser on a phone or a desktop — the wall's rem-against-viewport scaling
 * is a different problem solved in a different bundle.
 *
 * Tuple order: size, line-height, weight, tracking.
 */
const TYPE_SCALE: Readonly<Record<string, readonly [string, string, string, string]>> = {
  display: ['34px', '40px', '700', '-0.02em'],
  h1: ['26px', '32px', '650', '-0.015em'],
  h2: ['21px', '27px', '650', '-0.01em'],
  h3: ['16px', '22px', '650', '-0.005em'],
  h4: ['14px', '19px', '650', '0'],
  'body-lg': ['16px', '24px', '400', '0'],
  body: ['14.5px', '21px', '400', '0'],
  'body-sm': ['12.5px', '18px', '400', '0'],
  label: ['13.5px', '17px', '600', '0'],
  'label-sm': ['12px', '15px', '600', '0.01em'],
  // The eyebrow: the one role that tracks *out*, because it is set in caps and
  // caps need the air. Used for section kickers and the drawer's group heads.
  'label-xs': ['11px', '14px', '700', '0.08em'],
};

/** One scheme's colours as `--mw-*` declarations. */
export function adminColorVars(scheme: AdminScheme): string {
  return Object.entries(scheme.color)
    .map(([role, value]) => `--mw-${role}:${value}`)
    .join(';');
}

/**
 * The type scale as custom properties — each role's four parts, plus a `font`
 * shorthand so a call site that wants the whole thing is one declaration
 * instead of four. The shorthand cannot carry tracking (`letter-spacing` is not
 * part of `font`), so a role's tracking is always set beside it.
 */
export function adminTypeVars(): string {
  return Object.entries(TYPE_SCALE)
    .map(([role, [size, lineHeight, weight, tracking]]) => {
      return (
        `--mw-t-${role}-size:${size};` +
        `--mw-t-${role}-lh:${lineHeight};` +
        `--mw-t-${role}-weight:${weight};` +
        `--mw-t-${role}-tracking:${tracking};` +
        `--mw-t-${role}:${weight} ${size}/${lineHeight} var(--sans)`
      );
    })
    .join(';\n  ');
}

/** The roles the scale defines, for the test that holds the stylesheet to it. */
export const TYPE_ROLES: readonly string[] = Object.keys(TYPE_SCALE);
