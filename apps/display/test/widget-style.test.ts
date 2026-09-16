import { describe, expect, it } from 'vitest';

import { customTokens, themeTokens } from '../src/theme.js';
import {
  STYLE_DERIVED,
  STYLE_LANE_TOKENS,
  applyStyleTokens,
  resolveStyleTokens,
  setStyleValue,
  styleLayerOf,
  styleTokensOf,
  type Styleable,
} from '../src/widget-style.js';

/**
 * The style lane on the display side (RFC 014 §4.1): the preview's resolver,
 * the manifest's reader and the editor's writer. There is no DOM here, which
 * is the point — every rule below is asked without a browser, and
 * `browser-widget-style.test.ts` in the server tree then asks the glass.
 */

function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1), 16);
    // eslint-disable-next-line no-bitwise
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const ch = (raw: number): number => {
      const c = raw / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(rgb[0]!) + 0.7152 * ch(rgb[1]!) + 0.0722 * ch(rgb[2]!);
  };
  const [la, lb] = [lum(a), lum(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('reading a lane', () => {
  it('keeps the tokens, the enums and a step, and drops everything else', () => {
    expect(styleLayerOf(undefined)).toBeUndefined();
    expect(styleLayerOf(null)).toBeUndefined();
    expect(styleLayerOf({})).toBeUndefined();
    expect(styleLayerOf({ '--accent': 'red' })).toBeUndefined();
    expect(styleLayerOf({ '--accent': '#FF0000', weight: 'heavy', inset: 9, nonsense: 1 })).toEqual({
      '--accent': '#FF0000',
    });
    expect(styleLayerOf({ weight: 'bold', tracking: 'tight', inset: 2 })).toEqual({
      weight: 'bold',
      tracking: 'tight',
      inset: 2,
    });
  });

  it('reads a resolved record off a manifest as strings under known keys only', () => {
    expect(styleTokensOf(undefined)).toBeUndefined();
    expect(styleTokensOf('nonsense')).toBeUndefined();
    expect(styleTokensOf({})).toBeUndefined();
    expect(styleTokensOf({ '--bg': '#FFF8E7', 'font-weight': '700', color: 'red', '--x': 1 })).toEqual({
      '--bg': '#FFF8E7',
      'font-weight': '700',
    });
  });
});

describe('resolving a lane for the preview', () => {
  const PANELS = themeTokens('panels');

  it('emits what the lane set and the derived tokens it feeds, through customTokens', () => {
    expect(resolveStyleTokens(PANELS, [], undefined)).toBeUndefined();
    expect(resolveStyleTokens(PANELS, [], { '--accent': '#FF0000' })).toEqual({ '--accent': '#FF0000' });
    const tokens = resolveStyleTokens(PANELS, [], { '--bg': '#FFF8E7', '--ink': '#2A2A2A' });
    expect(contrast(tokens!['--ink-scaffold']!, '#FFF8E7')).toBeGreaterThanOrEqual(4.5);
    // The bundle's one derivation, not a second: identical to what the theme
    // builder's preview computes over the same effective colours.
    const asTheme = customTokens({ ...PANELS, '--bg': '#FFF8E7', '--ink': '#2A2A2A' });
    expect(tokens!['--ink-scaffold']).toBe(asTheme['--ink-scaffold']);
    for (const entry of STYLE_DERIVED) {
      if (entry.from.includes('--bg') || entry.from.includes('--ink')) expect(tokens).toHaveProperty(entry.token);
      else expect(tokens).not.toHaveProperty(entry.token);
    }
  });

  it('measures against the wall’s default lane beneath a widget', () => {
    const under = resolveStyleTokens(PANELS, [{ '--bg': '#FFF8E7' }], { '--ink': '#2A2A2A' });
    expect(under!['--bg']).toBeUndefined();
    expect(contrast(under!['--ink-scaffold']!, '#FFF8E7')).toBeGreaterThanOrEqual(4.5);
  });

  it('maps the enums, and names inputs the lane can carry', () => {
    expect(resolveStyleTokens(PANELS, [], { weight: 'medium', tracking: 'wide', inset: 0 })).toEqual({
      'font-weight': '500',
      'letter-spacing': 'var(--ls-tight-label)',
      '--fw-inset': '0px',
    });
    for (const entry of STYLE_DERIVED) for (const input of entry.from) expect(STYLE_LANE_TOKENS).toContain(input);
  });
});

describe('applying a lane', () => {
  function element(): Styleable & { readonly set: Map<string, string> } {
    const set = new Map<string, string>();
    const style = {
      background: '',
      setProperty(name: string, value: string): void {
        set.set(name, value);
      },
    };
    return { style, set };
  }

  it('writes every entry as a property, and paints a box that sets its ground', () => {
    const box = element();
    applyStyleTokens(box, { '--bg': '#FFF8E7', '--ink': '#2A2A2A', 'font-weight': '700' }, true);
    expect(box.set.get('--bg')).toBe('#FFF8E7');
    expect(box.set.get('font-weight')).toBe('700');
    expect(box.style.background).toBe('#FFF8E7');
  });

  it('leaves the canvas’s own ground rule alone', () => {
    const canvas = element();
    applyStyleTokens(canvas, { '--bg': '#FFF8E7' }, false);
    expect(canvas.set.get('--bg')).toBe('#FFF8E7');
    expect(canvas.style.background).toBe('');
  });
});

describe('writing a lane from the editor', () => {
  it('writes into style, one level down, and clears the key when it is emptied', () => {
    expect(setStyleValue(undefined, '--accent', '#FF0000')).toEqual({ style: { '--accent': '#FF0000' } });
    expect(setStyleValue({ count: 3 }, 'inset', 2)).toEqual({ count: 3, style: { inset: 2 } });
    expect(setStyleValue({ count: 3, style: { inset: 2, weight: 'bold' } }, 'inset', undefined)).toEqual({
      count: 3,
      style: { weight: 'bold' },
    });
    // The last value out takes `style` with it, and an empty config is none.
    expect(setStyleValue({ count: 3, style: { inset: 2 } }, 'inset', undefined)).toEqual({ count: 3 });
    expect(setStyleValue({ style: { inset: 2 } }, 'inset', '')).toBeUndefined();
  });
});
