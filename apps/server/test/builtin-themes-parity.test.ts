import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BUILTIN_THEME_TOKENS, builtinThemeTokens } from '../src/api/builtin-themes.js';
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

describe('the built-in palettes, on both bundles', () => {
  for (const [key, constant] of Object.entries(BLOCK_NAMES)) {
    it(`carries ${key} colour for colour`, () => {
      const bundle = bundleColours(constant);
      expect(Object.keys(bundle).sort()).toEqual([...COLOUR_TOKENS].sort());
      expect(BUILTIN_THEME_TOKENS[key as keyof typeof BUILTIN_THEME_TOKENS]).toEqual(bundle);
    });
  }

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
