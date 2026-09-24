import { COLOUR_TOKENS } from './themes.js';

/**
 * The five built-in palettes, as the server needs them for the style lane
 * (RFC 014 §4.1).
 *
 * The display bundle owns these — `apps/display/src/theme.ts` is the source
 * and a built-in reaches a wall as a *key* the bundle already knows, never as
 * tokens. The server has never held them, and `theme-cards.ts` says so at
 * `THEME_SWATCHES`: three colours per theme for a card, "and not a token set".
 *
 * A per-widget style lane changes what the server has to know. A widget that
 * sets `--ink` and not `--bg` needs its `--ink-scaffold` derived against the
 * ground it will actually sit on, which is the *wall's* `--bg`; on a custom
 * theme that ground is in `resolveTheme`'s tokens, and on a built-in it is
 * here or nowhere. Deriving against a guess would put an invisible date
 * numeral in the one widget the household restyled, which is the exact fault
 * the RFC names.
 *
 * So this is a transcription, and it is held to its source: `builtin-themes-
 * parity.test.ts` reads `theme.ts` as text and compares every colour in every
 * block, the seam `tier-parity`, `month-spans-parity` and `glyph-parity`
 * already sit at (the display bundle has no bundler and the server cannot
 * import it). Only the eleven colour tokens are carried — the derived roles
 * are recomputed by `withTints` wherever a lane needs them, and `--radius` is
 * not part of the lane by decision.
 */
export type BuiltinThemeName = 'household' | 'blueprint' | 'panels' | 'almanac' | 'swiss';

export type ColourTokenSet = Readonly<Record<(typeof COLOUR_TOKENS)[number], string>>;

export const BUILTIN_THEME_TOKENS: Readonly<Record<BuiltinThemeName, ColourTokenSet>> = {
  household: {
    '--bg': '#F4F0E8',
    '--panel': '#FFFFFF',
    '--rule': '#E6DFCF',
    '--ink': '#26221C',
    '--muted': '#8A8474',
    '--faint': '#A49C88',
    '--accent': '#B5651F',
    '--s-day': '#906526',
    '--s-night': '#426DB4',
    '--s-break': '#2D7A5A',
    '--s-straight': '#646E7C',
  },
  blueprint: {
    '--bg': '#F2F2F3',
    '--panel': '#FFFFFF',
    '--rule': '#C6C9CD',
    '--ink': '#1D1F20',
    '--muted': '#7C8288',
    '--faint': '#9AA0A6',
    '--accent': '#5980A6',
    '--s-day': '#946510',
    '--s-night': '#2F5D8C',
    '--s-break': '#447A4F',
    '--s-straight': '#736E63',
  },
  panels: {
    '--bg': '#14181E',
    '--panel': '#1B212A',
    '--rule': '#2A323E',
    '--ink': '#EDEBE6',
    '--muted': '#9AA5B2',
    '--faint': '#7E8A99',
    '--accent': '#5C93E0',
    '--s-day': '#E8A33D',
    '--s-night': '#5C93E0',
    '--s-break': '#35916A',
    '--s-straight': '#6B7684',
  },
  almanac: {
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
  },
  swiss: {
    '--bg': '#09090B',
    '--panel': '#0F0F12',
    '--rule': '#27272A',
    '--ink': '#FFFFFF',
    '--muted': '#A1A1AA',
    '--faint': '#3F3F46',
    '--accent': '#FFB224',
    '--s-day': '#E8A33D',
    '--s-night': '#5C93E0',
    '--s-break': '#35916A',
    '--s-straight': '#7E7E86',
  },
};

/**
 * The ground a built-in key draws on, retired keys included.
 *
 * `board`, `slate` and `glance` fold onto Panels exactly as the bundle's
 * `LEGACY_ALIASES` and `theme-cards.ts`'s `LEGACY_THEME_ALIASES` fold them —
 * dark onto dark — and anything else this server has never heard of is
 * Panels too, which is the bundle's own `DEFAULT_THEME`. Never `undefined`:
 * a lane resolved against no ground at all is the fault this file exists to
 * prevent, so the answer is always a palette the wall can actually be wearing.
 */
export function builtinThemeTokens(ref: string): ColourTokenSet {
  if (ref in BUILTIN_THEME_TOKENS) return BUILTIN_THEME_TOKENS[ref as BuiltinThemeName];
  return BUILTIN_THEME_TOKENS.panels;
}

/**
 * Each built-in's card shadow (decision D8, plan item P4.4), transcribed from
 * the same five blocks in `theme.ts` and held to them by the same parity test.
 *
 * A token rather than a colour, so it sits beside the palettes rather than in
 * them: `ColourTokenSet` is exactly the eleven a lane may set, and a shadow is
 * not one of them. Soft on Panels and Household, paper-like on Almanac — a
 * hard offset with no blur — and none on Blueprint and Swiss. The bundle owns
 * the value a wall draws; this is here so the server can say what a theme
 * does to a widget that asks for a drop shadow without guessing.
 */
export const BUILTIN_THEME_SHADOWS: Readonly<Record<BuiltinThemeName, string>> = {
  household: '0 0.1rem 0.5rem rgba(38, 34, 28, 0.14)',
  blueprint: 'none',
  panels: '0 0.15rem 0.6rem rgba(0, 0, 0, 0.45)',
  almanac: '0.08rem 0.12rem 0 rgba(36, 31, 25, 0.14)',
  swiss: 'none',
};
