import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_ENTRIES } from '../src/catalog/index.js';
import { recipeSchema } from '../src/modules/external/recipe.js';
import { checkFixture, loadFixture } from '../src/modules/external/recipe-fixture.js';
import { panelDataSchema } from '../src/modules/external/panel-data.js';

/**
 * Every recipe in the store, run on what its own feed really answered (plan
 * item M7.11).
 *
 * The store promises that every entry is real and installable
 * (`docs/adding-to-the-store.md`), and a schema can only say a recipe is
 * well-formed. So each recipe has a fixture under `fixtures/store/<id>/`,
 * captured from its own address with its default settings by
 * `scripts/store/capture.mjs`, and recorded by `test-recipe --update` once a
 * person had read what it drew. This holds three things: the fixture's recipe
 * is the store's, byte for byte, so a fixture cannot go on passing for a
 * recipe that has since changed; the recipe still builds what was recorded;
 * and what it builds is a panel a wall draws. A store recipe with no fixture
 * fails here, and so does a fixture whose recipe left the store.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures/store');
const recipes = STORE_ENTRIES.flatMap((entry) => (entry.kind === 'recipe' ? [entry] : []));

describe('the store’s recipes, on their feeds’ real answers', () => {
  it('has a fixture for every recipe, and none for a recipe it does not carry', () => {
    const dirs = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual(recipes.map((entry) => entry.id).sort());
  });

  for (const entry of recipes) {
    describe(entry.id, () => {
      const dir = join(FIXTURES, entry.id);

      it('carries the store’s own recipe', () => {
        const saved = recipeSchema.parse(JSON.parse(readFileSync(join(dir, 'recipe.json'), 'utf8')));
        expect(saved).toEqual(recipeSchema.parse(entry.recipe));
      });

      it('is read at the instant it was captured', () => {
        // A recipe's times and its timeline's next item are worked out from a
        // clock, so a fixture checked against today would drift.
        expect(existsSync(join(dir, 'fixture.json'))).toBe(true);
        const loaded = loadFixture(dir, 0);
        expect(loaded.ok && loaded.fixture.pinned).toBe(true);
      });

      it('builds what was recorded, and a panel a wall draws', () => {
        const loaded = loadFixture(dir, 0);
        if (!loaded.ok) throw new Error(loaded.error);
        const check = checkFixture(loaded.fixture);
        expect(check.lines).toEqual([]);
        expect(check.status).toBe('pass');
        const panel = check.built?.panel;
        expect(panelDataSchema.safeParse(panel).success).toBe(true);
        // An empty-state line is a true answer on some days, but not on the
        // day a fixture was captured to show the recipe drawing its feed: a
        // recipe that draws rows has to have drawn some.
        expect((panel as { kind: string }).kind).toBe(entry.recipe.panel.kind);
      });
    });
  }
});
