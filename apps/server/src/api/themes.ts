import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../db/open.js';
import { colour, z } from '../validation.js';

/**
 * Custom display themes: storage, validation, and resolution to a token set the
 * manifest can carry to the wall.
 *
 * The four built-in directions (Panels / Household / Blueprint / Almanac) live
 * in the display bundle's `theme.ts` as code, along with the retired keys they
 * replaced — this owns only the *custom* themes a household builds. A built-in
 * reaches the display as a key it already knows (a retired key is aliased there); a
 * custom theme reaches it as fully-resolved token values, because the bundle has
 * never heard of it. The tint math below mirrors the display's `mix` /
 * `CELL_TINT` / `BADGE_TINT`; the two are kept in step by a `mix` unit test on
 * each side rather than a shared import, because the display has no dependency on
 * the server (or core) to share through.
 *
 * `withTints` also derives the four emphasis-role tokens (`--ink-event`,
 * `--ink-scaffold`, `--ink-quiet`, `--rule-week`) a household's custom theme
 * needs — the same derivation as the display's `customTokens`, kept in step
 * the same way, for the same reason: two readers of one stored value drifting
 * apart is this repository's most repeated bug (`shifts[0]`, `display_mode`,
 * `cellEvents`), and a custom theme with no `--ink-scaffold` resolves `var()`
 * to nothing on every date numeral in the household's own wall.
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
 * The optional font tokens a theme can set: the heading face and the body
 * face. Each value is a whole font-family *stack*, chosen from the closed
 * list below — never a free string, so nothing a household types can reach
 * the wall's stylesheet. Omitted tokens leave the display's own defaults.
 *
 * There used to be a third, `--f-mono`, for times and data readings — but the
 * wall's mono uses were never really about a monospaced face, they were about
 * digits that do not change width (`font-variant-numeric: tabular-nums`,
 * already set on `body` and inherited everywhere). A face nothing lets a
 * household actually preview is not a real choice, so the token is gone
 * rather than left pointing at a face nobody picks it for.
 */
export const FONT_TOKENS = ['--disp', '--f-sans'] as const;

/**
 * The bundled, self-hosted faces (see `apps/server/assets/fonts` and the
 * `@font-face` declarations in `display.css`). The `stack` is exactly the CSS
 * value stored in a theme's tokens, so the allowlist below is the whole of the
 * safety: a font token must equal one of these strings.
 *
 * Inter and JetBrains Mono are gone from here because they are gone from the
 * image — a stack naming a family the wall does not ship is exactly the fault
 * this list exists to prevent. Roboto Condensed stays: it is no longer the
 * built-in `--f-cond` (that is Roboto Flex at a width now, see `display.css`),
 * but the file is still bundled and a household can still choose its look by
 * name.
 */
export const FONTS: readonly { readonly label: string; readonly stack: string }[] = [
  { label: 'Roboto Flex', stack: "'Roboto Flex', 'Roboto Condensed', 'Roboto', system-ui, sans-serif" },
  { label: 'Roboto Condensed', stack: "'Roboto Condensed', 'Arial Narrow', sans-serif" },
  { label: 'Oswald', stack: "'Oswald', 'Arial Narrow', sans-serif" },
  { label: 'Space Grotesk', stack: "'Space Grotesk', system-ui, sans-serif" },
  { label: 'Fraunces', stack: "'Fraunces', Georgia, serif" },
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
    /*
     * Shadows (decision D8, plan item P4.4): the one value a household can
     * store is `none`, and absent is the derived soft shadow. Stored as the
     * CSS value itself rather than as a word the server translates, so the
     * token set is still what the wall reads — and one literal is the whole
     * of the safety, since nothing a household types can reach `box-shadow`.
     */
    '--shadow-card': z.literal('none').optional(),
  })
  .strict();

export type ThemeTokens = z.infer<typeof themeTokensSchema>;

/**
 * The built-in shapes a custom theme may borrow (RFC 014 §4.3).
 *
 * `display.css` carries per-theme *shape* rules keyed on `data-theme` —
 * Almanac's 400-weight numerals and italic date, Panels' card borders,
 * Blueprint's condensed heads — that a custom theme could never reach: its
 * colours travel as resolved tokens, but its `data-theme` was pinned to the
 * neutral sentinel unconditionally. `neutral` is the explicit member of this
 * enum for "none of these", so the control always has something checked; it
 * and an absent value resolve identically (see `resolvedShapeKey`), which is
 * what keeps a theme that never touched this control drawing exactly what it
 * drew before the column existed — no display code changes, no ETag churn.
 */
export const THEME_SHAPES = ['neutral', 'panels', 'household', 'blueprint', 'almanac', 'swiss'] as const;

export type ThemeShape = (typeof THEME_SHAPES)[number];

export const themeShapeSchema = z.enum(THEME_SHAPES, { error: () => 'Choose a shape from the list.' });

export interface ThemeRow {
  readonly id: string;
  readonly name: string;
  readonly tokens: ThemeTokens;
  /** Resolved from the stored column — `null` reads as `'neutral'`. */
  readonly shape: ThemeShape;
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
export function isLight(hex: string): boolean {
  const rgb = parseHex(hex);
  if (rgb === undefined) return false;
  // Rec. 601 luma, good enough to tell paper from slate.
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.5;
}

/** WCAG relative luminance of a hex colour, 0 (black) to 1 (white). */
function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (rgb === undefined) return 0;
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio between two hex colours, 1 (none) to 21 (max). */
function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The scaffolding ink for a custom theme: the same derivation the five
 * built-in themes were hand-tuned to (see the header comment) — start at
 * `mix(ink, background, 0.62)` and raise the ratio until the result clears
 * 4.5:1 against the theme's own background, since a fixed ratio reads
 * differently on a light ground than a dark one. A theme whose ink and
 * background are too close to ever clear the bar falls back to whatever the
 * loop last reached rather than looping past pure ink — a scaffold that is
 * merely dim is still better than a wall that cannot resolve one (rule nine).
 */
function scaffoldInk(ink: string, background: string): string {
  let ratio = 0.62;
  let value = mix(ink, background, ratio);
  while (contrastRatio(value, background) < 4.5 && ratio < 1) {
    ratio = Math.round((ratio + 0.01) * 100) / 100;
    value = mix(ink, background, ratio);
  }
  return value;
}

/**
 * The tokens the designed widget styles paint with (plan items P4.4 and P4.5),
 * derived from a theme's own grounds and ink.
 *
 * Written twice, in `apps/display/src/theme.ts` and `apps/server/src/api/
 * themes.ts`, and held character-identical by `themes.test.ts` — the seam
 * `scaffoldInk` already sits at, and for the same reason: the builder's
 * preview and the wall a custom theme reaches must draw one colour, not two
 * that agree most of the time. The five built-ins go through it too, from
 * their own colours, so a custom theme copied from Panels draws Panels' rain.
 *
 * Three families are **readable**: they paint a glyph or a word, so each
 * starts at a canonical hue and is mixed toward the theme's ink until it
 * clears 4.5:1 on *both* grounds a widget sits on, `--bg` and `--panel` —
 * `scaffoldInk`'s loop, turned round to keep a colour's identity rather than
 * to demote an ink. Weather conditions (`--wx-*`), four temperature stops
 * cold to hot (`--temp-*`), and three Home Assistant states (`--state-*`),
 * of which idle is the theme's own muted ink held to the same bar. A theme
 * whose ink cannot clear the bar ends at its ink, which is still a colour
 * (rule nine), never a loop that does not stop.
 *
 * The **skies** are grounds rather than inks: six gradients, a top and a
 * bottom each, tinted twelve per cent toward the theme's ground so a sky sits
 * in its theme, with the ink drawn over it. Each sky names its ink — white,
 * or a near-black slate for the pale snow sky — and each stop is pushed away
 * from that ink until it clears 4.5:1, so every word on every sky is legible
 * by construction rather than by a colour somebody happened to pick.
 *
 * And the **card shadow** (decision D8): `none` when the theme asked for none,
 * otherwise a soft one — dark and heavy on a dark ground, where nothing else
 * shows, and faint in the theme's own ink on a light one. The five built-ins
 * declare theirs outright and win over this; a custom theme takes this.
 * Nothing in the stylesheet reads any of it yet except a widget whose Style
 * tab asks for a drop shadow, which is what keeps every wall's pixels where
 * they were.
 */
function paletteTokens(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const background = base['--bg'] ?? '#000000';
  const panel = base['--panel'] ?? background;
  const ink = base['--ink'] ?? '#FFFFFF';
  const out: Record<string, string> = {};

  const readable = (hue: string): string => {
    let ratio = 0;
    let value = hue;
    while ((contrastRatio(value, background) < 4.5 || contrastRatio(value, panel) < 4.5) && ratio < 1) {
      ratio = Math.round((ratio + 0.02) * 100) / 100;
      value = mix(ink, hue, ratio);
    }
    return value;
  };
  const hues: readonly (readonly [string, string])[] = [
    ['--wx-sun', '#F2B632'],
    ['--wx-cloud', '#9AA7B4'],
    ['--wx-rain', '#4C8FE0'],
    ['--wx-snow', '#8CC8E8'],
    ['--wx-storm', '#9B7BE0'],
    ['--wx-fog', '#A3A8AE'],
    ['--temp-cold', '#4C8FE0'],
    ['--temp-cool', '#3FB0A8'],
    ['--temp-warm', '#F2A33A'],
    ['--temp-hot', '#E5533D'],
    ['--state-active', '#F2B632'],
    ['--state-alert', '#E5533D'],
    ['--state-idle', base['--muted'] ?? ink],
  ];
  for (const [token, hue] of hues) out[token] = readable(hue);

  const skies: readonly (readonly [string, string, string, boolean])[] = [
    ['day', '#2F6FC0', '#6FA8E8', false],
    ['night', '#141A3C', '#2E3A7A', false],
    ['cloud', '#5B6673', '#8C97A3', false],
    ['rain', '#2E3D4F', '#546A80', false],
    ['snow', '#DCE7F0', '#F4F8FB', true],
    ['storm', '#2A1F4A', '#4B3A7A', false],
  ];
  for (const [kind, top, bottom, pale] of skies) {
    const skyInk = pale ? '#1A1F24' : '#FFFFFF';
    const away = pale ? '#FFFFFF' : '#000000';
    const settle = (stop: string): string => {
      const tinted = mix(stop, background, 0.88);
      let ratio = 0;
      let value = tinted;
      while (contrastRatio(value, skyInk) < 4.5 && ratio < 1) {
        ratio = Math.round((ratio + 0.02) * 100) / 100;
        value = mix(away, tinted, ratio);
      }
      return value;
    };
    out[`--sky-${kind}-top`] = settle(top);
    out[`--sky-${kind}-bottom`] = settle(bottom);
    out[`--sky-${kind}-ink`] = skyInk;
  }

  const light = contrastRatio(background, '#000000') > contrastRatio(background, '#FFFFFF');
  const shade = parseHex(ink) ?? [0, 0, 0];
  out['--shadow-card'] =
    base['--shadow-card'] === 'none'
      ? 'none'
      : light
        ? `0 0.1rem 0.5rem rgba(${shade[0]}, ${shade[1]}, ${shade[2]}, 0.14)`
        : '0 0.15rem 0.6rem rgba(0, 0, 0, 0.45)';
  return out;
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
  // The four emphasis roles (RFC — wall type hierarchy): three are straight
  // copies, and `--ink-scaffold` is measured against this theme's own ground.
  // Mirrors `customTokens` in the display bundle's `theme.ts`, token for token.
  const ink = base['--ink'];
  out['--ink-event'] = ink;
  out['--ink-scaffold'] = scaffoldInk(ink, background);
  out['--ink-quiet'] = base['--muted'];
  out['--rule-week'] = base['--rule'];
  // The designed styles' palette and the card shadow (P4.4, P4.5), measured
  // against this theme's own grounds. Mirrors `customTokens`, token for token.
  Object.assign(out, paletteTokens(base));
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
   * The `data-theme` value the display should set.
   *
   * A built-in's key drives its shape CSS. A custom theme carries `board` by
   * default, which is **not** a theme name here but a neutral sentinel:
   * `board` is the one value no `:root[data-theme="…"]` rule in `display.css`
   * matches, so a theme with no shape choice inherits the default rather than
   * Panels' cards or Almanac's ledger. Renaming it to a live key would repaint
   * every custom theme with no shape set (RFC 015 §2.1); giving it an honest
   * name needs a `neutral` key in the display bundle, which is a display
   * change and a later phase.
   *
   * A custom theme that *did* choose a shape (RFC 014 §4.3) carries that
   * built-in's own key instead — `panels`, `household`, `blueprint`,
   * `almanac` or `swiss` — which borrows only the shape rules those keys
   * drive; the colours still come from `tokens` above, unchanged.
   */
  readonly shape: string;
}

/**
 * Resolve a stored theme reference to what the manifest carries.
 *
 * A built-in (`panels`, `household`, …) yields just its shape; the display bundle
 * fills in the tokens. A `custom:<id>` yields the resolved token set with tints.
 * A custom id that is missing or malformed falls back to **Panels** rather than
 * blanking a wall (rule nine) — the same wall it drew before, since the display
 * bundle's `LEGACY_ALIASES` has always resolved the `board` this used to answer
 * onto `panels`; what changes is that the manifest stops carrying a key that
 * has not named a theme for releases.
 *
 * The `shape: 'board'` on the line below the two fallbacks is a different
 * thing wearing the same spelling — see `ResolvedTheme.shape`.
 */
/**
 * What a reference that resolves to nothing draws: a real, live theme key.
 * Rule nine — a deleted theme degrades a wall, it never blanks one.
 *
 * Exported because the screen that deletes a theme has to *say* this, and a
 * literal in that sentence is exactly how it came to say "Board" for releases
 * after Board stopped existing (RFC 015 §2.1).
 */
export const FALLBACK_THEME = 'panels';

/**
 * The shape a *resolved* custom theme carries: no shape override at all. Named
 * rather than spelled `'board'` at the return, because the two readings of that
 * string are what made this look like one bug instead of a fix and a sentinel.
 */
const NEUTRAL_SHAPE = 'board';

/**
 * What a stored `shape` column value resolves to as a `data-theme`.
 *
 * `null` (a theme saved before the column existed) and `'neutral'` (a theme
 * that explicitly declined to borrow one) both collapse to `NEUTRAL_SHAPE` —
 * they must draw identically, which is what keeps a theme nobody has touched
 * since this shipped from churning its manifest ETag. Anything else that
 * fails to parse as a live shape key falls back the same way (rule nine): a
 * row this process did not write is never trusted over a wall staying blank.
 */
function resolvedShapeKey(stored: string | null): string {
  if (stored === null) return NEUTRAL_SHAPE;
  const parsed = themeShapeSchema.safeParse(stored);
  return !parsed.success || parsed.data === 'neutral' ? NEUTRAL_SHAPE : parsed.data;
}

export function resolveTheme(db: SqliteDatabase, ref: string): ResolvedTheme {
  if (!ref.startsWith(CUSTOM_PREFIX)) return { shape: ref };

  const id = ref.slice(CUSTOM_PREFIX.length);
  const row = db.prepare('SELECT tokens, shape FROM themes WHERE id = ?').get(id) as
    | { tokens: string; shape: string | null }
    | undefined;
  if (row === undefined) return { shape: FALLBACK_THEME };

  const parsed = themeTokensSchema.safeParse(safeJson(row.tokens));
  if (!parsed.success) return { shape: FALLBACK_THEME };
  return { tokens: withTints(parsed.data), shape: resolvedShapeKey(row.shape) };
}

// --- Storage ------------------------------------------------------------------

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The stored `shape` column as a `ThemeShape` — `null` and anything this
 *  process did not write both read as `'neutral'` (rule nine). */
function normalizeShape(stored: string | null): ThemeShape {
  if (stored === null) return 'neutral';
  const parsed = themeShapeSchema.safeParse(stored);
  return parsed.success ? parsed.data : 'neutral';
}

function rowToTheme(row: {
  id: string;
  name: string;
  tokens: string;
  shape: string | null;
}): ThemeRow | undefined {
  const parsed = themeTokensSchema.safeParse(safeJson(row.tokens));
  if (!parsed.success) return undefined;
  return { id: row.id, name: row.name, tokens: parsed.data, shape: normalizeShape(row.shape) };
}

export function readThemes(db: SqliteDatabase): ThemeRow[] {
  const rows = db
    .prepare('SELECT id, name, tokens, shape FROM themes ORDER BY name')
    .all() as { id: string; name: string; tokens: string; shape: string | null }[];
  return rows.map(rowToTheme).filter((t): t is ThemeRow => t !== undefined);
}

export function readTheme(db: SqliteDatabase, id: string): ThemeRow | undefined {
  const row = db.prepare('SELECT id, name, tokens, shape FROM themes WHERE id = ?').get(id) as
    | { id: string; name: string; tokens: string; shape: string | null }
    | undefined;
  return row === undefined ? undefined : rowToTheme(row);
}

export function createTheme(
  db: SqliteDatabase,
  input: { name: string; tokens: ThemeTokens; shape: ThemeShape },
): ThemeRow {
  const id = randomBytes(8).toString('hex');
  const at = Date.now();
  db.prepare(
    'INSERT INTO themes (id, name, tokens, shape, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, JSON.stringify(input.tokens), input.shape, at, at);
  return { id, name: input.name, tokens: input.tokens, shape: input.shape };
}

/** Update a theme's name, tokens and shape. Returns false when the id is unknown. */
export function updateTheme(
  db: SqliteDatabase,
  id: string,
  input: { name: string; tokens: ThemeTokens; shape: ThemeShape },
): boolean {
  const result = db
    .prepare('UPDATE themes SET name = ?, tokens = ?, shape = ?, updated_at = ? WHERE id = ?')
    .run(input.name, JSON.stringify(input.tokens), input.shape, Date.now(), id);
  return result.changes > 0;
}

/**
 * Delete a custom theme, and re-dress every wall wearing it in the same
 * transaction (RFC 015 §3.4).
 *
 * A bare `DELETE` left a wall storing `custom:<id>` pointing at a row that was
 * gone, and `resolveTheme` rescued it at read time. That is rule nine working —
 * and, under "every wall names its own theme", it is also a wall wearing a
 * value nobody chose, arriving through the back door. So every wearer is
 * written `FALLBACK_THEME` first, a daylight theme that named it is cleared
 * (the same theme all day, which is what the wall then draws), and only then
 * is the row removed — one transaction, so a wall polling mid-delete reads the
 * old state or the new one and never a dangling reference. The confirmation
 * page says which walls this reaches and what they will wear, through
 * `themeName(FALLBACK_THEME)`, never a literal.
 */
export function deleteTheme(db: SqliteDatabase, id: string): void {
  const ref = `${CUSTOM_PREFIX}${id}`;
  const at = Date.now();
  db.transaction(() => {
    db.prepare('UPDATE screens SET theme = ?, updated_at = ? WHERE theme = ?').run(FALLBACK_THEME, at, ref);
    db.prepare('UPDATE screens SET daytime_theme = NULL, updated_at = ? WHERE daytime_theme = ?').run(at, ref);
    db.prepare('DELETE FROM themes WHERE id = ?').run(id);
  })();
}

/**
 * Where a custom theme is actually drawn — every screen wearing it, as its
 * theme or as its daylight theme — so removing it can name what changes rather
 * than only that it will. `deleteTheme` re-dresses exactly this set.
 */
export function themeUsage(db: SqliteDatabase, id: string): ThemeUsage {
  return themeUsageOf(db, [`${CUSTOM_PREFIX}${id}`]);
}

/** A wall wearing a theme, as the two screens that say so both need it. */
export interface ThemeWearer {
  readonly id: string;
  readonly name: string;
}

export interface ThemeUsage {
  /**
   * Only walls. There used to be a `household` member here, for the row every
   * wall inherited from; that row names no theme any more (RFC 015 phase 2).
   */
  readonly screens: readonly ThemeWearer[];
}

/**
 * The same question asked of any set of references at once.
 *
 * A *set*, because a built-in is worn under more than one name: a household who
 * never changed the setting still stores `board`, and the picker folds that
 * onto `panels` (`LEGACY_THEME_ALIASES`). Which retired keys survive onto which
 * live one is the http layer's table rather than this one's — so the caller
 * passes the whole equivalence class and nothing here has to know there is such
 * a thing as a retired key.
 *
 * The id travels beside the name because a tag naming a wall is a tag somebody
 * will eventually want to press.
 */
export function themeUsageOf(db: SqliteDatabase, refs: readonly string[]): ThemeUsage {
  if (refs.length === 0) return { screens: [] };
  const holes = refs.map(() => '?').join(',');
  const screens = db
    .prepare(
      `SELECT id, name FROM screens
        WHERE theme IN (${holes}) OR daytime_theme IN (${holes})
        ORDER BY name`,
    )
    .all(...refs, ...refs) as ThemeWearer[];
  return { screens };
}

/**
 * Is a theme reference one the wall can actually draw? A built-in key, or a
 * `custom:<id>` that still exists. Used by the form validators so a household
 * cannot pin a wall to a theme that was deleted.
 *
 * An empty string is **not** valid here any more. It used to mean "follow the
 * household default", and that default is retired (RFC 015 phase 2): a wall
 * has to name a theme. The one control where blank is still an answer — the
 * daylight theme, where it means the same theme all day — decides that before
 * asking this.
 */
export function isValidThemeRef(db: SqliteDatabase, ref: string, builtins: readonly string[]): boolean {
  if (builtins.includes(ref)) return true;
  if (!ref.startsWith(CUSTOM_PREFIX)) return false;
  return readTheme(db, ref.slice(CUSTOM_PREFIX.length)) !== undefined;
}
