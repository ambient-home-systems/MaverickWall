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

  it('rejects a recipe entry — Phase A1 is service modules only', () => {
    const recipe = {
      version: 1,
      modules: [
        {
          id: 'x',
          name: 'X',
          author: 'a',
          description: 'd',
          icon: '⏳',
          kind: 'recipe',
          install: { hint: 'h' },
        },
      ],
    };
    expect(catalogSchema.safeParse(recipe).success).toBe(false);
  });
});
