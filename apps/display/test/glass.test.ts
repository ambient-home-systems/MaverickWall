import { describe, expect, it } from 'vitest';
import { GLASS_FILL_ALPHA, applyTheme, glassTokens, themeTokens } from '../src/theme.js';

/**
 * Glass, the prototype widget ground (plan item M4.1): its fill and edge, from
 * the theme's card colour. The fill written with the theme is the one a canvas
 * starts from before it has solved its own (plan item M4.2): Soft's opacity.
 */

describe('glassTokens', () => {
  it('is the card colour at Soft’s opacity until a canvas solves its own, pre-mixed, with an edge that reads on its ground', () => {
    expect(GLASS_FILL_ALPHA).toBe(0.86);
    expect(glassTokens('#1B212A')).toEqual({ '--glass-fill': 'rgba(27, 33, 42, 0.86)', '--glass-edge': 'rgba(255, 255, 255, 0.1)' });
    expect(glassTokens('#FFFDF8')).toEqual({ '--glass-fill': 'rgba(255, 253, 248, 0.86)', '--glass-edge': 'rgba(0, 0, 0, 0.08)' });
    // A card colour this cannot read is no glass at all: the stylesheet's own fallback then.
    expect(glassTokens('var(--x)')).toEqual({});
    expect(glassTokens(undefined)).toEqual({});
  });

  it('is written with every theme, built in or the household’s own', () => {
    const written = (tokens?: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {};
      applyTheme({ style: { setProperty: (name, value) => (out[name] = value) }, setAttribute: () => undefined }, 'panels', tokens);
      return out;
    };
    const panel = themeTokens('panels')['--panel'] ?? '';
    expect(written()['--glass-fill']).toBe(glassTokens(panel)['--glass-fill']);
    expect(written({ '--panel': '#102030', '--bg': '#000000' })['--glass-fill']).toBe('rgba(16, 32, 48, 0.86)');
  });
});
