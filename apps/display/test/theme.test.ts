import { describe, expect, it } from 'vitest';
import { applyTheme, daytimeActive, shiftTint, themeAt, type Themeable } from '../src/theme.js';

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
 * The Swiss theme, held to the contrast a wall read from across a room needs.
 *
 * This one is checked rather than eyeballed because it is the darkest ground in
 * the bundle: a hue that clears 4.5:1 on Panels can sit at 4.1:1 on #09090B and
 * look fine on the machine it was picked on. `--s-straight` did exactly that
 * and was lifted; without an assertion here the next hue added would repeat it.
 *
 * `--faint` is the deliberate exception and is asserted from *both* sides: it
 * must stay dim enough that a day belonging to the next month does not compete
 * with this one, and present enough that the day is not simply missing.
 */
describe('the Swiss theme', () => {
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

  it('is a theme this bundle draws, not an unknown key falling back', () => {
    const el = fake();
    applyTheme(el, 'swiss');
    // An unrecognised key resolves to the default, so asserting the attribute
    // is what separates "Swiss exists" from "Swiss silently became Panels".
    expect(el.attrs['data-theme']).toBe('swiss');
    expect(el.props['--bg']).toBe('#09090B');
  });

  it('carries every readable token at 4.5:1 over its own canvas', () => {
    const t = tokensOf('swiss');
    const bg = t['--bg'] as string;
    for (const token of ['--ink', '--muted', '--accent', '--s-day', '--s-night', '--s-break', '--s-straight']) {
      const value = t[token];
      expect(value, `swiss is missing ${token}`).toBeDefined();
      expect(contrast(value as string, bg), `${token} over the canvas`).toBeGreaterThanOrEqual(4.5);
    }
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
