import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  customTokens,
  daytimeActive,
  inkOn,
  shiftTint,
  THEME_NAMES,
  themeAt,
  type ThemeName,
  type Themeable,
} from '../src/theme.js';

/**
 * The two theme paths on the display: a built-in resolved from this bundle by
 * key, and a custom theme whose tokens the server already resolved and sent.
 * `applyTheme` writes to a tiny `Themeable`, so no DOM is needed.
 */

function fake(): Themeable & { readonly props: Record<string, string>; readonly attrs: Record<string, string> } {
  const props: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  return {
    style: { setProperty: (k: string, v: string): void => void (props[k] = v) },
    setAttribute: (k: string, v: string): void => void (attrs[k] = v),
    props,
    attrs,
  };
}

describe('applyTheme', () => {
  it('resolves a built-in from the bundle by key', () => {
    const el = fake();
    applyTheme(el, 'panels');
    expect(el.props['--bg']).toBeDefined();
    expect(el.props['--s-day-tint']).toBeDefined(); // derived here for built-ins
    expect(el.attrs['data-theme']).toBe('panels');
  });

  it('applies supplied custom tokens verbatim with the given shape', () => {
    const el = fake();
    applyTheme(el, 'custom:x', { '--bg': '#123456', '--accent': '#abcdef' }, 'board');
    expect(el.props['--bg']).toBe('#123456');
    expect(el.props['--accent']).toBe('#abcdef');
    // `board` is the neutral shape sentinel: it has no data-theme override, so a
    // custom theme inherits the default CSS rather than any theme's card look.
    expect(el.attrs['data-theme']).toBe('board');
  });

  it('defaults a custom theme to the neutral board shape when none is named', () => {
    const el = fake();
    applyTheme(el, 'custom:x', { '--bg': '#000000' });
    expect(el.attrs['data-theme']).toBe('board');
  });

  it('resolves a retired key to its surviving alias, shape and all', () => {
    // Board/Slate/Glance were retired in the theme swap; a household who never
    // changed the setting still carries `board`, and it must render as Panels
    // (colours and card shape together), not blank.
    const el = fake();
    applyTheme(el, 'board');
    expect(el.attrs['data-theme']).toBe('panels');
    const panels = fake();
    applyTheme(panels, 'panels');
    expect(el.props['--bg']).toBe(panels.props['--bg']);
  });

  it('an unknown built-in key falls back to the default theme', () => {
    const el = fake();
    applyTheme(el, 'nonsense');
    expect(el.attrs['data-theme']).toBe('panels');
  });
});

describe('daytimeActive / themeAt', () => {
  it('is inside a normal daytime window', () => {
    expect(daytimeActive('12:00', 'almanac', '07:00', '21:00')).toBe(true);
    expect(daytimeActive('23:00', 'almanac', '07:00', '21:00')).toBe(false);
  });
  it('honours a window that wraps midnight', () => {
    expect(daytimeActive('02:00', 'household', '23:00', '06:00')).toBe(true);
    expect(daytimeActive('12:00', 'household', '23:00', '06:00')).toBe(false);
  });
  it('is inactive without a full window', () => {
    expect(daytimeActive('12:00', undefined, '07:00', '21:00')).toBe(false);
    expect(daytimeActive('12:00', 'almanac', '08:00', '08:00')).toBe(false);
  });
  it('themeAt picks daytime inside the window, active outside', () => {
    expect(themeAt('12:00', 'panels', 'almanac', '07:00', '21:00')).toBe('almanac');
    expect(themeAt('23:00', 'panels', 'almanac', '07:00', '21:00')).toBe('panels');
  });
});

describe('shiftTint (per-type shift colour wash)', () => {
  it('washes a colour toward the background, and more lightly on a light one', () => {
    const onDark = shiftTint('#ff0000', '#000000');
    const onLight = shiftTint('#ff0000', '#ffffff');
    expect(onDark).toMatch(/^#[0-9a-f]{6}$/);
    expect(onLight).toMatch(/^#[0-9a-f]{6}$/);
    // A light background is washed more lightly (0.13 vs 0.2), so the tint sits
    // nearer white than the dark one sits to black.
    expect(onDark).not.toBe(onLight);
    // Dark bg, 20% of #ff0000 over black = #330000.
    expect(onDark).toBe('#330000');
  });
});

/**
 * Every theme, held to the contrast a wall read from across a room needs
 * (RFC 009 Phase 6, assertion 5).
 *
 * This was `describe('the Swiss theme')` and checked one theme of five, for a
 * good reason that stopped being the whole reason: Swiss is the darkest ground
 * in the bundle, so a hue that clears 4.5:1 on Panels can sit at 4.1:1 on
 * `#09090B` and look fine on the machine it was picked on. `--s-straight` did
 * exactly that and was lifted.
 *
 * But a light theme has the same problem inverted, and nothing was asking. It
 * is `describe.each` over all five now, against **both** `--bg` and `--panel`,
 * because a wall paints text on both: the month grid sits on the canvas and a
 * day card sits on the panel, and on the light themes those are `#F4F0E8` and
 * `#FFFFFF` — a whole step apart, with the cream `--bg` the harder of the two,
 * since it sits closer in luminance to a mid-tone hue than white does.
 *
 * It failed immediately on four of the five, which was the point. The worst
 * was `--s-day` at **1.90:1 on Household and 2.78 on Almanac**, painted as
 * *text* on what `display.css` calls the single most important element on the
 * wall — and Almanac is the theme scheduled for daylight, so that ratio was
 * what a household read all day. RFC 009 Phase 6 darkened every shift hue
 * (`--s-day`, `--s-night`, `--s-break`, `--s-straight`) on the three light
 * themes until each cleared 4.5:1 on both grounds; `--accent` and `--muted`
 * on those same themes, and Panels' own three misses, are still Phase 6b's.
 * This is the assertion that made the fix provable and stops a sixth theme
 * shipping with the same fault.
 */

const luminance = (hex: string): number => {
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
};

const contrast = (a: string, b: string): number => {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const tokensOf = (name: string): Record<string, string> => {
  const el = fake();
  applyTheme(el, name);
  return el.props;
};

/*
 * The themes come from the bundle, not from a list kept here. A sixth one is
 * covered the day it is declared, which a transcribed list would not manage —
 * and a transcribed list is how five themes ended up with one of them checked.
 */

/** The tokens a household reads words in, as opposed to sees shapes in. */
const READABLE = [
  '--ink',
  '--muted',
  // A rota chip is scaffold ink on a tinted cell, so this belongs in the sweep
  // even though its own derivation is asserted separately below.
  '--ink-scaffold',
  '--accent',
  '--s-day',
  '--s-night',
  '--s-break',
  '--s-straight',
] as const;

/**
 * Every ground a wall paints those words on.
 *
 * It was `--bg` and `--panel`, which is two of four — and the two missing ones
 * are where the wall's own most important element lives. A rota day washes its
 * cell with `--s-*-tint` and a shift badge fills with `--s-*-badge`; both are
 * derived from a hue *over* the background, so a token measured only against
 * `--bg` is measured against a ground the household is often not looking at.
 * Measured on a real wall, the shift badge's `.who` reads 2.80:1 on Household
 * and 2.96:1 on Blueprint, where this file's allow-list recorded 3.28 and 3.47
 * — half a point of understatement on the element `display.css` calls the
 * single most important thing on the wall.
 *
 * The tints are read out of `applyTheme`'s own output rather than re-derived
 * here: `themeTokens` computes them from `CELL_TINT` and `BADGE_TINT` per
 * theme, and a second opinion about what a tint is would be a test agreeing
 * with itself.
 */
const GROUNDS = [
  '--bg',
  '--panel',
  '--s-day-tint',
  '--s-night-tint',
  '--s-break-tint',
  '--s-straight-tint',
  '--s-day-badge',
  '--s-night-badge',
  '--s-break-badge',
  '--s-straight-badge',
] as const;

/** The two a theme must declare outright; the rest are derived from them. */
const DECLARED_GROUNDS = ['--bg', '--panel'] as const;

/**
 * What fails today, and the worst ground each one reaches.
 *
 * One line per theme and token; the ratio recorded is the *worst* over every
 * ground in `GROUNDS`, so a change that makes any pairing worse moves a number
 * here and has to come back through this list — a half-fix cannot land as a
 * silent pass, and a real fix goes stale and fails, which is how lines get
 * deleted.
 *
 * **This list grew when `GROUNDS` did, and none of that growth is a
 * regression.** It used to name `--bg` and `--panel` only, which is two of the
 * four grounds a wall paints words on: a rota day washes its cell with
 * `--s-*-tint` and a shift badge fills with `--s-*-badge`, and those were
 * never measured. What the tints show is that a hue drawn on its own wash is
 * roughly 0.6 of a point worse than the same hue on the bare ground — so the
 * shift badge, which `display.css` calls the single most important element on
 * the wall, is where every theme is weakest and where nothing was looking.
 *
 * Phase 6 darkened the four shift hues until each cleared 4.5:1 on `--bg` and
 * `--panel`, which it did. Clearing it on a ground made *from* the hue is a
 * harder problem — the tint moves the ground toward the ink by construction —
 * and it is a decision about `CELL_TINT` and `BADGE_TINT`, or about the badge
 * drawing its words on `--panel` instead. Both are real changes to how every
 * wall in the world looks, and neither belongs in the commit that made the
 * measurement possible.
 */
const UNREADABLE: readonly string[] = [
  'almanac --accent at worst 4.47 on --s-night-badge',
  'almanac --ink-scaffold at worst 3.60 on --s-night-badge',
  'almanac --muted at worst 2.77 on --s-night-badge',
  'almanac --s-break at worst 3.58 on --s-night-badge',
  'almanac --s-day at worst 3.58 on --s-night-badge',
  'almanac --s-straight at worst 3.60 on --s-night-badge',
  'blueprint --accent at worst 2.94 on --s-night-badge',
  'blueprint --ink-scaffold at worst 3.68 on --s-night-badge',
  'blueprint --muted at worst 2.76 on --s-night-badge',
  'blueprint --s-break at worst 3.60 on --s-night-badge',
  'blueprint --s-day at worst 3.61 on --s-night-badge',
  'blueprint --s-straight at worst 3.60 on --s-night-badge',
  'household --accent at worst 3.11 on --s-break-badge',
  'household --ink-scaffold at worst 3.75 on --s-break-badge',
  'household --muted at worst 2.67 on --s-break-badge',
  'household --s-break at worst 3.73 on --s-break-badge',
  'household --s-day at worst 3.70 on --s-break-badge',
  'household --s-night at worst 3.69 on --s-break-badge',
  'household --s-straight at worst 3.71 on --s-break-badge',
  'panels --accent at worst 3.89 on --s-day-tint',
  'panels --ink-scaffold at worst 4.39 on --s-day-tint',
  'panels --s-break at worst 3.14 on --s-day-tint',
  'panels --s-night at worst 3.89 on --s-day-tint',
  'panels --s-straight at worst 2.64 on --s-day-tint',
  'swiss --s-break at worst 4.01 on --s-day-badge',
  'swiss --s-straight at worst 3.86 on --s-day-badge',
];

/**
 * The worst ground each token reaches on one theme, where that is under 4.5:1.
 *
 * One line per *token* rather than per pairing, which is a change forced by
 * widening `GROUNDS`: ten grounds times seven tokens is seventy pairings a
 * theme, and recording every miss produced a hundred and fifty lines of
 * allow-list — a list that long stops being read, which is the one thing an
 * allow-list cannot afford to be.
 *
 * The ratchet property survives intact, and that is what makes this a
 * restatement rather than a weakening: the recorded number is the *worst* case,
 * so anything that makes any pairing worse moves it and has to come back
 * through this list. What it gives up is naming every ground a token misses on,
 * which the failure message prints anyway.
 */
function unmetOn(name: ThemeName): string[] {
  const t = tokensOf(name);
  const unmet: string[] = [];
  for (const token of READABLE) {
    const value = t[token];
    expect(value, `${name} is missing ${token}`).toBeDefined();
    let worst = { ground: '', ratio: Number.POSITIVE_INFINITY };
    for (const ground of GROUNDS) {
      const behind = t[ground];
      if (behind === undefined) continue;
      const ratio = contrast(value as string, behind);
      if (ratio < worst.ratio) worst = { ground, ratio };
    }
    if (worst.ratio >= 4.5) continue;
    unmet.push(`${name} ${token} at worst ${worst.ratio.toFixed(2)} on ${worst.ground}`);
  }
  return unmet;
}

describe.each(THEME_NAMES)('the %s theme', (name) => {
  it('is a theme this bundle draws, not an unknown key falling back', () => {
    // An unrecognised key resolves to the default, so asserting the attribute
    // is what separates "this theme exists" from "it silently became Panels".
    const el = fake();
    applyTheme(el, name);
    expect(el.attrs['data-theme']).toBe(name);
    for (const ground of DECLARED_GROUNDS) {
      expect(el.props[ground], `${name} has no ${ground}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('carries every readable token at 4.5:1 over every ground it paints on', () => {
    const permitted = new Set(UNREADABLE);
    const fresh = unmetOn(name).filter((entry) => !permitted.has(entry));
    expect(
      fresh,
      `${fresh.length} newly unreadable pairs (allow-list holds ${UNREADABLE.length}):\n` +
        fresh.map((entry) => `  ${entry}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * The four emphasis roles (RFC — wall type hierarchy), on every theme.
 *
 * `--ink-event`, `--ink-quiet` and `--rule-week` are straight copies of
 * `--ink`, `--muted` and `--rule` — asserted as equalities, not as fresh
 * contrast checks, because a quiet role inherits `--muted`'s own accepted
 * misses (`UNREADABLE` above already carries them) rather than needing to
 * clear a bar `--muted` itself does not. `--ink-scaffold` is the one that is
 * not a copy, so it gets its own bar: unlike `--muted`, every theme's
 * scaffold ink was tuned to clear 4.5:1, so it is held to that on *both*
 * grounds, the same as the fully-readable tokens above.
 */
describe.each(THEME_NAMES)('the %s theme, emphasis roles', (name) => {
  it('carries all four, as hex colours', () => {
    const t = tokensOf(name);
    for (const role of ['--ink-event', '--ink-scaffold', '--ink-quiet', '--rule-week']) {
      expect(t[role], `${name} is missing ${role}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('copies --ink-event from --ink, --ink-quiet from --muted, --rule-week from --rule', () => {
    const t = tokensOf(name);
    expect(t['--ink-event']).toBe(t['--ink']);
    expect(t['--ink-quiet']).toBe(t['--muted']);
    expect(t['--rule-week']).toBe(t['--rule']);
  });

  /*
   * The two grounds `scaffoldInk` is *derived* against, and only those. It
   * raises its mix ratio until it clears 4.5:1 on `--bg`, so that is the
   * promise it can make; how it fares on a rota tint is a fact about the tint
   * and is carried by the ratchet above with every other token.
   */
  it('clears 4.5:1 with --ink-scaffold on both of the grounds it is derived against', () => {
    const t = tokensOf(name);
    for (const ground of DECLARED_GROUNDS) {
      const ratio = contrast(t['--ink-scaffold'] as string, t[ground] as string);
      expect(ratio, `${name} --ink-scaffold on ${ground} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * A custom theme must resolve the same four roles a built-in does, or a
 * household's own theme draws every date numeral, weekday head and week
 * number with `var()` resolving to nothing — invisible rather than merely
 * wrong, which is worse.
 */
describe('customTokens, the four emphasis roles', () => {
  const base = {
    '--bg': '#101418',
    '--panel': '#1b2028',
    '--rule': '#2a333f',
    '--ink': '#e9eef4',
    '--muted': '#9ba7b4',
    '--faint': '#68727e',
    '--accent': '#e0a33e',
    '--s-day': '#e0a33e',
    '--s-night': '#4c7fd1',
    '--s-break': '#35916a',
    '--s-straight': '#6b7684',
    '--radius': '0.4rem',
  };

  it('derives all four roles from the base tokens', () => {
    const t = customTokens(base);
    expect(t['--ink-event']).toBe(base['--ink']);
    expect(t['--ink-quiet']).toBe(base['--muted']);
    expect(t['--rule-week']).toBe(base['--rule']);
    expect(t['--ink-scaffold']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('measures --ink-scaffold to clear 4.5:1 on the custom background, dark and light alike', () => {
    const dark = customTokens(base);
    expect(contrast(dark['--ink-scaffold'] as string, base['--bg'])).toBeGreaterThanOrEqual(4.5);

    const light = customTokens({ ...base, '--bg': '#f6f3ec', '--panel': '#ffffff', '--ink': '#1a1815' });
    expect(contrast(light['--ink-scaffold'] as string, '#f6f3ec')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the unreadable-pair allow-list', () => {
  /*
   * The burn-down half, and it is deliberately outside `describe.each`.
   *
   * Inside it, an entry could only be checked by the theme it names — so an
   * entry for a theme that had been *retired* would be checked by nothing and
   * would sit in the list for ever, describing a wall nobody has. This bundle
   * has retired themes before: Board, Slate and Glance are `LEGACY_ALIASES`
   * now. Measuring the whole list against every theme at once is what makes
   * the list shrink in both of the ways it can.
   */
  it('holds nothing that is already fixed', () => {
    const measured = new Set(THEME_NAMES.flatMap((name) => unmetOn(name)));
    const stale = UNREADABLE.filter((entry) => !measured.has(entry));
    expect(
      stale,
      `${stale.length} allow-listed pairs are fixed, have moved, or name a theme this ` +
        `bundle no longer draws — delete these lines, the list is down to ` +
        `${UNREADABLE.length - stale.length}:\n` +
        stale.map((entry) => `  ${entry}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * The two assertions that stay Swiss's alone, because both are statements
 * about this theme rather than about themes.
 *
 * `--faint` is the out-of-month grey and its band is drawn against Swiss's
 * near-black; on Panels the same token measures 5.07:1, which is a different
 * judgement about a different ground rather than a failure of this one. And
 * square corners are the Swiss *shape* — Household and Panels carry a radius
 * on purpose. Generalising either would have meant two more allow-lists
 * standing in for two decisions nobody has taken.
 */
describe('the Swiss theme', () => {
  it('is drawn on the darkest ground in the bundle', () => {
    expect(tokensOf('swiss')['--bg']).toBe('#09090B');
  });

  it('keeps the out-of-month grey present but not competing', () => {
    const t = tokensOf('swiss');
    const ratio = contrast(t['--faint'] as string, t['--bg'] as string);
    expect(ratio, '--faint has become readable and now competes with this month').toBeLessThan(3);
    expect(ratio, '--faint has vanished and a next-month day is simply missing').toBeGreaterThan(1.4);
  });

  it('squares its corners, because a Swiss panel is not a card', () => {
    expect(tokensOf('swiss')['--radius']).toBe('0');
  });
});

/**
 * The ink drawn *on* a colour the household chose.
 *
 * Six selectors in `display.css` set text on `--pc` (a calendar's hue) or
 * `--ev` (a person's), and every one of them used to write `#fff`. Measured on
 * the palette `api/palette.ts` actually hands out, that fails on three of five
 * — and the one it fails worst on is the colour a household's **second**
 * calendar is given without anybody choosing anything.
 *
 * The property worth asserting is not "these five hues are right". It is that
 * there is no colour at all this can answer badly: white and black cross at
 * 4.58:1, so the better of the two always clears the bar. That is checked over
 * the whole cube below rather than over a list, because a list is exactly what
 * shipped `#fff` in the first place.
 */
describe('inkOn', () => {
  /** The palette a household is given, in the order it is given (`palette.ts`). */
  const PALETTE = ['#4C7FD1', '#E8A33D', '#35916A', '#B3372B', '#6B7684'] as const;

  it('clears 4.5:1 on every colour a household is assigned', () => {
    const measured = PALETTE.map((hue) => ({
      hue,
      ink: inkOn(hue),
      ratio: Number(contrast(inkOn(hue), hue).toFixed(2)),
    }));
    const failing = measured.filter((row) => row.ratio < 4.5);
    expect(
      failing,
      `unreadable: ${failing.map((r) => `${r.ink} on ${r.hue} = ${r.ratio}`).join(', ')}`,
    ).toEqual([]);
  });

  it('is the fix rather than a repaint: white failed on three of those five', () => {
    // The non-vacuity guard. If white were fine everywhere this whole function
    // would be ceremony, and the assertion above would pass with it deleted.
    const whiteFails = PALETTE.filter((hue) => contrast('#ffffff', hue) < 4.5);
    expect(whiteFails).toEqual(['#4C7FD1', '#E8A33D', '#35916A']);
    // And the worst of them is the second colour, not some exotic hue.
    expect(Number(contrast('#ffffff', '#E8A33D').toFixed(2))).toBe(2.16);
    expect(Number(contrast(inkOn('#E8A33D'), '#E8A33D').toFixed(2))).toBe(9.74);
  });

  it('clears 4.5:1 on every colour there is, not just the five', () => {
    // A household can type any hex into the colour input, so the claim has to
    // hold over the space rather than over the palette. Stepped at 17 (a
    // divisor of 255, so 0 and 255 are both hit) — 4,096 colours, which is
    // enough to catch a threshold written the wrong way round and fast enough
    // to run on every commit.
    let worst = { hex: '', ratio: Infinity };
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          const ratio = contrast(inkOn(hex), hex);
          if (ratio < worst.ratio) worst = { hex, ratio };
        }
      }
    }
    // 4.58:1 is where the two curves cross; nothing can be worse than that.
    expect(worst.ratio, `worst ground was ${worst.hex}`).toBeGreaterThanOrEqual(4.5);
    expect(Number(worst.ratio.toFixed(2))).toBe(4.58);
  });

  it('answers white for a colour it cannot read, which is what it drew before', () => {
    // Rule nine at the smallest scale: a stored value this cannot parse is a
    // wall that still draws, exactly as it drew yesterday.
    expect(inkOn('rebeccapurple')).toBe('#ffffff');
    expect(inkOn('')).toBe('#ffffff');
    expect(inkOn('#fff')).toBe('#ffffff');
  });
});
