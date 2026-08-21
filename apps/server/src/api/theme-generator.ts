import {
  argbFromHex,
  hexFromArgb,
  Blend,
  Hct,
  SchemeTonalSpot,
} from '@material/material-color-utilities';
import type { ThemeTokens } from './themes.js';

/**
 * One seed colour in, a complete wall theme out.
 *
 * Runs Material 3's colour engine at request time — the same engine, variant
 * (TonalSpot), contrast level (0) and spec (2021) as the admin's own committed
 * schemes; `scripts/generate-m3-tokens.mjs` is the design-time twin of this
 * module and documents those choices. The two stay separate files because the
 * script must run before anything is built (it writes a source file), so it
 * cannot import from here; this comment is the seam that keeps them in step.
 *
 * The output is an ordinary custom-theme token set: it goes through the same
 * schema, storage, tints and manifest resolution as one built swatch by
 * swatch, and the display bundle never learns this feature exists.
 */

/**
 * The display's own default shift hues (Board's, from
 * `apps/display/src/theme.ts` — mirrored here the way `themes.ts` mirrors the
 * tint maths, because the display depends on nothing it could share through).
 * Each is pulled toward the seed with Blend.harmonize so the rota's colours
 * belong to the generated palette rather than fighting it.
 */
const SHIFT_DEFAULTS = {
  '--s-day': '#E8A33D',
  '--s-night': '#4C7FD1',
  '--s-break': '#35916A',
  '--s-straight': '#6B7684',
} as const;

/**
 * A shift hue must hold at least 3:1 against the background — a shift colour
 * that vanishes into the wall is a rota nobody can read from across a kitchen.
 */
const SHIFT_CONTRAST = 3;

/** WCAG relative luminance, from the hex bytes that will actually ship. */
function wcagLuminance(hex: string): number {
  const value = parseInt(hex.slice(1), 16);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

function wcagContrast(a: string, b: string): number {
  const [la, lb] = [wcagLuminance(a), wcagLuminance(b)];
  return la >= lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/**
 * A harmonized hue, tone-walked until it reads over the background.
 *
 * Hue and chroma are kept; only the tone moves, away from the background's own
 * tone, two steps at a time. The ratio is measured on the *hex pair being
 * delivered*, not in tone space: tone is continuous L* but a stored token is
 * quantized to 8-bit sRGB, and that rounding can shave a ratio that read
 * exactly 3.00 in tones down to 2.99 in bytes — the boundary this walk stops
 * at. The M3 surfaces sit at tone 6 (dark) or 98 (light), so there is always
 * headroom long before the 0/100 stops.
 */
function legibleOver(backgroundHex: string, argb: number, darkScheme: boolean): string {
  let hct = Hct.fromInt(argb);
  let tone = hct.tone;
  let hex = hexFromArgb(hct.toInt()).toUpperCase();
  while (wcagContrast(hex, backgroundHex) < SHIFT_CONTRAST && tone > 0 && tone < 100) {
    tone = darkScheme ? Math.min(100, tone + 2) : Math.max(0, tone - 2);
    hct = Hct.from(hct.hue, hct.chroma, tone);
    hex = hexFromArgb(hct.toInt()).toUpperCase();
  }
  return hex;
}

/**
 * Derive a full custom-theme token set from one seed colour.
 *
 * The neutral and accent roles come straight off the M3 scheme, whose tonal
 * system guarantees the text pairings (the generator test still proves it from
 * the produced hexes, against ugly seeds included). The shift hues are the
 * display's defaults harmonized toward the seed and tone-adjusted to hold
 * 3:1 against the generated background.
 */
export function generateThemeTokens(seedHex: string, mode: 'light' | 'dark'): ThemeTokens {
  const seed = argbFromHex(seedHex);
  const dark = mode === 'dark';
  const scheme = new SchemeTonalSpot(Hct.fromInt(seed), dark, 0);
  const role = (argb: number): string => hexFromArgb(argb).toUpperCase();
  const background = role(scheme.surface);

  const shift = (token: keyof typeof SHIFT_DEFAULTS): string =>
    legibleOver(background, Blend.harmonize(argbFromHex(SHIFT_DEFAULTS[token]), seed), dark);

  return {
    '--bg': background,
    '--panel': role(scheme.surfaceContainer),
    '--rule': role(scheme.outlineVariant),
    '--ink': role(scheme.onSurface),
    '--muted': role(scheme.onSurfaceVariant),
    '--faint': role(scheme.outline),
    '--accent': role(scheme.primary),
    '--s-day': shift('--s-day'),
    '--s-night': shift('--s-night'),
    '--s-break': shift('--s-break'),
    '--s-straight': shift('--s-straight'),
    // The builder's own default corner; editable afterwards like everything else.
    '--radius': '0.2rem',
  };
}
