import { describe, expect, it } from 'vitest';
import { backgroundSchema } from '../src/api/widget-schema.js';
import { parseBackground } from '../src/api/manifest.js';
import { WALLPAPERS } from '../src/wallpapers.js';
import { withTints, themeTokensSchema } from '../src/api/themes.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';

/**
 * A picture toned down towards the canvas's ground (plan item M4.7), and the
 * theme's text shadow for words straight on one (plan item M4.8), as stored
 * and as sent. `browser-picture-wash.test.ts` draws both on a real wall.
 */

describe('a picture’s wash, as stored', () => {
  it('is taken on an uploaded image, a wallpaper and a rotation', () => {
    const image = 'a'.repeat(64) + '.jpg';
    expect(backgroundSchema.safeParse({ type: 'image', image, wash: 'light' }).success).toBe(true);
    expect(backgroundSchema.safeParse({ type: 'wallpaper', id: 'dusk', wash: 'strong' }).success).toBe(true);
    expect(
      backgroundSchema.safeParse({ type: 'rotation', collection: 'all', tone: 'dark', every: 60, wash: 'strong' }).success,
    ).toBe(true);
  });

  it('is refused on a colour or a gradient, and refused rather than coerced when it is not one of the two', () => {
    expect(backgroundSchema.safeParse({ type: 'solid', color: '#112233', wash: 'light' }).success).toBe(false);
    expect(backgroundSchema.safeParse({ type: 'gradient', from: '#000000', to: '#ffffff', wash: 'light' }).success).toBe(false);
    expect(backgroundSchema.safeParse({ type: 'wallpaper', id: 'dusk', wash: 'heavy' }).success).toBe(false);
    expect(backgroundSchema.safeParse({ type: 'wallpaper', id: 'dusk', wash: '' }).success).toBe(false);
  });
});

describe('a picture’s wash, as sent', () => {
  it('leaves an unwashed wallpaper’s document exactly as it was: no wash and no bare patches', () => {
    for (const one of WALLPAPERS) {
      const sent = parseBackground(JSON.stringify({ type: 'wallpaper', id: one.id }));
      expect(sent, one.id).toBeDefined();
      expect(Object.keys(sent!), one.id).not.toContain('wash');
      expect(Object.keys(sent!), one.id).not.toContain('bare');
    }
  });

  it('sends a washed wallpaper its wash and its unblurred patches, for every picture in the set', () => {
    for (const one of WALLPAPERS) {
      const sent = parseBackground(JSON.stringify({ type: 'wallpaper', id: one.id, wash: 'strong' })) as {
        wash?: string;
        bare?: { light: string; dark: string };
      };
      expect(sent.wash, one.id).toBe('strong');
      expect(sent.bare?.light, one.id).toMatch(/^#[0-9A-F]{6}$/);
      expect(sent.bare?.dark, one.id).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('sends a washed rotation its wash once and every picture its patches', () => {
    const sent = parseBackground(JSON.stringify({ type: 'rotation', collection: 'all', tone: 'dark', every: 60, wash: 'light' })) as {
      wash?: string;
      pictures: readonly { bare?: unknown }[];
    };
    expect(sent.wash).toBe('light');
    expect(sent.pictures.length).toBeGreaterThan(2);
    for (const picture of sent.pictures) expect(picture.bare).toBeDefined();
    const plain = parseBackground(JSON.stringify({ type: 'rotation', collection: 'all', tone: 'dark', every: 60 })) as {
      pictures: readonly Record<string, unknown>[];
    };
    expect(Object.keys(plain)).not.toContain('wash');
    for (const picture of plain.pictures) expect(Object.keys(picture)).not.toContain('bare');
  });

  it('carries an image’s wash, and drops a stored value it does not know', () => {
    const image = 'b'.repeat(64) + '.png';
    expect(parseBackground(JSON.stringify({ type: 'image', image, wash: 'light' }))).toEqual({ type: 'image', image, wash: 'light' });
    expect(parseBackground(JSON.stringify({ type: 'image', image, wash: 'heavy' }))).toEqual({ type: 'image', image });
    expect(parseBackground(JSON.stringify({ type: 'wallpaper', id: 'dusk', wash: 'heavy' }))).not.toHaveProperty('wash');
  });
});

describe('the theme’s text shadow', () => {
  it('is a halo of the theme’s own card colour on every built-in', () => {
    for (const [name, tokens] of Object.entries(BUILTIN_THEME_TOKENS)) {
      const derived = withTints(tokens as never);
      const panel = (tokens as Record<string, string>)['--panel'] ?? '';
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(panel.slice(i, i + 2), 16));
      expect(derived['--shadow-text'], name).toBe(
        `0 0 0.1em rgba(${r}, ${g}, ${b}, 0.9), 0 0 0.4em rgba(${r}, ${g}, ${b}, 0.7)`,
      );
    }
  });

  it('is none when a theme asks for none, and nothing else can be stored', () => {
    // A whole custom theme: the built-in's colours and a corner.
    const base = { ...(BUILTIN_THEME_TOKENS as Record<string, Record<string, string>>)['panels'], '--radius': '0.4rem' };
    expect(themeTokensSchema.safeParse(base).success).toBe(true);
    expect(withTints({ ...base, '--shadow-text': 'none' } as never)['--shadow-text']).toBe('none');
    expect(themeTokensSchema.safeParse({ ...base, '--shadow-text': 'none' }).success).toBe(true);
    expect(themeTokensSchema.safeParse({ ...base, '--shadow-text': '0 0 4px red' }).success).toBe(false);
  });
});
