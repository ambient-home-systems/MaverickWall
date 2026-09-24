import { describe, expect, it } from 'vitest';
import { applyTheme, customTokens, THEME_NAMES, themeTokens, type Themeable } from '../src/theme.js';

/**
 * The designed styles' palette and the card shadow (decisions D1–D8, plan
 * items P4.4 and P4.5).
 *
 * Every token here is new and nothing in `display.css` reads any of them yet
 * except `--shadow-card`, which only a widget that asks for a drop shadow
 * reads — so what is under test is the *promise* each one carries to the
 * styles that will: that a colour painting a word or a glyph can be read on
 * the ground it sits on, on every built-in and on any theme a household
 * builds, and that a shadow is the theme's to switch off.
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

/** WCAG contrast, spelled again here so the assertion is a second opinion. */
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

/** The tokens that paint a word or a glyph, and so must clear 4.5:1. */
const READABLE = [
  '--wx-sun',
  '--wx-cloud',
  '--wx-rain',
  '--wx-snow',
  '--wx-storm',
  '--wx-fog',
  '--temp-cold',
  '--temp-cool',
  '--temp-warm',
  '--temp-hot',
  '--state-active',
  '--state-alert',
  '--state-idle',
] as const;

const SKIES = ['day', 'night', 'cloud', 'rain', 'snow', 'storm'] as const;

/** Every readable token against both grounds, and every sky's ink on both its stops. */
function misses(t: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const token of READABLE) {
    const value = t[token];
    if (value === undefined) {
      out.push(`${token} missing`);
      continue;
    }
    for (const ground of ['--bg', '--panel'] as const) {
      const ratio = contrast(value, t[ground]!);
      if (ratio < 4.5) out.push(`${token} ${value} on ${ground} ${t[ground]} = ${ratio.toFixed(2)}`);
    }
  }
  for (const sky of SKIES) {
    const ink = t[`--sky-${sky}-ink`];
    for (const stop of ['top', 'bottom'] as const) {
      const ground = t[`--sky-${sky}-${stop}`];
      if (ink === undefined || ground === undefined) {
        out.push(`--sky-${sky}-${stop} or its ink missing`);
        continue;
      }
      const ratio = contrast(ink, ground);
      if (ratio < 4.5) out.push(`--sky-${sky}-ink ${ink} on ${stop} ${ground} = ${ratio.toFixed(2)}`);
    }
  }
  return out;
}

describe.each(THEME_NAMES)('the %s theme, designed-style palette', (name) => {
  it('carries every token, and every one that paints a word clears 4.5:1 on both grounds', () => {
    const el = fake();
    applyTheme(el, name);
    expect(misses(el.props)).toEqual([]);
    expect(el.props['--shadow-card'], `${name} has no --shadow-card`).toBeDefined();
  });

  it('draws the same palette a custom theme with its colours would', () => {
    // A household who copies a built-in's colours into the builder gets that
    // built-in's rain and skies — one derivation, not a built-in's opinion
    // and a custom theme's. The shadow is the one token a built-in declares
    // outright, so it is left out of the comparison and asserted below.
    const built = themeTokens(name);
    const custom = customTokens(built);
    for (const token of [...READABLE, ...SKIES.flatMap((s) => [`--sky-${s}-top`, `--sky-${s}-bottom`, `--sky-${s}-ink`])]) {
      expect(built[token], token).toBe(custom[token]);
    }
  });
});

describe('the card shadow on the five built-ins', () => {
  const shadow = (name: string): string | undefined => themeTokens(name)['--shadow-card'];

  it('is none on Blueprint and Swiss, and a blurred soft one on Panels and Household', () => {
    expect(shadow('blueprint')).toBe('none');
    expect(shadow('swiss')).toBe('none');
    for (const soft of ['panels', 'household']) expect(shadow(soft)).toMatch(/^0 [0-9.]+rem (?!0 )[0-9.]+rem rgba\(/);
  });

  it('is paper-like on Almanac: offset, and no blur', () => {
    expect(shadow('almanac')).toMatch(/^[0-9.]+rem [0-9.]+rem 0 rgba\(/);
    expect(shadow('almanac')).not.toBe(shadow('household'));
  });

  it('is declared by the theme rather than derived: Blueprint would derive a soft one', () => {
    // The non-vacuity guard for the pair above. Blueprint's colours on their
    // own derive the soft default, so "Blueprint draws none" can only be true
    // because the block says so and the block wins over the derivation.
    const colours: Record<string, string> = { ...themeTokens('blueprint') };
    delete colours['--shadow-card'];
    expect(customTokens(colours)['--shadow-card']).not.toBe('none');
  });

  it('resolves a retired key to its alias’s shadow', () => {
    expect(shadow('board')).toBe(shadow('panels'));
  });

  it('is never a literal length in px, because a shadow scales with the wall', () => {
    for (const name of THEME_NAMES) expect(shadow(name)).not.toMatch(/px/);
  });
});

describe('customTokens, the designed-style palette', () => {
  const DARK = {
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
  };
  const LIGHT = { ...DARK, '--bg': '#f6f3ec', '--panel': '#ffffff', '--ink': '#1a1815', '--muted': '#8a8474' };

  it('clears every bar on a dark theme and on a light one', () => {
    expect(misses(customTokens(DARK))).toEqual([]);
    expect(misses(customTokens(LIGHT))).toEqual([]);
  });

  it('keeps each colour a colour: a light ground pushes a hue toward the ink, not to it', () => {
    // The loop is there to make the hue legible, not to replace it with the
    // text colour; on a light ground the sun must still not *be* the ink.
    const light = customTokens(LIGHT);
    for (const token of READABLE) expect(light[token], token).not.toBe(LIGHT['--ink']);
    // And on a dark ground the canonical hues already clear, so they pass
    // through untouched — which is what makes the push measured, not blanket.
    expect(customTokens(DARK)['--wx-rain']).toBe('#4C8FE0');
  });

  it('clears the bar on any ground where the theme’s own ink does', () => {
    // A household can type any pair. Swept over a grid of grounds with a
    // readable ink chosen for each: the claim is that nothing the derivation
    // produces is *less* legible than the ink it was given to lean on.
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const bg = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          const ink = contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
          if (contrast(ink, bg) < 4.5) continue;
          const t = customTokens({ ...DARK, '--bg': bg, '--panel': bg, '--ink': ink, '--muted': '#808080' });
          expect(misses(t), `on ${bg}`).toEqual([]);
        }
      }
    }
  });

  it('terminates with a colour on a pair nothing could make legible', () => {
    const t = customTokens({ ...DARK, '--bg': '#202020', '--panel': '#202020', '--ink': '#212121' });
    for (const token of READABLE) expect(t[token], token).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('derives a soft shadow by default, dark on a dark ground and in the ink on a light one', () => {
    expect(customTokens(DARK)['--shadow-card']).toBe('0 0.15rem 0.6rem rgba(0, 0, 0, 0.45)');
    // #1a1815 is 26, 24, 21.
    expect(customTokens(LIGHT)['--shadow-card']).toBe('0 0.1rem 0.5rem rgba(26, 24, 21, 0.14)');
  });

  it('draws none when the theme stored none, and never grows one back', () => {
    expect(customTokens({ ...DARK, '--shadow-card': 'none' })['--shadow-card']).toBe('none');
    expect(customTokens({ ...LIGHT, '--shadow-card': 'none' })['--shadow-card']).toBe('none');
  });
});

describe('applyTheme on a wall sized as an e-ink panel', () => {
  it('sets --shadow-card to none over a theme that casts one, built-in or custom', () => {
    const plain = fake();
    applyTheme(plain, 'panels');
    expect(plain.props['--shadow-card']).not.toBe('none');

    const eink = fake();
    applyTheme(eink, 'panels', undefined, undefined, true);
    expect(eink.props['--shadow-card']).toBe('none');
    // Only the shadow: every other token is the theme's own.
    expect({ ...eink.props, '--shadow-card': '' }).toEqual({ ...plain.props, '--shadow-card': '' });

    const custom = fake();
    applyTheme(custom, 'custom:x', customTokens({ '--bg': '#000000', '--ink': '#ffffff' }), 'board', true);
    expect(custom.props['--shadow-card']).toBe('none');
  });

  it('leaves the theme’s shadow alone when the wall is not one', () => {
    const el = fake();
    applyTheme(el, 'household', undefined, undefined, false);
    expect(el.props['--shadow-card']).toBe(themeTokens('household')['--shadow-card']);
  });
});
