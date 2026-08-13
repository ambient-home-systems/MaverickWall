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
