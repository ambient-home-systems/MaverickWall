/**
 * How much card colour Glass needs over a given picture (plan item M4.2).
 *
 * Glass lays the theme's `--panel` over a blurred, saturated view of whatever
 * is behind a widget. Too little and text over a bright patch of a dark
 * wallpaper drops under 4.5:1; too much and Glass is Soft with extra steps.
 * So the opacity is solved rather than chosen: the lowest, in hundredths, at
 * which the theme's `--ink` and its demoted `--ink-scaffold` both keep 4.5:1
 * against the card colour composited over the picture's lightest **and** its
 * darkest patch, in sRGB as the browser composites it.
 *
 * Those two patches — the **backdrop** — are a fact about the picture:
 *
 * - a bundled wallpaper carries them from the catalogue (`wallpaper-glass.ts`,
 *   measured from the shipped file blurred as Glass blurs it);
 * - a solid colour or a gradient is its colours, saturated as Glass does;
 * - a household's own photo is measured on the wall, once, by `render.ts`
 *   (MQ10), and until it has been the opacity is Soft's;
 * - no background at all is the canvas's own `--panel`, which needs none.
 *
 * Solved on the wall, never stored as one number, because the inks are the
 * theme's and a household's own theme has inks no catalogue could know. Pure,
 * with no DOM, for the reason `widget-options.ts` is.
 */

export type Rgb = readonly [number, number, number];

export interface Backdrop {
  readonly light: string;
  readonly dark: string;
}

/** Soft's opacity: what Glass uses while a picture's backdrop is not known yet (MQ10). */
export const GLASS_UNMEASURED_ALPHA = 0.86;
/** `--glass-saturate`, which a solid colour or a gradient has to be put through by hand. */
export const GLASS_SATURATE = 1.4;
/** WCAG's bar for body text, the one every ground on this wall is held to. */
export const GLASS_CONTRAST = 4.5;
/**
 * How far the patches are pushed apart before solving, in levels a channel:
 * the light patch lighter and the dark one darker. An opacity solved exactly
 * at 4.5:1 has no headroom, and the same file decoded twice — or the large
 * file against the small one it was measured from — differs by a level here
 * and there, which was enough to tip Dusk on Panels under. Widening is the
 * conservative side for both tones: a dark theme's inks are bound by the light
 * patch and a light theme's by the dark one.
 */
export const GLASS_MARGIN = 3;

const HEX = /^#([0-9a-fA-F]{6})$/;

export function parseRgb(hex: string): Rgb | undefined {
  const match = HEX.exec(hex.trim());
  if (match === null) return undefined;
  const n = Number.parseInt(match[1] ?? '', 16);
  // eslint-disable-next-line no-bitwise
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function linear(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb: Rgb): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** CSS `saturate()`, by the Filter Effects matrix, on one colour. */
export function saturate(rgb: Rgb, amount: number): Rgb {
  const s = amount;
  const [r, g, b] = rgb;
  return [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ].map((v) => Math.max(0, Math.min(255, v))) as unknown as Rgb;
}

/** The card colour at `alpha` over a patch, as the browser composites it: in sRGB, rounded to a byte. */
function over(panel: Rgb, alpha: number, patch: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(alpha * (panel[i] ?? 0) + (1 - alpha) * (patch[i] ?? 0))) as unknown as Rgb;
}

/**
 * The lowest opacity, in hundredths, at which every ink keeps 4.5:1 over the
 * card colour composited on both patches — or 1, the card colour opaque,
 * which is Solid and always as good as the theme itself.
 */
export function solveGlassAlpha(panel: string, inks: readonly string[], backdrop: Backdrop): number {
  const card = parseRgb(panel);
  const light = parseRgb(backdrop.light);
  const dark = parseRgb(backdrop.dark);
  const patches = [
    light === undefined ? undefined : (light.map((v) => Math.min(255, v + GLASS_MARGIN)) as unknown as Rgb),
    dark === undefined ? undefined : (dark.map((v) => Math.max(0, v - GLASS_MARGIN)) as unknown as Rgb),
  ];
  const colours = inks.map(parseRgb);
  if (card === undefined || patches.some((p) => p === undefined) || colours.some((c) => c === undefined) || colours.length === 0) {
    return GLASS_UNMEASURED_ALPHA;
  }
  for (let step = 0; step <= 100; step++) {
    const alpha = step / 100;
    const holds = patches.every((patch) => colours.every((ink) => contrast(ink as Rgb, over(card, alpha, patch as Rgb)) >= GLASS_CONTRAST));
    if (holds) return alpha;
  }
  return 1;
}

/** The backdrop of a colour Glass is laid over: the colour itself, saturated as Glass draws it. */
export function colourBackdrop(...colours: readonly string[]): Backdrop | undefined {
  const parsed = colours.map(parseRgb).filter((c): c is Rgb => c !== undefined).map((c) => saturate(c, GLASS_SATURATE));
  if (parsed.length === 0) return undefined;
  const sorted = [...parsed].sort((a, b) => luminance(a) - luminance(b));
  return { light: hex(sorted[sorted.length - 1] as Rgb), dark: hex(sorted[0] as Rgb) };
}

/** A backdrop read back defensively: two hex colours, or nothing. */
export function readBackdrop(value: unknown): Backdrop | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { light, dark } = value as { light?: unknown; dark?: unknown };
  if (typeof light !== 'string' || typeof dark !== 'string') return undefined;
  if (parseRgb(light) === undefined || parseRgb(dark) === undefined) return undefined;
  return { light, dark };
}

/** The fill Glass draws: the card colour at `alpha`, pre-mixed because `color-mix()` is out under rule two. */
export function glassFill(panel: string, alpha: number): string | undefined {
  const card = parseRgb(panel);
  if (card === undefined || !Number.isFinite(alpha)) return undefined;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${card[0]}, ${card[1]}, ${card[2]}, ${a})`;
}

/**
 * The lightest and darkest of a picture's blocks, from its pixels: what the
 * wall measures of a household's own photo once (MQ10), drawn small, blurred
 * and saturated as Glass draws it. `data` is RGBA, `blocks` per side.
 */
export function backdropOfPixels(data: ArrayLike<number>, width: number, height: number, blocks: number): Backdrop | undefined {
  if (width <= 0 || height <= 0 || blocks <= 0) return undefined;
  const bw = width / blocks;
  const bh = height / blocks;
  let light: Rgb | undefined;
  let dark: Rgb | undefined;
  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = Math.floor(by * bh); y < Math.floor((by + 1) * bh); y++) {
        for (let x = Math.floor(bx * bw); x < Math.floor((bx + 1) * bw); x++) {
          const i = (y * width + x) * 4;
          r += data[i] ?? 0;
          g += data[i + 1] ?? 0;
          b += data[i + 2] ?? 0;
          n++;
        }
      }
      if (n === 0) continue;
      const block: Rgb = [r / n, g / n, b / n];
      if (light === undefined || luminance(block) > luminance(light)) light = block;
      if (dark === undefined || luminance(block) < luminance(dark)) dark = block;
    }
  }
  return light === undefined || dark === undefined ? undefined : { light: hex(light), dark: hex(dark) };
}
