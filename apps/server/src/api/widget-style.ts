import { z } from '../validation.js';
import { COLOUR_TOKENS, FONT_TOKENS, themeTokensSchema, withTints, type ThemeTokens } from './themes.js';

/**
 * The per-widget style lane (RFC 014 §4.1), the ink lane's twin.
 *
 * A widget may carry its own colours, faces, weight, tracking and inset,
 * applied on its box exactly as `applyTheme` applies the household's theme on
 * the root — one element down, so every rule under the box inherits it and
 * nothing else on the wall does. A wall may carry the same shape once, on its
 * canvas (`screens.layout_style`), so every box starts from it and a widget's
 * own lane overrides it token by token.
 *
 * Two decisions were taken before this was built and are not up for
 * relitigation here: the lane carries **no `--radius`** (the Corners control
 * already exists and two controls for one decision is the ink lane's own
 * argument against `showHours`) and **no `scale`** (deferred). Shape is not
 * per widget.
 *
 * **Resolution is server-side, like a custom theme.** The display bundle has
 * never heard of the lane: what travels in the manifest is `styleTokens`, a
 * record of CSS custom properties and the three plain properties the enums
 * become, resolved here through the *same* `withTints` a custom theme goes
 * through. That is the load-bearing half. `withTints` derives
 * `--ink-scaffold`, the cell tints and the badge tints from the base colours
 * and raises the scaffold mix until it clears 4.5:1 against *that* `--bg` —
 * a widget lane that set `--bg` and `--ink` without re-deriving those would
 * put an invisible date numeral in the one widget the household restyled.
 *
 * **Only what the lane changes is emitted.** A widget that sets `--accent`
 * alone carries `--accent` and nothing else, so the theme's own scaffold ink
 * (hand-tuned in the bundle) still reaches it untouched and a daylight switch
 * on the wall still reaches every token the widget did not claim. A derived
 * token is emitted exactly when one of its inputs is on this layer, computed
 * against the *effective* base — the theme, then the wall's default lane,
 * then this widget — so a widget setting `--ink` over a wall whose default
 * set `--bg` gets a scaffold measured against the ground it will actually
 * sit on. `STYLE_DERIVED` is that dependency table and it is the spec.
 *
 * Pure, and its own module for the reason `gutter.ts` and `wall-sizes.ts`
 * are: the schema is read by the widget schema, the tables by manifest
 * assembly and by two tests, and a rule that lives inside a handler is a rule
 * that can only be reached through a server, one case at a time.
 */

/*
 * ---- The tables, written twice ---------------------------------------------
 *
 * The display bundle cannot import this file and the server cannot import
 * the bundle, so everything between the two `style tables` markers is
 * transcribed into `apps/display/src/widget-style.ts` and
 * `style-parity.test.ts` holds the two copies to being character-identical —
 * the seam `epaper-ladder-parity`, `tier-parity` and `calendar-view-parity`
 * already live at. The bundle's copy is what the *editor's live preview*
 * resolves an unsaved lane through (via `customTokens`, its existing mirror
 * of `withTints`); the wall itself reads only what this side emitted.
 */
// ---- style tables (parity) ----

/** The three weights a lane may ask for, and the `font-weight` each becomes. */
export const STYLE_WEIGHTS = ['regular', 'medium', 'bold'] as const;
export type StyleWeight = (typeof STYLE_WEIGHTS)[number];

/** The three trackings, as steps on the stylesheet's own `--ls-*` ladder. */
export const STYLE_TRACKINGS = ['tight', 'normal', 'wide'] as const;
export type StyleTracking = (typeof STYLE_TRACKINGS)[number];

/** The inset ladder: `0` (none) through `STYLE_INSET_MAX` (`--s4`, today's). */
export const STYLE_INSET_MAX = 4;

/** The tokens a lane may set — the theme's colours and its two faces. */
export const STYLE_LANE_TOKENS: readonly string[] = [
  '--bg',
  '--panel',
  '--rule',
  '--ink',
  '--muted',
  '--faint',
  '--accent',
  '--s-day',
  '--s-night',
  '--s-break',
  '--s-straight',
  '--disp',
  '--f-sans',
];

/**
 * Weight to `font-weight`. Set on the box as a plain property, so it reaches
 * only the runs that declare no weight of their own — event names, a note's
 * text, a checklist — and leaves every numeral and heading at the weight the
 * design gave it. Roboto Flex's `wght` axis draws 500 as a true medium rather
 * than a synthesised one.
 */
export const STYLE_WEIGHT_CSS: Readonly<Record<StyleWeight, string>> = {
  regular: '400',
  medium: '500',
  bold: '700',
};

/**
 * Tracking to `letter-spacing`, on the same argument as the weight: a plain
 * property on the box reaches the running text and not the roles that track
 * themselves. The two ends are the ladder's nearest rungs either side of zero
 * that were designed for text at reading size — `--ls-time` is the register
 * tabular digits read best at beside a name, and `--ls-tight-label` a quieter
 * note's — rather than a new pair of numbers nobody has looked at on a wall.
 * `normal` is the property's own keyword, so a widget can *undo* a wall
 * default rather than only inherit it.
 */
export const STYLE_TRACKING_CSS: Readonly<Record<StyleTracking, string>> = {
  tight: 'var(--ls-time)',
  normal: 'normal',
  wide: 'var(--ls-tight-label)',
};

/**
 * Inset step to the box's whole padding budget, per axis. `.fw` halves it, so
 * step 4 is exactly the `calc(var(--s4) / 2)` a side every wall draws today
 * and the ladder below it is the gutter's own (`GUTTER_STEPS`, steps 0-4).
 * `0px` rather than `0` for the reason that file gives: both are substituted
 * into a `calc()`, and `calc(0 / 2)` is invalid.
 */
export const STYLE_INSET_CSS: readonly string[] = [
  '0px',
  'var(--s1)',
  'var(--s2)',
  'var(--s3)',
  'var(--s4)',
];

/**
 * The card shadow a lane may ask for (plan item P5.3): `none`, and nothing
 * else. Absent is the theme's own `--shadow-card`.
 *
 * **A lane can take a shadow away and never add one.** The shadow is the
 * theme's token for a reason D8 states: a theme, or an e-ink-sized wall, is
 * the one place a household with an OLED or e-ink screen switches every
 * shadow off, and `applyTheme` writes that `none` on the root. A lane that
 * could say "soft" on its box would outrank the root and put a shadow back on
 * exactly the screen that asked for none — so the only value is the one that
 * cannot, and a widget whose tiles or card would rather sit flat says so here.
 */
export const STYLE_SHADOWS = ['none'] as const;
export type StyleShadow = (typeof STYLE_SHADOWS)[number];

/** Shadow to the `--shadow-card` a lane writes on its box. */
export const STYLE_SHADOW_CSS: Readonly<Record<StyleShadow, string>> = {
  none: 'none',
};

/**
 * Which derived tokens depend on which base tokens.
 *
 * What `withTints` and `customTokens` derive, written as the inputs each one
 * reads — so a lane emits a derived token exactly when it moved one of those
 * inputs, and never re-states one the theme hand-tuned.
 *
 * The designed styles' palette (plan item P4.5) joined it: the readable
 * colours are measured against both grounds and mixed toward the ink, so a
 * lane that moves any of the three re-derives them against the box it paints,
 * and a sky is tinted toward the ground. Two derived tokens are deliberately
 * absent: each sky's ink, which is a constant a lane cannot move, and
 * `--shadow-card`, which is the *theme's* choice — a lane that set a cream
 * ground on a Blueprint wall must not grow the soft shadow Blueprint said no to.
 */
export const STYLE_DERIVED: readonly { readonly token: string; readonly from: readonly string[] }[] = [
  { token: '--ink-event', from: ['--ink'] },
  { token: '--ink-scaffold', from: ['--ink', '--bg'] },
  { token: '--ink-quiet', from: ['--muted'] },
  { token: '--rule-week', from: ['--rule'] },
  { token: '--s-day-tint', from: ['--s-day', '--bg'] },
  { token: '--s-day-badge', from: ['--s-day', '--bg'] },
  { token: '--s-night-tint', from: ['--s-night', '--bg'] },
  { token: '--s-night-badge', from: ['--s-night', '--bg'] },
  { token: '--s-break-tint', from: ['--s-break', '--bg'] },
  { token: '--s-break-badge', from: ['--s-break', '--bg'] },
  { token: '--s-straight-tint', from: ['--s-straight', '--bg'] },
  { token: '--s-straight-badge', from: ['--s-straight', '--bg'] },
  { token: '--wx-sun', from: ['--ink', '--bg', '--panel'] },
  { token: '--wx-cloud', from: ['--ink', '--bg', '--panel'] },
  { token: '--wx-rain', from: ['--ink', '--bg', '--panel'] },
  { token: '--wx-snow', from: ['--ink', '--bg', '--panel'] },
  { token: '--wx-storm', from: ['--ink', '--bg', '--panel'] },
  { token: '--wx-fog', from: ['--ink', '--bg', '--panel'] },
  { token: '--temp-cold', from: ['--ink', '--bg', '--panel'] },
  { token: '--temp-cool', from: ['--ink', '--bg', '--panel'] },
  { token: '--temp-warm', from: ['--ink', '--bg', '--panel'] },
  { token: '--temp-hot', from: ['--ink', '--bg', '--panel'] },
  { token: '--state-active', from: ['--ink', '--bg', '--panel'] },
  { token: '--state-alert', from: ['--ink', '--bg', '--panel'] },
  { token: '--state-idle', from: ['--muted', '--ink', '--bg', '--panel'] },
  { token: '--sky-day-top', from: ['--bg'] },
  { token: '--sky-day-bottom', from: ['--bg'] },
  { token: '--sky-night-top', from: ['--bg'] },
  { token: '--sky-night-bottom', from: ['--bg'] },
  { token: '--sky-cloud-top', from: ['--bg'] },
  { token: '--sky-cloud-bottom', from: ['--bg'] },
  { token: '--sky-rain-top', from: ['--bg'] },
  { token: '--sky-rain-bottom', from: ['--bg'] },
  { token: '--sky-snow-top', from: ['--bg'] },
  { token: '--sky-snow-bottom', from: ['--bg'] },
  { token: '--sky-storm-top', from: ['--bg'] },
  { token: '--sky-storm-bottom', from: ['--bg'] },
];

/**
 * The colours a calendar's `planner` look lays on its box (plan item P5.4):
 * a paper ground, a pen's ink and a ledger's rules — Paper Almanac's own
 * eleven colours, which are hand-tuned for exactly that and held to the
 * contrast bar by the theme's own tests, rather than a twelfth palette nobody
 * has measured. Almanac's face comes with it, so the numerals are Fraunces.
 *
 * A **lane**, not a stylesheet rule, because a lane is what re-derives the
 * scaffold ink, the shift tints and every designed colour against the new
 * ground: a paper box on a dark wall whose date numerals were still measured
 * against the dark wall would be the invisible numeral this derivation exists
 * to prevent. It sits under the widget's own lane, so a household who picks
 * Planner and then its own accent gets their accent.
 */
export const PLANNER_LANE: Readonly<Record<string, string>> = {
  '--bg': '#FBF8F1',
  '--panel': '#FFFFFF',
  '--rule': '#E4DCC9',
  '--ink': '#241F19',
  '--muted': '#8A8474',
  '--faint': '#A89F8B',
  '--accent': '#B3372B',
  '--s-day': '#986911',
  '--s-night': '#2F5D8C',
  '--s-break': '#467E52',
  '--s-straight': '#777166',
  '--disp': "'Fraunces', Georgia, serif",
};

/**
 * The face a calendar's `bold` look draws its numerals in: Roboto Flex, whose
 * weight axis reaches 1000 — the one bundled face that has a heavier numeral
 * than the 700 every month already draws. Oswald, Space Grotesk and Fraunces
 * stop at 700, so asking them for a heavier weight would draw the same glyphs.
 */
export const BOLD_FACE = "'Roboto Flex', 'Roboto Condensed', 'Roboto', system-ui, sans-serif";

/**
 * The lane a widget's look lays under its own (plan item P5.4), or nothing.
 *
 * `ink` is the ink the box will actually draw in — the theme's, under the
 * wall's default lane, under the widget's own — because `bold`'s rules are
 * that ink: a high-contrast rule is a rule in the colour the words are.
 */
export function lookLane(
  type: string,
  variant: unknown,
  ink: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (type !== 'calendar') return undefined;
  if (variant === 'planner') return PLANNER_LANE;
  if (variant === 'bold') return ink === undefined ? { '--disp': BOLD_FACE } : { '--rule': ink, '--disp': BOLD_FACE };
  return undefined;
}

// ---- end style tables ----

/**
 * The lane's shape: the theme's own colour and font tokens, **picked**, all
 * optional — so a colour that is not a `#rrggbb` is refused by the same rule
 * with the same message a theme's is, for ever, and a font stack outside
 * `FONTS` is refused for the reason it is on a theme — plus the enums the
 * tables above map (weight, tracking, inset, and since P5.3 the shadow). `.strict()` as everywhere: an unknown key is a 400 and
 * never a silently dropped option (rule five). `--radius` is deliberately not
 * picked, and `style` is not among the ink lane's picked keys, so `ink.style`
 * is a rejected key rather than a second lane nobody designed.
 */
const colourPick = Object.fromEntries(COLOUR_TOKENS.map((token) => [token, true])) as Record<
  (typeof COLOUR_TOKENS)[number],
  true
>;
const fontPick = Object.fromEntries(FONT_TOKENS.map((token) => [token, true])) as Record<
  (typeof FONT_TOKENS)[number],
  true
>;

export const widgetStyleBody = themeTokensSchema
  .pick({ ...colourPick, ...fontPick })
  .partial()
  .extend({
    weight: z.enum(STYLE_WEIGHTS).optional(),
    tracking: z.enum(STYLE_TRACKINGS).optional(),
    inset: z.number().int().min(0).max(STYLE_INSET_MAX).optional(),
    shadow: z.enum(STYLE_SHADOWS).optional(),
  })
  .strict();

export type WidgetStyle = z.infer<typeof widgetStyleBody>;

/**
 * A stored lane read back defensively, or nothing.
 *
 * Both places a lane is stored are JSON this process wrote at some version —
 * a widget's `config.style` and `screens.layout_style` — and a row this
 * process did not write is never trusted over a wall drawing what it drew
 * yesterday (rule nine): anything that fails the schema is no lane at all,
 * and so is an empty object, which would otherwise emit a record of nothing.
 */
export function styleLayerOf(value: unknown): WidgetStyle | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const parsed = widgetStyleBody.safeParse(value);
  if (!parsed.success) return undefined;
  const layer = parsed.data;
  return Object.values(layer).some((v) => v !== undefined) ? layer : undefined;
}

/** A stored `layout_style` column, which is JSON text or null. */
export function storedStyleLayer(column: string | null | undefined): WidgetStyle | undefined {
  if (column === null || column === undefined || column === '') return undefined;
  try {
    return styleLayerOf(JSON.parse(column));
  } catch {
    return undefined;
  }
}

/**
 * What one lane puts on its element, resolved against everything under it.
 *
 * `base` is the theme's own colours (eleven, at least), `context` the lanes
 * already applied beneath this one (the wall's default, for a widget) and
 * `own` the lane being resolved. The answer is deterministic in its key order
 * — `manifestEtag` hashes the serialisation — and `undefined` when the lane
 * sets nothing, so an unstyled widget's document is byte-identical to the one
 * it sent before this existed: the field is spread away, never emitted empty.
 */
export function resolveStyleTokens(
  base: Readonly<Record<string, string>>,
  context: readonly WidgetStyle[],
  own: WidgetStyle | undefined,
): Record<string, string> | undefined {
  if (own === undefined) return undefined;

  // The effective colours this lane's derived tokens are measured against.
  const effective: Record<string, string> = {};
  for (const token of STYLE_LANE_TOKENS) {
    const value = base[token];
    if (value !== undefined) effective[token] = value;
  }
  for (const layer of [...context, own]) {
    for (const token of STYLE_LANE_TOKENS) {
      const value = (layer as Record<string, unknown>)[token];
      if (typeof value === 'string') effective[token] = value;
    }
  }

  const out: Record<string, string> = {};
  const set = own as Record<string, unknown>;
  for (const token of STYLE_LANE_TOKENS) {
    const value = set[token];
    if (typeof value === 'string') out[token] = value;
  }

  // Derived through the one derivation a custom theme goes through, and only
  // the members this lane moved an input of. `--radius` is required by the
  // theme schema's type and read by nothing below; it is never emitted.
  const moved = STYLE_DERIVED.filter((entry) => entry.from.some((input) => typeof set[input] === 'string'));
  if (moved.length > 0) {
    const derived = withTints({ ...effective, '--radius': '0' } as ThemeTokens);
    for (const entry of moved) {
      const value = derived[entry.token];
      if (value !== undefined) out[entry.token] = value;
    }
  }

  if (own.weight !== undefined) out['font-weight'] = STYLE_WEIGHT_CSS[own.weight];
  if (own.tracking !== undefined) out['letter-spacing'] = STYLE_TRACKING_CSS[own.tracking];
  if (own.inset !== undefined) {
    const inset = STYLE_INSET_CSS[own.inset];
    if (inset !== undefined) out['--fw-inset'] = inset;
  }
  if (own.shadow !== undefined) out['--shadow-card'] = STYLE_SHADOW_CSS[own.shadow];
  return Object.keys(out).length === 0 ? undefined : out;
}
