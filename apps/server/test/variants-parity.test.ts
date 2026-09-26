import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WIDGET_TYPES } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { INK_LANE } from '../src/epaper/honours.js';
import {
  VARIANTS,
  VARIANT_LABELS,
  hasVariants,
  variantOf,
  variantsFor,
  type VariantType,
} from '../src/epaper/variants.js';

/**
 * The wall and the panel read one Look, and this proves it by reading both
 * files (plan item P4.1, RFC 014 §4.2).
 *
 * `variant` is one enum for every widget type and each type draws its own
 * list of it. A panel can follow a wall, so the same stored value is resolved
 * twice — once in the browser, once on one bit — and two renderers taking one
 * decision separately is the bug this repository has recorded most
 * (`shifts[0]`, `display_mode`, `cellEvents`, `mode`). So the lists are
 * written twice, for the reason `tiers.ts`, `month-spans.ts` and
 * `clock-face.ts` are — the display bundle has no bundler and the server
 * cannot import it — and the block between the `variants:begin` and
 * `variants:end` markers is **character-identical** in both.
 *
 * The block is the whole of the panel's file, and that is asserted rather
 * than assumed: `tier-parity`'s lesson is that a table added on one side
 * *outside* the compared text sails straight through a comparison of the
 * text. The display file carries two editor-only things after its block —
 * which controls a look hides, and when the Look becomes a grid — and the
 * panel builds no control, so it carries neither.
 *
 * **The wall is the spec.** Where these disagree, the display file is right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_PATH = join(HERE, '..', '..', 'display', 'src', 'variants.ts');
const PANEL_PATH = join(HERE, '..', 'src', 'epaper', 'variants.ts');
const BEGIN = '/*\n * variants:begin';
const END = '/* variants:end */';

function block(source: string, where: string): string {
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  if (from < 0 || to < from) throw new Error(`no variants block in ${where}`);
  return source.slice(from, to + END.length);
}

/** Every `export const` / `export function` / `export type` a text declares. */
function exportsOf(text: string): string[] {
  return [...text.matchAll(/export (?:const|function|type|interface) (\w+)/g)].map((m) => m[1] as string).sort();
}

/** The schema's own list of values, read off the enum rather than restated. */
const SCHEMA_VALUES: readonly string[] = widgetConfigBody.shape.variant.unwrap().options;

const TYPES = Object.keys(VARIANTS) as VariantType[];

describe('the wall and the panel read one Look', () => {
  const wall = readFileSync(WALL_PATH, 'utf8');
  const panel = readFileSync(PANEL_PATH, 'utf8');

  it('holds the two blocks to the same text, character for character', () => {
    const left = block(wall, WALL_PATH).split('\n');
    const right = block(panel, PANEL_PATH).split('\n');
    const shared = Math.min(left.length, right.length);
    for (let line = 0; line < shared; line++) {
      expect(right[line], `line ${line + 1} of the block: ${PANEL_PATH} differs from ${WALL_PATH}`).toBe(left[line]);
    }
    expect(right.length, 'the two blocks are different lengths').toBe(left.length);
  });

  it('declares nothing on the panel outside the block', () => {
    // The panel's file is a comment and the block: an export added after the
    // end marker, or before the begin one, is a table only one side has.
    const inside = exportsOf(block(panel, PANEL_PATH));
    expect(exportsOf(panel)).toEqual(inside);
    expect(panel.slice(panel.indexOf(END) + END.length).trim()).toBe('');
    // And the wall declares every one of them inside its block too.
    expect(exportsOf(block(wall, WALL_PATH))).toEqual(inside);
  });
});

describe('the lists themselves', () => {
  it('names a real widget type for every list', () => {
    for (const type of TYPES) expect(WIDGET_TYPES as readonly string[], type).toContain(type);
  });

  it('is exactly the schema’s enum, taken together', () => {
    /*
     * Both directions. A value in the enum no list names is a value the
     * editor can never offer and every renderer draws as a default for ever;
     * a value in a list the enum lacks is a choice the editor offers and the
     * server refuses with a 400. The calendar's empty default is an absence,
     * not a value, and the schema refuses it (below).
     */
    const listed = new Set(TYPES.flatMap((type) => [...VARIANTS[type]]).filter((value) => value !== ''));
    expect([...listed].sort()).toEqual([...SCHEMA_VALUES].sort());
    expect(widgetConfigBody.safeParse({ variant: '' }).success).toBe(false);
  });

  it('lists each value once per type, with an absence only ever as the default', () => {
    for (const type of TYPES) {
      const values: readonly string[] = VARIANTS[type];
      expect(new Set(values).size, `${type} names a value twice`).toBe(values.length);
      expect(values.length, `${type} has a list of one, which is not a choice`).toBeGreaterThan(1);
      expect(values.indexOf(''), `${type} has an empty value that is not its default`).toBeLessThan(1);
    }
  });

  it('labels every value, and labels nothing else', () => {
    for (const type of TYPES) {
      const labels = VARIANT_LABELS[type] as Readonly<Record<string, string>>;
      expect(Object.keys(labels).sort(), type).toEqual([...VARIANTS[type]].sort());
      for (const value of VARIANTS[type]) expect(labels[value]?.trim().length, `${type}.${value}`).toBeGreaterThan(0);
      // Two choices with one label is a picker nobody can read.
      expect(new Set(Object.values(labels)).size, type).toBe(VARIANTS[type].length);
    }
  });

  it('never offers an absence on the ink lane, where it could not be written', () => {
    /*
     * An ink override that means "the default on the panel" has to be *stored*
     * — clearing it would hand the panel back to the wall's look — so a type
     * whose default is an absence cannot offer its Look on the lane.
     */
    for (const type of TYPES) {
      if (VARIANTS[type][0] !== '') continue;
      expect(INK_LANE[type] ?? [], type).not.toContain('variant');
    }
  });
});

describe('which look a config means', () => {
  it('is the type’s own value, or its default for anything else', () => {
    for (const type of TYPES) {
      const values: readonly string[] = VARIANTS[type];
      const fallback = values[0];
      expect(variantOf(type, undefined), `${type}, no config`).toBe(fallback);
      expect(variantOf(type, {}), `${type}, absent`).toBe(fallback);
      expect(variantOf(type, { variant: 42 }), `${type}, not a string`).toBe(fallback);
      expect(variantOf(type, { variant: 'website' }), `${type}, not a value at all`).toBe(fallback);
      // Every schema value: the type's own draws as itself, another type's is
      // "not for me" and draws the default.
      for (const value of SCHEMA_VALUES) {
        expect(variantOf(type, { variant: value }), `${type} given ${value}`).toBe(
          values.includes(value) ? value : fallback,
        );
      }
    }
  });

  it('has no list for a type without looks, however its name is spelt', () => {
    for (const type of ['notes', 'shift', 'todo', 'image', 'external', 'group', 'constructor', '__proto__']) {
      expect(hasVariants(type), type).toBe(false);
      expect(variantsFor(type), type).toEqual([]);
    }
  });
});
