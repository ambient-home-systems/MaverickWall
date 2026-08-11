import { describe, expect, it } from 'vitest';
import { CATALOG, catalogEntry, catalogSchema, previewFor, recipePreview } from '../src/http/catalog.js';

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

  it('ships a working recipe entry to demonstrate the flow', () => {
    const entry = catalogEntry('outside-temperature');
    expect(entry?.kind).toBe('recipe');
    if (entry?.kind === 'recipe') {
      expect(entry.recipe.config.map((f) => f.key)).toEqual(['lat', 'lon']);
    }
  });
});

describe('store card previews', () => {
  it('derives a recipe preview from its own panel: labels kept, live value placeheld', () => {
    // The shipped stat recipe: value is a {selector}, title and caption are
    // literals — so the derived preview shows "— °C" over "Outside".
    const entry = catalogEntry('outside-temperature');
    if (entry?.kind !== 'recipe') throw new Error('expected the recipe entry');
    expect(recipePreview(entry.recipe)).toEqual(['— °C', 'Outside']);
  });

  it('derives previews for the other panel kinds too', () => {
    const stat = { kind: 'stat', value: '19', caption: '°C' } as const; // literal value
    expect(recipePreview({ panel: stat } as never)).toEqual(['19 °C']);

    const text = { kind: 'text', title: 'Note', text: '{body}' } as const;
    expect(recipePreview({ panel: text } as never)).toEqual(['Note', '—']);

    const readings = { kind: 'readings', items: { for: 'a', label: '{name}', value: '{v}' } } as const;
    expect(recipePreview({ panel: readings } as never)).toEqual(['Readings', '— —']);
  });

  it('an authored preview wins over the derived one', () => {
    const entry = catalogEntry('outside-temperature');
    if (entry?.kind !== 'recipe') throw new Error('expected the recipe entry');
    // The shipped entry authored ['19.4°','Outside']; previewFor returns that,
    // not the derived '— °C'.
    expect(entry.preview).toBeDefined();
    expect(previewFor(entry)).toEqual(entry.preview);
  });

  it('a recipe with no authored preview falls back to the derived one', () => {
    const entry = catalogEntry('outside-temperature');
    if (entry?.kind !== 'recipe') throw new Error('expected the recipe entry');
    const { preview: _omitted, ...bare } = entry;
    expect(previewFor(bare as never)).toEqual(['— °C', 'Outside']);
  });

  it('a service with no authored preview has nothing to derive', () => {
    const entry = catalogEntry('countdown-example');
    if (entry?.kind !== 'service') throw new Error('expected the service entry');
    const { preview: _omitted, ...bare } = entry;
    expect(previewFor(bare as never)).toBeUndefined();
  });
});
