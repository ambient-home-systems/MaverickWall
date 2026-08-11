import { describe, expect, it } from 'vitest';
import { CATALOG, catalogEntry, catalogSchema } from '../src/http/catalog.js';

/**
 * The module catalogue (docs/rfc-002-module-catalog-and-recipes.md, Phase A1).
 *
 * The catalogue is data, and the point of a catalogue is that what it lists is
 * real and well-formed — so the test that matters is that the shipped list
 * validates against the schema a remote catalogue will one day be held to.
 */
describe('module catalogue', () => {
  it('ships a catalogue that satisfies its own schema', () => {
    const parsed = catalogSchema.safeParse(CATALOG);
    expect(parsed.success).toBe(true);
  });

  it('every entry has a unique, kebab-case id', () => {
    const ids = CATALOG.modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('looks an entry up by id, and misses cleanly', () => {
    expect(catalogEntry('countdown-example')?.name).toBe('Countdown');
    expect(catalogEntry('does-not-exist')).toBeUndefined();
    expect(catalogEntry('')).toBeUndefined();
  });

  it('rejects an entry with an unknown key rather than drawing it', () => {
    const bad = {
      version: 1,
      modules: [
        {
          id: 'x',
          name: 'X',
          author: 'a',
          description: 'd',
          icon: '⏳',
          kind: 'service',
          install: { hint: 'h', code: 'alert(1)' },
        },
      ],
    };
    expect(catalogSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a recipe entry with an embedded, valid recipe (A2)', () => {
    const catalog = {
      version: 1,
      modules: [
        {
          id: 'temp',
          name: 'Temp',
          author: 'a',
          description: 'd',
          icon: '🌡️',
          kind: 'recipe',
          recipe: {
            name: 'Temp',
            contract: 1,
            fetch: { url: 'https://api.example.com/x' },
            panel: { kind: 'stat', value: '{t | round:1}' },
          },
        },
      ],
    };
    expect(catalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('rejects a recipe entry whose embedded recipe is invalid', () => {
    const catalog = {
      version: 1,
      modules: [
        {
          id: 'temp',
          name: 'Temp',
          author: 'a',
          description: 'd',
          icon: '🌡️',
          kind: 'recipe',
          // `evil` is not an allowed formatter — the recipe schema catches it,
          // so the catalogue entry is rejected too.
          recipe: {
            name: 'Temp',
            contract: 1,
            fetch: { url: 'https://api.example.com/x' },
            panel: { kind: 'stat', value: '{t | evil}' },
          },
        },
      ],
    };
    expect(catalogSchema.safeParse(catalog).success).toBe(false);
  });

  it('a remote catalogue may not ask for a secret (nor reach the LAN)', async () => {
    const { remoteCatalogSchema } = await import('../src/http/catalog.js');
    const withSecret = {
      version: 1,
      modules: [
        {
          id: 'x', name: 'X', author: 'a', description: 'd', icon: '🔑', kind: 'recipe',
          recipe: {
            name: 'X', contract: 1, secrets: [{ key: 'api_key', label: 'Key' }],
            fetch: { url: 'https://x/y', headers: { A: '{secret:api_key}' } },
            panel: { kind: 'stat', value: '{v}' },
          },
        },
      ],
    };
    // The built-in schema accepts it (a hand-pasted recipe may use secrets)…
    expect(catalogSchema.safeParse(withSecret).success).toBe(true);
    // …but a remote catalogue may not.
    expect(remoteCatalogSchema.safeParse(withSecret).success).toBe(false);
  });

  it('ships a working recipe entry to demonstrate the flow', () => {
    const entry = catalogEntry('outside-temperature');
    expect(entry?.kind).toBe('recipe');
    if (entry?.kind === 'recipe') {
      expect(entry.recipe.config.map((f) => f.key)).toEqual(['lat', 'lon']);
    }
  });
});
