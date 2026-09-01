/**
 * Theme token sets, derived from the design exploration in
 * `Wall Display Directions.dc.html`.
 *
 * Four directions, and they are pure token sets: nothing outside this file
 * names a colour, so switching theme changes no logic. Panels is the default —
 * a dark modular dashboard whose shift hues separate best at ten feet — and
 * Almanac is scheduled for daylight, because a dark theme at noon is a hole in
 * the wall.
 *
 * The `.dc.html` comps are reference only; they use `color-mix()` and faces the
 * wall cannot fetch. The look is reproduced through the real token system: the
 * hues below, the tints derived from them, and a small `--disp`/shape block per
 * theme in `display.css`.
 *
 * The shift token names come from `DEFAULT_SHIFT_TYPES` in core, which sends
 * `--s-day`, `--s-night` and `--s-straight` in the manifest. `--s-break` is the
 * design's name for a rest day, and its presence is the answer to a question
 * this display previously got wrong: a break day *is* coloured, distinctly, so
 * "not working" reads differently from "no rota".
 *
 * The earlier directions (Board / Slate / Glance) were retired in this swap.
 * They survive only as `LEGACY_ALIASES` below, so a household's saved setting —
 * or a template that still names one — resolves to the nearest survivor rather
 * than blanking a wall (rule nine).
 *
 * Four emphasis roles, on top of the base palette (RFC — wall type hierarchy).
 * A wall measured on a paired 1920x1080 Classic display drew the clock at
 * 137.7px and an actual event name at 31.6px: the two facts a household
 * already knows (the time, the date) were the two largest things on the wall,
 * and the thing they do not — an event — was smaller than the numeral in its
 * own cell. These roles exist so `display.css` can say which ink a piece of
 * text gets without a colour hard-coded at the call site:
 *
 *   --ink-event      = --ink.   Event names. The one thing drawn at full ink.
 *   --ink-scaffold    a demoted ink for date numerals, weekday heads and week
 *                     numbers — present, legible, but not competing with the
 *                     event it labels.
 *   --ink-quiet       = --muted. Overflow counts, times on past events.
 *   --rule-week       = --rule. The one hairline per week row.
 *
 * `--ink-scaffold` is the one that is not a straight copy. It starts from
 * `mix(--ink, --bg, 0.62)` and the ratio is raised per theme until the result
 * clears 4.5:1 against that theme's own `--bg` — the same lesson this file
 * already recorded once, at the shift-hue declarations below, where a fixed
 * wash read as low as 1.90:1 on a cream ground that the same wash read fine
 * on a dark one. `test/theme.test.ts` holds every theme to the same bar.
 */

export type ThemeName = 'household' | 'blueprint' | 'panels' | 'almanac' | 'swiss';

export type ThemeTokens = Readonly<Record<string, string>>;

/*
 * A note on '--radius', because the unit is not what it looks like: 1rem on the
 * wall is 1% of the *canvas* height, so on the 1920px portrait target 1rem is
 * 19.2px. Household and Panels used to carry 1.1rem and 1.2rem — 21 and 23
 * real pixels — which is a rounded bubble, not a panel. They are 0.35 and 0.4
 * now (7-8px): enough to read as deliberate, not enough to read as an app.
 * Blueprint and Almanac were always square and are untouched.
 */

/** Warm daylight paper; per-person colour does the heavy lifting. */
const HOUSEHOLD: ThemeTokens = {
  '--bg': '#F4F0E8',
  '--panel': '#FFFFFF',
  '--rule': '#E6DFCF',
  '--ink': '#26221C',
  '--muted': '#8A8474',
  '--faint': '#A49C88',
  '--accent': '#B5651F',
  // Darkened from the Panels values (#E8A33D / #4C7FD1 / #35916A / #6B7684)
  // until each clears 4.5:1 on both this theme's grounds (RFC 009 Phase 6):
  // on a cream ground the same hues that read fine on a dark one sat as low
  // as 1.90:1, painted as text on what display.css calls the single most
  // important element on the wall.
  '--s-day': '#906526',
  '--s-night': '#426DB4',
  '--s-break': '#2D7A5A',
  '--s-straight': '#646E7C',
  '--radius': '0.35rem',
  '--ink-event': '#26221C',
  // mix(--ink, --bg, 0.64) — 0.62 measured 4.33:1 on --bg, short of the bar,
  // and 0.63 still only 4.46:1. #706c65 clears 4.59:1 on --bg, 5.22:1 on --panel.
  '--ink-scaffold': '#706C65',
  '--ink-quiet': '#8A8474',
  '--rule-week': '#E6DFCF',
};

/** Steel-blue on a light technical ground: the bound design system as a wall. */
const BLUEPRINT: ThemeTokens = {
  '--bg': '#F2F2F3',
  '--panel': '#FFFFFF',
  '--rule': '#C6C9CD',
  '--ink': '#1D1F20',
  '--muted': '#7C8288',
  '--faint': '#9AA0A6',
  '--accent': '#5980A6',
  // Darkened (RFC 009 Phase 6) until day, break and straight clear 4.5:1 on
  // both grounds; night already cleared it unchanged.
  '--s-day': '#946510',
  '--s-night': '#2F5D8C',
  '--s-break': '#447A4F',
  '--s-straight': '#736E63',
  '--radius': '0',
  '--ink-event': '#1D1F20',
  // mix(--ink, --bg, 0.63) — 0.62 measured 4.50:1 on --bg, too close to the
  // rounding to trust. #6c6d6e clears 4.63:1 on --bg, 5.18:1 on --panel.
  '--ink-scaffold': '#6C6D6E',
  '--ink-quiet': '#7C8288',
  '--rule-week': '#C6C9CD',
};

/** The board's descendant: dark, but the blocks read as discrete panels. */
const PANELS: ThemeTokens = {
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
  '--radius': '0.4rem',
  '--ink-event': '#EDEBE6',
  // mix(--ink, --bg, 0.62) clears 6.40:1 on --bg and 5.82:1 on --panel at the
  // starting ratio — a dark ground gives this far more room than a light one.
  '--ink-scaffold': '#9B9B9A',
  '--ink-quiet': '#9AA5B2',
  '--rule-week': '#2A323E',
};

/** Month-as-hero paper ledger: cream ground, red accent, serif display face. */
const ALMANAC: ThemeTokens = {
  '--bg': '#FBF8F1',
  '--panel': '#FFFFFF',
  '--rule': '#E4DCC9',
  '--ink': '#241F19',
  '--muted': '#8A8474',
  '--faint': '#A89F8B',
  '--accent': '#B3372B',
  // Darkened (RFC 009 Phase 6) until day, break and straight clear 4.5:1 on
  // both grounds; night already cleared it unchanged. Almanac is the theme
  // scheduled for daylight, so this is the ratio a household reads all day.
  '--s-day': '#986911',
  '--s-night': '#2F5D8C',
  '--s-break': '#467E52',
  '--s-straight': '#777166',
  '--radius': '0',
  '--ink-event': '#241F19',
  // mix(--ink, --bg, 0.62) clears 4.56:1 on --bg and 4.83:1 on --panel at the
  // starting ratio — Almanac is the theme scheduled for daylight, so this is
  // the ratio a household reads every date numeral and week number at, all day.
  '--ink-scaffold': '#76716B',
  '--ink-quiet': '#8A8474',
  '--rule-week': '#E4DCC9',
};


/**
 * Swiss: the International Typographic Style, after dark.
 *
 * The other four themes are rooms — paper, blueprint, a lit dashboard. This one
 * is deliberately not a room: a near-black ground with nothing on it, and the
 * grid doing all the work through type, negative space and one accent. It is
 * the ground the Swiss calendar mode was drawn against, though the mode reads
 * tokens like everything else and works on any theme here.
 *
 * '--bg' is #09090B rather than pure #000000. On an OLED panel a true black
 * clips to the panel's own off state, so the hairline rules sitting a couple of
 * points above it stop being a *step* and start being the only thing lit —
 * which reads as a grid drawn on nothing rather than as a grid. Two points of
 * lift keeps the relationship and is indistinguishable from black in a kitchen.
 *
 * '--faint' is the out-of-month grey and is the one token here deliberately
 * below the contrast bar: at 1.91:1 a day belonging to the next month is
 * present without being readable across a room, which is exactly its job. Every
 * other token clears 4.5:1 on the canvas, checked in test/theme.test.ts.
 */
const SWISS: ThemeTokens = {
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
  // Lifted from the #71717A this wanted to be: that read 4.12:1 on the canvas,
  // and a rota colour a household cannot read is a rota colour that is not
  // doing anything.
  '--s-straight': '#7E7E86',
  '--radius': '0',
  '--ink-event': '#FFFFFF',
  // mix(--ink, --bg, 0.62) clears 7.79:1 on --bg and 7.50:1 on --panel at the
  // starting ratio — the darkest ground in the bundle gives white the most
  // room of any theme here.
  '--ink-scaffold': '#A2A2A2',
  '--ink-quiet': '#A1A1AA',
  '--rule-week': '#27272A',
};

const THEMES: Readonly<Record<ThemeName, ThemeTokens>> = {
  household: HOUSEHOLD,
  blueprint: BLUEPRINT,
  panels: PANELS,
  almanac: ALMANAC,
  swiss: SWISS,
};

/**
 * Every theme this bundle draws, in declaration order.
 *
 * Exported so a test can iterate them rather than transcribe them. A sixth
 * theme added to `THEMES` above joins the contrast assertions in
 * `test/theme.test.ts` on the same commit — a hand-copied list would not, and
 * the whole reason those assertions exist is that four themes shipped without
 * anything checking them.
 */
export const THEME_NAMES: readonly ThemeName[] = Object.keys(THEMES) as ThemeName[];

/** The fallback for an unknown key — a version skew, or a retired theme. */
const DEFAULT_THEME: ThemeName = 'panels';

/**
 * Retired theme keys mapped to the nearest survivor.
 *
 * Board, Slate and Glance were the old dark directions; all three resolve to
 * Panels, the new dark default, so a household who never touched the theme
 * setting — the column default is still `board` (changing it would need a
 * table-recreate migration for no benefit, since it resolves here) — and any
 * template still naming one keep a dark wall rather than being flipped to a
 * light theme or blanked. The mapping is dark→dark deliberately: aliasing the
 * warm-dark Slate to the warm-*light* Household would turn an office dashboard
 * inside out on upgrade.
 */
const LEGACY_ALIASES: Readonly<Record<string, ThemeName>> = {
  board: 'panels',
  slate: 'panels',
  glance: 'panels',
};

/**
 * Resolve any stored key to a theme this bundle draws: itself if known, its
 * alias if retired, else the default.
 */
function resolveName(name: string): ThemeName {
  if (name in THEMES) return name as ThemeName;
  const alias = LEGACY_ALIASES[name];
  return alias ?? DEFAULT_THEME;
}

/**
 * How lightly each theme washes a shift cell.
 *
 * A 20% wash of a hue over white is far louder than the same wash over near
 * black, so the light themes use 0.13 and the dark default uses 0.20 — the
 * design's own split, kept for any new light/dark theme.
 */
const CELL_TINT: Readonly<Record<ThemeName, number>> = {
  household: 0.13,
  blueprint: 0.13,
  panels: 0.2,
  almanac: 0.13,
  // Swiss is darker than Panels, so the same wash reads fainter on it — but it
  // is also the theme whose whole argument is that colour is scarce, and a
  // rota tint loud enough to fill a cell would be the one filled shape on a
  // wall built out of type and space. It stays at the light themes' amount on
  // the dark ground deliberately: present, and no more than that.
  swiss: 0.13,
};
const BADGE_TINT = 0.16;

const SHIFT_TOKENS = ['--s-day', '--s-night', '--s-break', '--s-straight'] as const;

function parseHex(value: string): [number, number, number] | undefined {
  const hex = value.trim().replace('#', '');
  if (hex.length !== 6) return undefined;
  const number = Number.parseInt(hex, 16);
  if (!Number.isFinite(number)) return undefined;
  // eslint-disable-next-line no-bitwise
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function toHex(channel: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Blend two colours, because `color-mix()` is not available here.
 *
 * The design file uses `color-mix(in srgb, var(--sc) 20%, transparent)`, which
 * lands in browsers of the same vintage as `:has()` — and rule two exists
 * because the wall runs on whatever tablet the household already owned. Mixing
 * against the theme's own background at build-of-the-token-set time gives the
 * identical result on a browser from 2019, since the surface behind a cell is
 * always the page background.
 */
export function mix(foreground: string, background: string, amount: number): string {
  const front = parseHex(foreground);
  const back = parseHex(background);
  if (front === undefined || back === undefined) return foreground;
  const blend = (index: 0 | 1 | 2): string =>
    toHex(front[index] * amount + back[index] * (1 - amount));
  return `#${blend(0)}${blend(1)}${blend(2)}`;
}

/**
 * A theme's tokens, with the pre-mixed tints added.
 *
 * `--s-day-tint` and friends are what a horizon cell and a shift badge are
 * filled with. Deriving them here keeps the source of truth as the four hues
 * the design actually specifies.
 */
export function themeTokens(name: string): ThemeTokens {
  // An unknown name falls back rather than throwing, and a retired key resolves
  // to its alias. A theme key the server knows about and this bundle does not is
  // a version skew, not a reason for a wall to go blank.
  const key: ThemeName = resolveName(name);
  const base = THEMES[key];
  const background = base['--bg'] ?? '#000000';

  const derived: Record<string, string> = { ...base };
  for (const token of SHIFT_TOKENS) {
    const hue = base[token];
    if (hue === undefined) continue;
    derived[`${token}-tint`] = mix(hue, background, CELL_TINT[key]);
    derived[`${token}-badge`] = mix(hue, background, BADGE_TINT);
  }
  return derived;
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
 * A custom theme's base tokens with the derived shift tints added — the client
 * mirror of the server's `withTints` (`apps/server/src/api/themes.ts`), so the
 * builder's live preview matches the wall the manifest will draw. A light
 * background is washed more lightly than a dark one (the design's own rule),
 * decided by measuring the background rather than naming a theme.
 */
export function customTokens(base: Readonly<Record<string, string>>): Record<string, string> {
  const background = base['--bg'] ?? '#000000';
  const ink = base['--ink'] ?? '#000000';
  const rgb = parseHex(background);
  const light = rgb !== undefined && (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.5;
  const cell = light ? 0.13 : 0.2;
  const out: Record<string, string> = { ...base };
  for (const token of SHIFT_TOKENS) {
    const hue = base[token];
    if (hue === undefined) continue;
    out[`${token}-tint`] = mix(hue, background, cell);
    out[`${token}-badge`] = mix(hue, background, BADGE_TINT);
  }
  // The four emphasis roles (see the header comment): three are straight
  // copies, and `--ink-scaffold` is measured against this theme's own ground.
  out['--ink-event'] = ink;
  out['--ink-scaffold'] = scaffoldInk(ink, background);
  out['--ink-quiet'] = base['--muted'] ?? ink;
  out['--rule-week'] = base['--rule'] ?? background;
  return out;
}

/**
 * The cell tint (the wash behind a shift) for a single explicit shift colour
 * against a background — the same maths `customTokens` applies to the theme's
 * shift tokens, so a per-type colour tints exactly as a theme colour does. A
 * light background is washed more lightly (the design's rule).
 */
export function shiftTint(color: string, background: string): string {
  const rgb = parseHex(background);
  const light = rgb !== undefined && (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.5;
  return mix(color, background, light ? 0.13 : 0.2);
}

/**
 * Which theme should be showing at this local time.
 *
 * The window is inclusive of its start and exclusive of its end, and a window
 * that wraps midnight is honoured — somebody working nights may well want the
 * light theme through the small hours.
 */
export function daytimeActive(
  localHhmm: string,
  daytime?: string,
  startsAt?: string,
  endsAt?: string,
): boolean {
  if (daytime === undefined || startsAt === undefined || endsAt === undefined) return false;
  if (startsAt === endsAt) return false;
  return startsAt < endsAt
    ? localHhmm >= startsAt && localHhmm < endsAt
    : localHhmm >= startsAt || localHhmm < endsAt;
}

export function themeAt(
  localHhmm: string,
  active: string,
  daytime?: string,
  startsAt?: string,
  endsAt?: string,
): string {
  return daytimeActive(localHhmm, daytime, startsAt, endsAt) && daytime !== undefined
    ? daytime
    : active;
}

export interface Themeable {
  readonly style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
}

/**
 * Write a token set onto an element.
 *
 * The name also goes on as `data-theme`, because a few of the design's rules
 * are shape rather than colour — Almanac italicises the date and drops the cell
 * fills to a ledger look, Panels gives each block a card, Blueprint squares
 * every corner — and those cannot be expressed as a custom property.
 */
export function applyTheme(
  element: Themeable,
  name: string,
  tokens?: Readonly<Record<string, string>>,
  shape?: string,
): void {
  // A custom theme: the server resolved its tokens (base colours plus the tints)
  // because this bundle has never heard of it. Apply them verbatim and take the
  // shape the server chose — `board`, which has no shape override, so a custom
  // theme inherits the neutral default CSS rather than any theme's card/ledger
  // look. `board` survives here purely as that neutral sentinel; it is never a
  // key a built-in resolves to.
  if (tokens !== undefined) {
    for (const key of Object.keys(tokens)) {
      const value = tokens[key];
      if (value !== undefined) element.style.setProperty(key, value);
    }
    element.setAttribute('data-theme', shape ?? 'board');
    return;
  }

  // A built-in (or a retired/version-skew key): resolve it from this bundle so
  // the tokens and the `data-theme` shape agree — a saved `board` renders as
  // Panels, colours and card shape together.
  const resolved = themeTokens(name);
  for (const key of Object.keys(resolved)) {
    const value = resolved[key];
    if (value !== undefined) element.style.setProperty(key, value);
  }
  element.setAttribute('data-theme', resolveName(name));
}
