/**
 * The per-widget style lane, as the display bundle needs it (RFC 014 §4.1).
 *
 * The wall itself learns almost nothing here: the server resolves a widget's
 * lane into `styleTokens` — a record of CSS custom properties and three plain
 * properties — and `applyStyleTokens` writes them onto the box exactly as
 * `applyTheme` writes the household's theme onto the root, one element down.
 * The display never reads a widget's `style` object, the way the wall never
 * reads `ink`.
 *
 * The rest of this file is the *editor's*. Its live preview has to draw an
 * unsaved lane before any server has resolved it, so `resolveStyleTokens`
 * below is the server's resolver again, resolving through `customTokens` —
 * the bundle's existing mirror of `withTints`, held character-identical to it
 * by `themes.test.ts` — and the tables between the two markers are the
 * server's, held character-identical by `style-parity.test.ts`. That is the
 * seam `ladder.ts`, `tiers.ts` and `month-spans.ts` already sit at, and it is
 * why this file adds no second copy of the scaffold derivation: `customTokens`
 * is the one this bundle already had.
 *
 * Pure, and its own module for the reason `widget-options.ts`, `ink.ts`,
 * `ladder.ts` and `gutter.ts` are: there is no DOM in this package's test
 * suite, so a rule resolved inside a `style.setProperty` call is a rule
 * nothing can check.
 */

import { customTokens } from './theme.js';

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

/** A lane as the editor holds it: the colours and faces set, and the enums. */
export interface StyleLayer {
  readonly [token: string]: string | number | undefined;
  readonly weight?: StyleWeight;
  readonly tracking?: StyleTracking;
  readonly inset?: number;
  readonly shadow?: StyleShadow;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * A stored lane read back defensively, or nothing.
 *
 * The editor reads a widget's `config.style` for its preview and its
 * controls, and that is JSON the server validated — but a config can be
 * older or newer than this bundle, so anything that is not the shape is no
 * lane, and so is an empty object (rule nine: nothing extra is drawn from a
 * value nothing can read). The font stacks are taken as strings: the closed
 * allowlist is the server's, and the preview draws whatever face the value
 * names exactly as the wall will.
 */
export function styleLayerOf(value: unknown): StyleLayer | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const token of STYLE_LANE_TOKENS) {
    const candidate = raw[token];
    if (typeof candidate !== 'string') continue;
    if (token.startsWith('--s') || token === '--bg' || token === '--panel' || token === '--rule' ||
        token === '--ink' || token === '--muted' || token === '--faint' || token === '--accent') {
      if (!HEX6.test(candidate)) continue;
    }
    out[token] = candidate;
  }
  const weight = raw['weight'];
  if (typeof weight === 'string' && (STYLE_WEIGHTS as readonly string[]).includes(weight)) out['weight'] = weight;
  const tracking = raw['tracking'];
  if (typeof tracking === 'string' && (STYLE_TRACKINGS as readonly string[]).includes(tracking)) {
    out['tracking'] = tracking;
  }
  const inset = raw['inset'];
  if (typeof inset === 'number' && Number.isInteger(inset) && inset >= 0 && inset <= STYLE_INSET_MAX) {
    out['inset'] = inset;
  }
  const shadow = raw['shadow'];
  if (typeof shadow === 'string' && (STYLE_SHADOWS as readonly string[]).includes(shadow)) out['shadow'] = shadow;
  return Object.keys(out).length === 0 ? undefined : (out as StyleLayer);
}

/**
 * What one lane puts on its element, resolved against everything under it —
 * the server's `resolveStyleTokens`, for the preview. `base` is the theme's
 * colours, `context` the lanes beneath this one (the wall's default, for a
 * widget) and `own` the lane being resolved; `undefined` when it sets nothing.
 */
export function resolveStyleTokens(
  base: Readonly<Record<string, string>>,
  context: readonly StyleLayer[],
  own: StyleLayer | undefined,
): Record<string, string> | undefined {
  if (own === undefined) return undefined;

  const effective: Record<string, string> = {};
  for (const token of STYLE_LANE_TOKENS) {
    const value = base[token];
    if (value !== undefined) effective[token] = value;
  }
  for (const layer of [...context, own]) {
    for (const token of STYLE_LANE_TOKENS) {
      const value = layer[token];
      if (typeof value === 'string') effective[token] = value;
    }
  }

  const out: Record<string, string> = {};
  for (const token of STYLE_LANE_TOKENS) {
    const value = own[token];
    if (typeof value === 'string') out[token] = value;
  }

  const moved = STYLE_DERIVED.filter((entry) => entry.from.some((input) => typeof own[input] === 'string'));
  if (moved.length > 0) {
    const derived = customTokens(effective);
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

/** The one shape both a widget box and the canvas offer this module. */
export interface Styleable {
  readonly style: {
    setProperty(name: string, value: string): void;
    background: string;
  };
}

/**
 * A resolved lane as the manifest carries it, read defensively: a document
 * from a server older or newer than this bundle may carry anything under the
 * key, and only a record of strings is a lane. A key that is neither a custom
 * property nor one of the three plain properties the resolver emits is left
 * out — the manifest is data, never a way to reach an arbitrary style.
 */
const PLAIN_PROPERTIES: readonly string[] = ['font-weight', 'letter-spacing'];

export function styleTokensOf(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    if (!key.startsWith('--') && !PLAIN_PROPERTIES.includes(key)) continue;
    out[key] = raw;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Write a resolved lane onto its element.
 *
 * Every entry is `setProperty`, custom properties and the three plain ones
 * alike, so a token on a box is a token on a box and every rule under it
 * inherits — `applyTheme` one element down. The one thing more it does is
 * *paint*: a widget box has no ground rule of its own (the wall's `--bg` is
 * on the body and the canvas draws `--panel`), so a lane that sets `--bg`
 * would otherwise be a colour nothing reads, the `options.json` bug in a
 * colour input. A box painted this way is the ground its own `--ink-scaffold`
 * was measured against, which is what makes the contrast promise true. The
 * caller says whether this element paints, because the canvas has a ground
 * rule already and keeps following its `--panel`.
 */
export function applyStyleTokens(
  element: Styleable,
  tokens: Readonly<Record<string, string>>,
  paint: boolean,
): void {
  for (const key of Object.keys(tokens)) {
    const value = tokens[key];
    if (value !== undefined) element.style.setProperty(key, value);
  }
  const ground = tokens['--bg'];
  if (paint && ground !== undefined) element.style.background = ground;
}

/**
 * Merge one option into a widget's `style` lane, dropping empties — the
 * editor's `setLaneValue`, one level down and for a different key. Clearing
 * the last value removes `style` entirely, so a widget that says nothing
 * carries nothing, and `undefined` comes back for a config that is now empty.
 */
export function setStyleValue(
  config: Readonly<Record<string, unknown>> | undefined,
  key: string,
  value: string | number | undefined,
): Record<string, unknown> | undefined {
  const current = config ?? {};
  const lane: Record<string, unknown> = {
    ...(typeof current['style'] === 'object' && current['style'] !== null
      ? (current['style'] as Record<string, unknown>)
      : {}),
  };
  if (value === undefined || value === '') delete lane[key];
  else lane[key] = value;
  const next: Record<string, unknown> = { ...current };
  if (Object.keys(lane).length === 0) delete next['style'];
  else next['style'] = lane;
  return Object.keys(next).length === 0 ? undefined : next;
}
