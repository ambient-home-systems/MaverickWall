/**
 * Theme token sets, taken from `maverick-wall-design-directions.html`.
 *
 * Four directions, and they are pure token sets: nothing outside this file
 * names a colour, so switching theme changes no logic. Board is the default —
 * its shift hues separate best at ten feet — and Almanac is scheduled for
 * daylight, because Board at noon is a hole in the wall.
 *
 * The shift token names come from `DEFAULT_SHIFT_TYPES` in core, which sends
 * `--s-day`, `--s-night` and `--s-straight` in the manifest. `--s-break` is the
 * design's name for a rest day, and its presence is the answer to a question
 * this display previously got wrong: a break day *is* coloured, distinctly, so
 * "not working" reads differently from "no rota".
 */

export type ThemeName = 'board' | 'slate' | 'almanac' | 'glance';

export type ThemeTokens = Readonly<Record<string, string>>;

const BOARD: ThemeTokens = {
  '--bg': '#0B0E11',
  '--panel': '#151A21',
  '--rule': '#242D38',
  '--ink': '#E9EEF4',
  '--muted': '#7E8C9C',
  '--faint': '#4A5563',
  '--accent': '#E8A33D',
  '--s-day': '#E8A33D',
  '--s-night': '#4C7FD1',
  '--s-break': '#35916A',
  '--s-straight': '#6B7684',
  '--radius': '0.2rem',
};

const SLATE: ThemeTokens = {
  '--bg': '#191713',
  '--panel': '#23201A',
  '--rule': '#3A342A',
  '--ink': '#F4EFE4',
  '--muted': '#9C9384',
  '--faint': '#635C50',
  '--accent': '#D2A93F',
  '--s-day': '#D2A93F',
  '--s-night': '#6C8FAB',
  '--s-break': '#83A173',
  '--s-straight': '#8A8074',
  '--radius': '1.2rem',
};

const ALMANAC: ThemeTokens = {
  '--bg': '#F6F3EC',
  '--panel': '#FFFFFF',
  '--rule': '#D6D0C2',
  '--ink': '#1A1815',
  '--muted': '#6B6558',
  '--faint': '#A9A294',
  '--accent': '#B3372B',
  '--s-day': '#C98A16',
  '--s-night': '#2F5D8C',
  '--s-break': '#4A8556',
  '--s-straight': '#8C8578',
  '--radius': '0',
};

const GLANCE: ThemeTokens = {
  '--bg': '#07080A',
  '--panel': '#0E1014',
  '--rule': '#1C2028',
  '--ink': '#FFFFFF',
  '--muted': '#7C848F',
  '--faint': '#464D57',
  '--accent': '#FFFFFF',
  '--s-day': '#F0A93A',
  '--s-night': '#4F86DE',
  '--s-break': '#35A87A',
  '--s-straight': '#78838F',
  '--radius': '0.3rem',
};

const THEMES: Readonly<Record<ThemeName, ThemeTokens>> = {
  board: BOARD,
  slate: SLATE,
  almanac: ALMANAC,
  glance: GLANCE,
};

/**
 * Almanac tints its cells more lightly than the dark themes do.
 *
 * A 20% wash of a hue over white is far louder than the same wash over near
 * black, so the design uses a different figure on paper.
 */
const CELL_TINT: Readonly<Record<ThemeName, number>> = {
  board: 0.2,
  slate: 0.2,
  almanac: 0.13,
  glance: 0.2,
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
  // An unknown name falls back rather than throwing. A theme key the server
  // knows about and this bundle does not is a version skew, not a reason for a
  // wall to go blank.
  const key: ThemeName = name in THEMES ? (name as ThemeName) : 'board';
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

/**
 * A custom theme's base tokens with the derived shift tints added — the client
 * mirror of the server's `withTints` (`apps/server/src/api/themes.ts`), so the
 * builder's live preview matches the wall the manifest will draw. A light
 * background is washed more lightly than a dark one (the design's own rule),
 * decided by measuring the background rather than naming a theme.
 */
export function customTokens(base: Readonly<Record<string, string>>): Record<string, string> {
  const background = base['--bg'] ?? '#000000';
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
  return out;
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
 * are shape rather than colour — Almanac italicises the date and drops the
 * cell fills to ledger rules, Glance hides the week ahead entirely — and those
 * cannot be expressed as a custom property.
 */
export function applyTheme(
  element: Themeable,
  name: string,
  tokens?: Readonly<Record<string, string>>,
  shape?: string,
): void {
  // A custom theme: the server resolved its tokens (base colours plus the tints)
  // because this bundle has never heard of it. Apply them verbatim and take the
  // shape the server chose — `board`, so it inherits the default shape CSS.
  if (tokens !== undefined) {
    for (const key of Object.keys(tokens)) {
      const value = tokens[key];
      if (value !== undefined) element.style.setProperty(key, value);
    }
    element.setAttribute('data-theme', shape ?? 'board');
    return;
  }

  // A built-in (or a version-skew fallback): resolve the key from this bundle.
  const resolved = themeTokens(name);
  for (const key of Object.keys(resolved)) {
    const value = resolved[key];
    if (value !== undefined) element.style.setProperty(key, value);
  }
  element.setAttribute('data-theme', name in THEMES ? name : 'board');
}
