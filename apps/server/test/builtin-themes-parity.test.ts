import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BUILTIN_THEME_SHADOWS, BUILTIN_THEME_TOKENS, builtinThemeTokens } from '../src/api/builtin-themes.js';
import { COLOUR_TOKENS } from '../src/api/themes.js';
import { LEGACY_THEME_ALIASES, THEMES } from '../src/http/theme-cards.js';

/**
 * The server's transcription of the five built-in palettes (RFC 014 §4.1),
 * held to the display bundle's `theme.ts` — which is the source — the way
 * `tier-parity` holds a table to its twin. The bundle's palettes are code,
 * one `const NAME: ThemeTokens = { ... }` block each, so this reads every
 * `'--token': '#hex'` pair out of each block and compares it with the
 * server's copy, both ways: a colour changed in the bundle turns this red,
 * and so does a colour the server carries that the bundle does not.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', '..', 'display', 'src', 'theme.ts'), 'utf8');

const BLOCK_NAMES: Readonly<Record<string, string>> = {
  household: 'HOUSEHOLD',
  blueprint: 'BLUEPRINT',
  panels: 'PANELS',
  almanac: 'ALMANAC',
  swiss: 'SWISS',
};

function bundleColours(constant: string): Record<string, string> {
  const from = source.indexOf(`const ${constant}: ThemeTokens = {`);
  if (from < 0) throw new Error(`theme.ts has no ${constant} block`);
  const to = source.indexOf('\n};', from);
  const block = source.slice(from, to);
  const out: Record<string, string> = {};
  for (const hit of block.matchAll(/'(--[a-z-]+)': '(#[0-9A-Fa-f]{6})'/g)) {
    const token = hit[1]!;
    if ((COLOUR_TOKENS as readonly string[]).includes(token)) out[token] = hit[2]!;
  }
  return out;
}

/** A block's `'--shadow-card'` value, which is a CSS shadow rather than a hex. */
function bundleShadow(constant: string): string | undefined {
  const from = source.indexOf(`const ${constant}: ThemeTokens = {`);
  const to = source.indexOf('\n};', from);
  const hit = /'--shadow-card': '([^']*)'/.exec(source.slice(from, to));
  return hit?.[1];
}

describe('the built-in palettes, on both bundles', () => {
  for (const [key, constant] of Object.entries(BLOCK_NAMES)) {
    it(`carries ${key} colour for colour`, () => {
      const bundle = bundleColours(constant);
      expect(Object.keys(bundle).sort()).toEqual([...COLOUR_TOKENS].sort());
      expect(BUILTIN_THEME_TOKENS[key as keyof typeof BUILTIN_THEME_TOKENS]).toEqual(bundle);
    });
  }

  /*
   * The card shadow (decision D8, plan item P4.4): declared in every block, so
   * no built-in falls through to the derived default by omission, and
   * transcribed here value for value. The plan's three kinds are asserted by
   * name as well as by parity, because parity alone would pass over both sides
   * being changed together to something the plan did not list.
   */
  for (const [key, constant] of Object.entries(BLOCK_NAMES)) {
    it(`carries ${key}'s card shadow`, () => {
      const bundle = bundleShadow(constant);
      expect(bundle, `${constant} declares no --shadow-card`).toBeDefined();
      expect(BUILTIN_THEME_SHADOWS[key as keyof typeof BUILTIN_THEME_SHADOWS]).toBe(bundle);
    });
  }

  it('is soft on Panels and Household, paper-like on Almanac, and none on Blueprint and Swiss', () => {
    expect(BUILTIN_THEME_SHADOWS.blueprint).toBe('none');
    expect(BUILTIN_THEME_SHADOWS.swiss).toBe('none');
    for (const soft of [BUILTIN_THEME_SHADOWS.panels, BUILTIN_THEME_SHADOWS.household]) {
      // A blurred shadow: offset x, offset y, and a blur radius that is not 0.
      expect(soft).toMatch(/^0 [0-9.]+rem [0-9.]+rem rgba\(/);
    }
    // Paper-like: offset, and no blur at all.
    expect(BUILTIN_THEME_SHADOWS.almanac).toMatch(/^[0-9.]+rem [0-9.]+rem 0 rgba\(/);
  });

  it('names exactly the themes a household is offered', () => {
    expect(Object.keys(BUILTIN_THEME_TOKENS).sort()).toEqual(THEMES.map((theme) => theme.key).sort());
  });

  it('folds every retired key onto Panels, as the bundle and the picker do', () => {
    for (const retired of Object.keys(LEGACY_THEME_ALIASES)) {
      expect(builtinThemeTokens(retired)).toBe(BUILTIN_THEME_TOKENS.panels);
    }
    expect(builtinThemeTokens('custom:missing')).toBe(BUILTIN_THEME_TOKENS.panels);
  });
});
