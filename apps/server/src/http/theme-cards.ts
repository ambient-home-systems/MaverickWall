import { escapeHtml } from './escape.js';
import type { ThemeRow } from '../api/themes.js';

/**
 * The themes a wall can draw, and the card that shows one.
 *
 * Lifted out of `admin.ts` unchanged (RFC 015 phase 1). It moved because of
 * who needs it rather than because that file is long: `/admin/themes` is the
 * screen named after colour and was the one screen that could not name a
 * theme, and `admin-themes.ts` could not reach this table without importing
 * `admin.ts` — which imports `admin-themes.ts` back to register its routes.
 * ESM tolerates that cycle; a module that is only a table and a builder does
 * not need to be in it.
 *
 * Nothing here knows about a database or a request. `themeCards` takes the
 * custom themes it should list; it does not read them.
 */

/**
 * The five themes the display bundle ships, in the order a household meets
 * them. The key is what is stored; the label is "Name — what it is for", split
 * on the em dash by everything that draws it.
 *
 * This list is the source of every built-in name a household reads. A screen
 * that types the names instead is exactly how `/admin/themes` came to offer
 * three themes that no longer exist while omitting three that ship
 * (RFC 015 §2.1), so the assertions read it rather than a literal.
 */
export const THEMES = [
  { key: 'panels', label: 'Panels — dark, each widget a card' },
  { key: 'household', label: 'Household — warm daylight paper' },
  { key: 'blueprint', label: 'Blueprint — light technical wireframe' },
  { key: 'almanac', label: 'Paper Almanac — the month, as a ledger' },
  { key: 'swiss', label: 'Swiss — near-black, typographic, no cards' },
] as const;

/**
 * The three swatch colours per theme — background, accent, a shift hue. Taken
 * from the design file's token sets so the card previews what the wall will
 * actually look like. Kept beside `THEMES` so a theme added to one is a
 * visible hole in the other.
 *
 * Three colours and not a token set: the five built-in palettes live in
 * `apps/display/src/theme.ts` and the server has never held them. That is why
 * "duplicate a built-in" is a later phase rather than a button — it would have
 * to write eleven colours the server would first have to be given, as a
 * parity-tested transcription (RFC 015 §3.4).
 */
export const THEME_SWATCHES: Readonly<Record<string, readonly [string, string, string]>> = {
  panels: ['#14181E', '#5C93E0', '#E8A33D'],
  household: ['#F4F0E8', '#B5651F', '#4C7FD1'],
  blueprint: ['#F2F2F3', '#5980A6', '#2F5D8C'],
  almanac: ['#FBF8F1', '#B3372B', '#2F5D8C'],
  swiss: ['#09090B', '#FFB224', '#5C93E0'],
};

/**
 * Retired theme keys mapped to their surviving equivalent, mirroring the
 * display bundle's `LEGACY_ALIASES`. A household who never changed the setting
 * still carries `board` in the database; normalising it here highlights the
 * right card and pre-selects the right option, so the picker matches the wall.
 */
export const LEGACY_THEME_ALIASES: Readonly<Record<string, string>> = {
  board: 'panels',
  slate: 'panels',
  glance: 'panels',
};

/** A stored theme reference as the picker should show it — retired keys folded
 *  onto their survivor, everything else (a built-in or a `custom:<id>`) as-is. */
export function displayThemeRef(ref: string): string {
  return LEGACY_THEME_ALIASES[ref] ?? ref;
}

/** The bare display name of a built-in theme key, e.g. `panels` → "Panels".
 *  Used to tell a household which theme a template was designed for. */
export function themeName(key: string): string {
  const found = THEMES.find((t) => t.key === key);
  return found ? found.label.split(' — ')[0] ?? found.label : key;
}

/** Three representative colours out of a custom theme's own token set. */
export function customSwatch(tokens: Readonly<Record<string, string | undefined>>): readonly string[] {
  return [
    tokens['--bg'] ?? '#0B0E11',
    tokens['--accent'] ?? '#E8A33D',
    tokens['--s-night'] ?? '#4C7FD1',
  ];
}

/** One theme, as the two screens that list themes both see it. */
export interface ThemeChoice {
  /** What a picker posts: a built-in key, or `custom:<id>`. */
  readonly ref: string;
  readonly name: string;
  /** The half of the label after the em dash — what the theme is for. */
  readonly caption: string;
  readonly swatches: readonly string[];
}

/**
 * Every theme a wall can draw: the five built-ins, then whatever the household
 * built, in that order.
 *
 * One list for the picker and the gallery, because two lists is how one of
 * them comes to be missing the built-ins — which is exactly what
 * `/admin/themes` did, listing them only inside an empty state that vanished
 * the moment a household made one theme of their own (RFC 015 §2.2).
 */
export function themeChoices(custom: readonly ThemeRow[] = []): readonly ThemeChoice[] {
  const builtins = THEMES.map((theme): ThemeChoice => {
    const [name, ...rest] = theme.label.split(' — ');
    return {
      ref: theme.key,
      name: name ?? theme.key,
      caption: rest.join(' — '),
      swatches: THEME_SWATCHES[theme.key] ?? ['#0B0E11', '#E0A33E', '#4C7FD1'],
    };
  });
  const theirs = custom.map(
    (theme): ThemeChoice => ({
      ref: `custom:${theme.id}`,
      name: theme.name,
      caption: 'Your theme',
      swatches: customSwatch(theme.tokens),
    }),
  );
  return [...builtins, ...theirs];
}

/**
 * The inside of a theme card: the swatch strip, then the caption.
 *
 * One markup, because the card is drawn in two places that must not drift —
 * the picker, where it wraps a radio, and the gallery, where there is nothing
 * to choose and the card is the thing itself. Two builders is two answers to
 * "what does Almanac look like", which is the fault this whole RFC is about
 * one level up.
 *
 * `trail` is whatever belongs under the caption on the gallery — the usage
 * tags and the per-theme actions. A picker passes nothing, because a control
 * inside a `<label>` is a control the label steals the click from.
 */
function themeCardBody(choice: ThemeChoice, trail: string): string {
  return (
    `<div class="sw">` +
    choice.swatches.map((c) => `<i style="background:${escapeHtml(c)}"></i>`).join('') +
    `</div>` +
    `<div class="cap"><b>${escapeHtml(choice.name)}</b>` +
    `<small>${escapeHtml(choice.caption)}</small>` +
    trail +
    `</div>`
  );
}

/**
 * A theme card with nothing to choose — the gallery's card.
 *
 * The same `.themecard` rule the picker draws on; only the element differs,
 * because a `<div>` that is not a control must not be a `<label>` and must not
 * claim a pointer. The picker below is this card plus an input.
 */
export function themeDisplayCard(choice: ThemeChoice, trail = ''): string {
  return `<div class="themecard">${themeCardBody(choice, trail)}</div>`;
}

/**
 * The theme picker as selectable cards, scriptless.
 *
 * A radio per theme wrapped in a `.themecard` label: it posts `theme` exactly
 * as the old `<select>` did, so the handler is unchanged, and the amber ring on
 * the checked card is pure CSS (`:has(input:checked)`), which is fine in the
 * admin — rule two is about the locked wall tablet, not the household's phone.
 */
export function themeCards(selected: string, custom: readonly ThemeRow[] = []): string {
  const cards = themeChoices(custom)
    .map(
      (choice) =>
        `<label class="themecard">` +
        `<input type="radio" name="theme" value="${escapeHtml(choice.ref)}"` +
        `${choice.ref === selected ? ' checked' : ''}>` +
        themeCardBody(choice, '') +
        `</label>`,
    )
    .join('');
  return `<div class="themegrid">${cards}</div>`;
}
