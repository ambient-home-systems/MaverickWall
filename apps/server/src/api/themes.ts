import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../db/open.js';
import { colour, z } from '../validation.js';

/**
 * Custom display themes: storage, validation, and resolution to a token set the
 * manifest can carry to the wall.
 *
 * The four built-in directions (Board / Slate / Almanac / Glance) live in the
 * display bundle's `theme.ts` as code — this owns only the *custom* themes a
 * household builds. A built-in reaches the display as a key it already knows; a
 * custom theme reaches it as fully-resolved token values, because the bundle has
 * never heard of it. The tint math below mirrors the display's `mix` /
 * `CELL_TINT` / `BADGE_TINT`; the two are kept in step by a `mix` unit test on
 * each side rather than a shared import, because the display has no dependency on
 * the server (or core) to share through.
 */

/** The prefix a stored theme reference carries; a built-in has no prefix. */
export const CUSTOM_PREFIX = 'custom:';

/**
 * The colour tokens a theme sets — the same names `apps/display/src/theme.ts`
 * uses, so a resolved custom theme drops straight into the CSS custom properties
 * the wall already consumes. Fonts are a later phase.
 */
export const COLOUR_TOKENS = [
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
] as const;

/** The shift hues that get a pre-mixed cell tint and badge tint. */
const SHIFT_TOKENS = ['--s-day', '--s-night', '--s-break', '--s-straight'] as const;

/**
 * The optional font tokens a theme can set: the heading face, the body face and
 * the data/times face. Each value is a whole font-family *stack*, chosen from
 * the closed list below — never a free string, so nothing a household types can
 * reach the wall's stylesheet. Omitted tokens leave the display's own defaults.
 */
export const FONT_TOKENS = ['--disp', '--f-sans', '--f-mono'] as const;

/**
 * The bundled, self-hosted faces (see `apps/server/assets/fonts` and the
 * `@font-face` declarations in `display.css`). The `stack` is exactly the CSS
 * value stored in a theme's tokens, so the allowlist below is the whole of the
 * safety: a font token must equal one of these strings.
 */
export const FONTS: readonly { readonly label: string; readonly stack: string }[] = [
  { label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
  { label: 'Roboto Condensed', stack: "'Roboto Condensed', 'Arial Narrow', sans-serif" },
  { label: 'Oswald', stack: "'Oswald', 'Arial Narrow', sans-serif" },
  { label: 'Space Grotesk', stack: "'Space Grotesk', system-ui, sans-serif" },
  { label: 'Fraunces', stack: "'Fraunces', Georgia, serif" },
  { label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
];

const FONT_STACKS = new Set(FONTS.map((f) => f.stack));
const fontStack = z.string().refine((s) => FONT_STACKS.has(s), {
  error: () => 'Choose a font from the list.',
});

/**
 * A theme's stored tokens: every colour a 6-digit hex, plus a bounded `--radius`.
 * `.strict()` refuses any other key (rule five), so a stray property can never
 * reach the wall's stylesheet. Fonts join this schema in a later phase.
 */
export const themeTokensSchema = z
  .object({
    '--bg': colour(),
    '--panel': colour(),
    '--rule': colour(),
    '--ink': colour(),
    '--muted': colour(),
    '--faint': colour(),
    '--accent': colour(),
    '--s-day': colour(),
    '--s-night': colour(),
    '--s-break': colour(),
    '--s-straight': colour(),
    '--radius': z
      .string()
      .regex(/^(0|[0-9]{1,2}(\.[0-9]{1,2})?(rem|px|em))$/, 'a small length like 0.4rem or 0'),
    // Optional font choices — a whole stack from the bundled allowlist, or absent
    // to keep the display's defaults.
    '--disp': fontStack.optional(),
    '--f-sans': fontStack.optional(),
    '--f-mono': fontStack.optional(),
  })
  .strict();

export type ThemeTokens = z.infer<typeof themeTokensSchema>;

export interface ThemeRow {
  readonly id: string;
  readonly name: string;
  readonly tokens: ThemeTokens;
}

// --- Colour maths, mirrored from the display bundle (see the header note) -----

function parseHex(value: string): [number, number, number] | undefined {
  const hex = value.trim().replace('#', '');
  if (hex.length !== 6) return undefined;
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return undefined;
  // eslint-disable-next-line no-bitwise
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');
}

/**
 * Blend `foreground` over `background` by `amount` (0..1). `color-mix()` is out
 * on the wall under rule two, so the tint is baked here against the theme's own
 * background — the surface behind a cell is always the page background, so the
 * result is identical to a runtime mix on a 2019 browser.
 */
export function mix(foreground: string, background: string, amount: number): string {
  const front = parseHex(foreground);
  const back = parseHex(background);
  if (front === undefined || back === undefined) return foreground;
  const blend = (i: 0 | 1 | 2): string => toHex(front[i] * amount + back[i] * (1 - amount));
  return `#${blend(0)}${blend(1)}${blend(2)}`;
}

/** Perceived lightness of a hex colour, 0 (black) to 1 (white). */
function isLight(hex: string): boolean {
  const rgb = parseHex(hex);
  if (rgb === undefined) return false;
  // Rec. 601 luma, good enough to tell paper from slate.
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.5;
}

/**
 * A theme's tokens with the derived shift tints added.
 *
 * A 20% wash of a hue reads far louder over paper than over near-black, so a
 * light background gets the same lighter figure Almanac uses (0.13) and a dark
 * one the default 0.2 — the design's own rule, applied by measuring the
 * background rather than naming the theme.
 */
export function withTints(base: ThemeTokens): Record<string, string> {
  const background = base['--bg'];
  const cell = isLight(background) ? 0.13 : 0.2;
  // Copy only the tokens that are set — the optional font tokens may be absent,
  // and an undefined value has no place in the CSS custom-property map.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value;
  for (const token of SHIFT_TOKENS) {
    const hue = base[token];
    out[`${token}-tint`] = mix(hue, background, cell);
    out[`${token}-badge`] = mix(hue, background, 0.16);
  }
  return out;
}

// --- Resolution ---------------------------------------------------------------

export interface ResolvedTheme {
  /**
   * The full token set for a *custom* theme. Absent for a built-in, whose tokens
   * the display bundle already owns — it is sent only as a key.
   */
  readonly tokens?: Readonly<Record<string, string>>;
  /**
   * The `data-theme` value the display should set — a built-in's key drives its
   * shape CSS; a custom theme carries `board`, so it inherits the default shape.
   */
  readonly shape: string;
}

/**
 * Resolve a stored theme reference to what the manifest carries.
 *
 * A built-in (`board`, `slate`, …) yields just its shape; the display bundle
 * fills in the tokens. A `custom:<id>` yields the resolved token set with tints.
 * A custom id that is missing or malformed falls back to Board rather than
 * blanking a wall (rule nine).
 */
export function resolveTheme(db: SqliteDatabase, ref: string): ResolvedTheme {
  if (!ref.startsWith(CUSTOM_PREFIX)) return { shape: ref };

  const id = ref.slice(CUSTOM_PREFIX.length);
  const row = db.prepare('SELECT tokens FROM themes WHERE id = ?').get(id) as
    | { tokens: string }
    | undefined;
  if (row === undefined) return { shape: 'board' };

  const parsed = themeTokensSchema.safeParse(safeJson(row.tokens));
  if (!parsed.success) return { shape: 'board' };
  return { tokens: withTints(parsed.data), shape: 'board' };
}

// --- Storage ------------------------------------------------------------------

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToTheme(row: { id: string; name: string; tokens: string }): ThemeRow | undefined {
  const parsed = themeTokensSchema.safeParse(safeJson(row.tokens));
  if (!parsed.success) return undefined;
  return { id: row.id, name: row.name, tokens: parsed.data };
}

export function readThemes(db: SqliteDatabase): ThemeRow[] {
  const rows = db
    .prepare('SELECT id, name, tokens FROM themes ORDER BY name')
    .all() as { id: string; name: string; tokens: string }[];
  return rows.map(rowToTheme).filter((t): t is ThemeRow => t !== undefined);
}

export function readTheme(db: SqliteDatabase, id: string): ThemeRow | undefined {
  const row = db.prepare('SELECT id, name, tokens FROM themes WHERE id = ?').get(id) as
    | { id: string; name: string; tokens: string }
    | undefined;
  return row === undefined ? undefined : rowToTheme(row);
}

export function createTheme(db: SqliteDatabase, input: { name: string; tokens: ThemeTokens }): ThemeRow {
  const id = randomBytes(8).toString('hex');
  const at = Date.now();
  db.prepare(
    'INSERT INTO themes (id, name, tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.name, JSON.stringify(input.tokens), at, at);
  return { id, name: input.name, tokens: input.tokens };
}

/** Update a theme's name and tokens. Returns false when the id is unknown. */
export function updateTheme(
  db: SqliteDatabase,
  id: string,
  input: { name: string; tokens: ThemeTokens },
): boolean {
  const result = db
    .prepare('UPDATE themes SET name = ?, tokens = ?, updated_at = ? WHERE id = ?')
    .run(input.name, JSON.stringify(input.tokens), Date.now(), id);
  return result.changes > 0;
}

export function deleteTheme(db: SqliteDatabase, id: string): void {
  db.prepare('DELETE FROM themes WHERE id = ?').run(id);
}

/**
 * Is a stored theme reference one the wall can actually draw? Empty (follow the
 * default), a built-in key, or a `custom:<id>` that still exists. Used by the
 * form validators so a household cannot pin a wall to a theme that was deleted.
 */
export function isValidThemeRef(db: SqliteDatabase, ref: string, builtins: readonly string[]): boolean {
  if (ref === '') return true;
  if (builtins.includes(ref)) return true;
  if (!ref.startsWith(CUSTOM_PREFIX)) return false;
  return readTheme(db, ref.slice(CUSTOM_PREFIX.length)) !== undefined;
}
