import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  daytimeActive,
  shiftTint,
  THEME_NAMES,
  themeAt,
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
 * `#FFFFFF` — a whole step apart, with the panel the harder of the two.
 *
 * It fails immediately on four of the five, which is the point. The worst is
 * `--s-day` at **1.90:1 on Household and 2.78 on Almanac**, painted as *text*
 * on what `display.css` calls the single most important element on the wall —
 * and Almanac is the theme scheduled for daylight, so that ratio is what a
 * household reads all day. Fixing them is RFC 009 Phase 6b; this is the
 * assertion that makes the fix provable and stops a sixth theme shipping with
 * the same fault.
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
  '--accent',
  '--s-day',
  '--s-night',
  '--s-break',
  '--s-straight',
] as const;

/** Both grounds a wall paints those words on. */
const GROUNDS = ['--bg', '--panel'] as const;

/**
 * What fails today, with the ratio each one actually measures.
 *
 * Four of five themes are in here and the shape of the list is the finding:
 * **the three light themes fail almost everywhere and the dark ones barely at
 * all.** Household and Blueprint miss on ten of fourteen pairs each; Almanac,
 * the theme scheduled for daylight, on eight; Panels on three; Swiss on none,
 * because Swiss is the only one anything was ever checking.
 *
 * The ratios are recorded rather than just the pairs. A change to a hue that
 * moves a number without clearing the bar has to come back through this list,
 * so a half-fix cannot land as a silent pass — and when 6b darkens these, the
 * lines it fixes go stale and fail, which is how the list gets deleted.
 */
const UNREADABLE: readonly string[] = [
  'household --accent on --bg = 3.81',
  'household --accent on --panel = 4.33',
  'household --muted on --bg = 3.28',
  'household --muted on --panel = 3.73',
  'household --s-break on --bg = 3.42',
  'household --s-break on --panel = 3.88',
  'household --s-day on --bg = 1.90',
  'household --s-day on --panel = 2.16',
  'household --s-night on --bg = 3.51',
  'household --s-night on --panel = 3.99',
  'household --s-straight on --bg = 4.06',
  'blueprint --accent on --bg = 3.71',
  'blueprint --accent on --panel = 4.15',
  'blueprint --muted on --bg = 3.47',
  'blueprint --muted on --panel = 3.88',
  'blueprint --s-break on --bg = 3.93',
  'blueprint --s-break on --panel = 4.39',
  'blueprint --s-day on --bg = 2.63',
  'blueprint --s-day on --panel = 2.95',
  'blueprint --s-straight on --bg = 3.27',
  'blueprint --s-straight on --panel = 3.66',
  'panels --s-break on --panel = 4.17',
  'panels --s-straight on --bg = 3.86',
  'panels --s-straight on --panel = 3.51',
  'almanac --muted on --bg = 3.51',
  'almanac --muted on --panel = 3.73',
  'almanac --s-break on --bg = 4.14',
  'almanac --s-break on --panel = 4.39',
  'almanac --s-day on --bg = 2.78',
  'almanac --s-day on --panel = 2.95',
  'almanac --s-straight on --bg = 3.45',
  'almanac --s-straight on --panel = 3.66',
];

describe.each(THEME_NAMES)('the %s theme', (name) => {
  it('is a theme this bundle draws, not an unknown key falling back', () => {
    // An unrecognised key resolves to the default, so asserting the attribute
    // is what separates "this theme exists" from "it silently became Panels".
    const el = fake();
    applyTheme(el, name);
    expect(el.attrs['data-theme']).toBe(name);
    for (const ground of GROUNDS) {
      expect(el.props[ground], `${name} has no ${ground}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('carries every readable token at 4.5:1 over both of its grounds', () => {
    const t = tokensOf(name);
    const unmet: string[] = [];
    for (const ground of GROUNDS) {
      for (const token of READABLE) {
        const value = t[token];
        expect(value, `${name} is missing ${token}`).toBeDefined();
        const ratio = contrast(value as string, t[ground] as string);
        if (ratio >= 4.5) continue;
        unmet.push(`${name} ${token} on ${ground} = ${ratio.toFixed(2)}`);
      }
    }

    const permitted = new Set(UNREADABLE);
    const fresh = unmet.filter((entry) => !permitted.has(entry));
    expect(
      fresh,
      `${fresh.length} newly unreadable pairs (allow-list holds ${UNREADABLE.length}):\n` +
        fresh.map((entry) => `  ${entry}`).join('\n'),
    ).toEqual([]);

    const seen = new Set(unmet);
    const stale = UNREADABLE.filter(
      (entry) => entry.startsWith(`${name} `) && !seen.has(entry),
    );
    expect(
      stale,
      `${stale.length} allow-listed pairs on ${name} are fixed or have moved — delete these ` +
        `lines, the list is down to ${UNREADABLE.length - stale.length}:\n` +
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
