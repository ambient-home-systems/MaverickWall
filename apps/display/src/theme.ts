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
  // A soft shadow in the theme's own ink, faint: warm paper lifts a card
  // rather than floating it (decision D8, plan item P4.4).
  '--shadow-card': '0 0.1rem 0.5rem rgba(38, 34, 28, 0.14)',
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
  // None: a wireframe separates with its rules, and a shadow on a drawing
  // reads as a smudge (decision D8, plan item P4.4).
  '--shadow-card': 'none',
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
  // Soft, and dark on a dark ground, which is the only way a shadow shows on
  // one at all (decision D8, plan item P4.4).
  '--shadow-card': '0 0.15rem 0.6rem rgba(0, 0, 0, 0.45)',
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
  // Paper-like: a hard offset with no blur, a printed card laid on the
  // ledger rather than floated above it (decision D8, plan item P4.4).
  '--shadow-card': '0.08rem 0.12rem 0 rgba(36, 31, 25, 0.14)',
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
  // None: the style this theme is named after has no depth in it, and a
  // near-black ground would lose a shadow anyway (decision D8, plan item P4.4).
  '--shadow-card': 'none',
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

  // The designed styles' palette (P4.5) is derived from this theme's own
  // colours by the one derivation a custom theme goes through, and the
  // theme's declared tokens win over it — which is how a built-in's own
  // `--shadow-card` reaches the wall rather than the derived default.
  const derived: Record<string, string> = { ...paletteTokens(base), ...base };
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
  // The designed styles' palette and the card shadow (P4.4, P4.5), measured
  // against this theme's own grounds. Mirrors `withTints`, token for token.
  Object.assign(out, paletteTokens(base));
  return out;
}

/**
 * The ink to draw *on* a colour the household chose.
 *
 * A calendar's hue is the one ground on this wall that is not a theme surface:
 * it is whatever somebody picked in a colour input, or whichever entry
 * `api/palette.ts` handed them. So there is no token that is legible on it,
 * and six selectors in `display.css` used to write `#fff` and hope.
 *
 * Measured on the palette a household is actually *given*, white fails the
 * 4.5:1 bar on three of its five entries — 3.99:1 on `#4C7FD1`, the colour a
 * first calendar is assigned, and **2.16:1 on `#E8A33D`**, the colour a second
 * one is assigned with nobody having chosen anything. That second number is
 * the month grid's multi-day bar, at 18.7px, on the default treatment: the one
 * element a wall draws to say a half term is a half term.
 *
 * Black or white, whichever is further from the ground. The useful part is
 * that the answer is always *sufficient* rather than least-worst: contrast
 * against white is `1.05 / (L + 0.05)` and against black is `(L + 0.05) / 0.05`,
 * and those cross at L = 0.1791, where both read **4.58:1**. So the better of
 * the two clears 4.5:1 for every colour in the space — there is no hue a
 * household can choose that this answers badly, and no threshold to tune.
 *
 * An unparseable value keeps today's `#ffffff` rather than refusing: a stored
 * colour this cannot read is a wall that should still draw (rule nine).
 */
export function inkOn(background: string): string {
  if (parseHex(background) === undefined) return '#ffffff';
  return contrastRatio('#ffffff', background) >= contrastRatio('#000000', background)
    ? '#ffffff'
    : '#000000';
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
  eink?: boolean,
): void {
  applyThemeTokens(element, name, tokens, shape);
  /*
   * A wall sized as one of the e-ink panels on the wall-size picker draws no
   * shadow, whatever its theme says (decision D8, plan item P4.4): a shadow is
   * grey, and grey on e-ink is dither that bands. Written after the theme so
   * it wins over the theme's own `--shadow-card`, and re-written on every draw
   * with it — so a wall re-measured as a television gets its theme's shadow
   * back on the next tick rather than keeping this one.
   */
  if (eink === true) element.style.setProperty('--shadow-card', 'none');
}

function applyThemeTokens(
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
