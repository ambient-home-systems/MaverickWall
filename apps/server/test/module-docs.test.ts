import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelDataSchema } from '../src/modules/external/panel-data.js';
import { recipeSchema } from '../src/modules/external/recipe.js';
import { scriptManifestSchema, scriptSourceSchema } from '../src/modules/external/script.js';
import { runScript } from '../src/modules/external/sandbox.js';
import { signalDataSchema } from '../src/modules/external/signal-data.js';
import { isGlyphKey } from '../src/glyphs.js';

/**
 * The module guide's examples, held to the schemas they describe (plan item
 * M7.1).
 *
 * The guide went on advertising `stat` and `tiles` as a big number and a strip
 * of tiles, and an emoji `icon` on a reading, for releases after the wall drew
 * all three as rows and dropped the icon. Prose does not fail to compile, so a
 * module author copied a shape the wall had stopped honouring. Two halves:
 * every complete JSON example in it must parse as what it claims to be — a
 * panel, a recipe, or a signals body — and the retired claims must not come
 * back, worded as they were.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(here, '../../../docs', name), 'utf8');

function jsonBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    const text = (match[1] ?? '').trim();
    // A fragment (`"config": […]`) is a key out of a recipe, not a document.
    if (!text.startsWith('{')) continue;
    blocks.push(JSON.parse(text));
  }
  return blocks;
}

describe('docs/building-a-module.md', () => {
  const guide = read('building-a-module.md');
  const blocks = jsonBlocks(guide);

  it('parses every complete example as a panel, a recipe, a signals body or a service manifest', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const block of blocks) {
      const o = block as Record<string, unknown>;
      if ('kind' in o) expect(panelDataSchema.safeParse(o).success, JSON.stringify(o)).toBe(true);
      else if ('fetch' in o) expect(recipeSchema.safeParse(o).success, JSON.stringify(o)).toBe(true);
      else if ('signals' in o) expect(signalDataSchema.safeParse(o).success, JSON.stringify(o)).toBe(true);
      else if ('hosts' in o) expect(scriptManifestSchema.safeParse(o).success, JSON.stringify(o)).toBe(true);
      else expect(o['contract'], JSON.stringify(o)).toBe(1);
    }
  });

  it('runs its script example in the sandbox, on the answer its comment describes', async () => {
    const scripts = [...guide.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    expect(scripts).toHaveLength(1);
    const source = scripts[0]!;
    expect(scriptSourceSchema.safeParse(source).success).toBe(true);
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const outcome = await runScript({
      source,
      config: { street: 'High Street' },
      now: Date.parse('2026-10-14T12:00:00Z'),
      timeZone: 'Europe/London',
      fetch: async (request) => {
        asked.push({ url: request.url, headers: request.options.headers ?? {} });
        const body = JSON.stringify({ bins: [{ kind: 'Garden', date: '2026-10-20' }, { kind: 'Recycling', date: '2026-10-16' }] });
        return { ok: true, status: 200, contentType: 'application/json', body };
      },
    });
    expect(outcome).toMatchObject({ ok: true, panel: { kind: 'countdown', label: 'Recycling', at: '2026-10-16T07:00:00Z' } });
    expect(asked).toEqual([
      {
        url: 'https://bins.example-council.gov.uk/v1/collections?street=High%20Street',
        headers: { 'X-Api-Key': '{secret:api_key}' },
      },
    ]);
  });

  it('gives every reading a glyph key from the drawn set, never an icon', () => {
    for (const block of blocks) {
      const items = (block as { items?: unknown }).items;
      if (!Array.isArray(items)) continue;
      for (const item of items as Record<string, unknown>[]) {
        expect(item).not.toHaveProperty('icon');
        if ('glyph' in item) expect(isGlyphKey(item['glyph'])).toBe(true);
      }
    }
  });

  it('names every glyph key the wall can draw, and no other', () => {
    const listed = guide.match(/never a character: ([^.]+)\./)?.[1] ?? '';
    const keys = [...listed.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(isGlyphKey(key), key).toBe(true);
  });

  it('no longer says what the wall stopped doing', () => {
    for (const retired of [
      'one big value and a caption',
      'a short strip of label',
      'an emoji or a symbol',
      'Add-ons screen',
      'Add-ons →',
      'remote** catalogue',
      'reorder is on the roadmap',
    ]) {
      expect(guide, retired).not.toContain(retired);
    }
  });
});

describe('docs/adding-to-the-store.md', () => {
  const store = read('adding-to-the-store.md');

  it('shows a glyph key on the entry, not an emoji icon', () => {
    expect(store).not.toMatch(/^\s*icon:/m);
    const glyph = store.match(/^\s*glyph: '([a-z-]+)'/m)?.[1];
    expect(isGlyphKey(glyph)).toBe(true);
  });
});
