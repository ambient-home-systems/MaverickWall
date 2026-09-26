import { describe, expect, it } from 'vitest';

import {
  LOOK_SEGMENTS_MAX,
  VARIANTS,
  VARIANT_HIDES,
  VARIANT_LABELS,
  hasVariants,
  hiddenByVariant,
  lookIsGrid,
  variantOf,
  variantsFor,
  type VariantType,
} from '../src/variants.js';

/**
 * Every widget type's designed variants, as data (plan item P4.1).
 *
 * `clockVariant` generalised: one list per type with its default first, one
 * label per value, and one resolver that reads a value another type owns as
 * "not for me". Asked here with no DOM; the editor's use of it is measured in
 * a real browser in `browser-widget-looks.test.ts`, and the panel's
 * transcription is held to this file by `variants-parity.test.ts`.
 */

const TYPES = Object.keys(VARIANTS) as VariantType[];

describe('which look a config means', () => {
  it('reads the clock exactly as `clockVariant` did', () => {
    // The three it draws, and `plain` for everything else — the four cases
    // `clock-face.test.ts` asked of `clockVariant` before it moved here.
    expect(variantOf('clock', undefined)).toBe('plain');
    expect(variantOf('clock', {})).toBe('plain');
    expect(variantOf('clock', { variant: 'strip' })).toBe('plain');
    expect(variantOf('clock', { variant: 42 })).toBe('plain');
    for (const variant of VARIANTS.clock) expect(variantOf('clock', { variant })).toBe(variant);
  });

  it('reads a value another type owns as that type’s default, for every type', () => {
    const everything = [...new Set(TYPES.flatMap((type) => [...VARIANTS[type]]))];
    for (const type of TYPES) {
      const own: readonly string[] = VARIANTS[type];
      for (const value of everything) {
        const read = variantOf(type, { variant: value });
        expect(read, `${type} given ${JSON.stringify(value)}`).toBe(own.includes(value) ? value : own[0]);
      }
      expect(variantOf(type, null), `${type}, null`).toBe(own[0]);
      expect(variantOf(type, 'today'), `${type}, a bare string`).toBe(own[0]);
    }
  });

  it('names the defaults the plan names', () => {
    // What an absent `variant` draws, per type — the look every hanging wall
    // already has, so an unchosen widget sends a byte-identical config.
    expect(TYPES.map((type) => [type, VARIANTS[type][0]])).toEqual([
      ['clock', 'plain'],
      ['weather', 'strip'],
      ['countdown', 'number'],
      ['homeassistant', 'list'],
      ['calendar', ''],
    ]);
  });

  it('has no list for a type without looks, however its name is spelt', () => {
    for (const type of ['notes', 'shift', 'todo', 'image', 'external', 'group', 'toString', 'constructor', '__proto__']) {
      expect(hasVariants(type), type).toBe(false);
      expect(variantsFor(type), type).toEqual([]);
      expect(hiddenByVariant(type, { variant: 'analogue' }), type).toEqual([]);
      expect(lookIsGrid(type), type).toBe(false);
    }
  });
});

describe('what the Look picker shows', () => {
  it('labels every value of every type, and nothing else', () => {
    for (const type of TYPES) {
      const labels = VARIANT_LABELS[type] as Readonly<Record<string, string>>;
      expect(Object.keys(labels).sort(), type).toEqual([...VARIANTS[type]].sort());
      expect(new Set(Object.values(labels)).size, `${type} has two choices with one label`).toBe(
        VARIANTS[type].length,
      );
    }
    expect(VARIANT_LABELS.clock).toEqual({ plain: 'Plain', stacked: 'Stacked', analogue: 'Analogue' });
  });

  it('is a segmented row up to three choices and a grid past it', () => {
    expect(LOOK_SEGMENTS_MAX).toBe(3);
    expect(TYPES.filter(lookIsGrid)).toEqual(['weather', 'countdown']);
    for (const type of TYPES) expect(lookIsGrid(type), type).toBe(VARIANTS[type].length > 3);
  });
});

describe('which controls a look hides', () => {
  it('hides exactly what `buildClockConfig` stopped drawing', () => {
    // An analogue face has no digits to format and no date line; a stacked
    // clock always draws its date. A plain one hides nothing.
    expect(hiddenByVariant('clock', {})).toEqual([]);
    expect(hiddenByVariant('clock', { variant: 'plain' })).toEqual([]);
    expect(hiddenByVariant('clock', { variant: 'stacked' })).toEqual(['showDate']);
    expect(hiddenByVariant('clock', { variant: 'analogue' })).toEqual(['clockFormat', 'showDate']);
    // Another type's value is "not for me", so a clock handed one hides what
    // a plain clock hides: nothing.
    expect(hiddenByVariant('clock', { variant: 'tile' })).toEqual([]);
  });

  it('states a list for every value of every type', () => {
    for (const type of TYPES) {
      const hides = VARIANT_HIDES[type] as Readonly<Record<string, readonly string[]>>;
      expect(Object.keys(hides).sort(), type).toEqual([...VARIANTS[type]].sort());
    }
  });

  it('hides nothing on a look that still draws its type’s default', () => {
    /*
     * Every non-clock, non-forecast value still reads every control its type's
     * default does, so every control on it still does what it did — and
     * taking a working setting off the screen is the other half of the rule
     * that an option which does nothing is worse than one not offered. The
     * forecast's five are all designed now (P5.1), and so are the countdown's
     * six (P5.2) and Home Assistant's tile (P5.3); all three are stated below.
     */
    for (const type of TYPES.filter((one) => !['clock', 'weather', 'countdown', 'homeassistant'].includes(one))) {
      for (const variant of VARIANTS[type]) {
        expect(hiddenByVariant(type, { variant }), `${type}.${variant}`).toEqual([]);
      }
    }
  });

  it('hides the tile’s four off the list, and the list’s ladder off the tile (P5.3)', () => {
    // A tile is always its mark, its name and its state, so the ladder moves
    // nothing on it; the tile's own options move nothing on the list. An
    // absent look is the list, as a config saved before tiles existed is.
    const tileKeys = ['tileLayout', 'hideState', 'showChanged', 'showBar'];
    expect(hiddenByVariant('homeassistant', {})).toEqual(tileKeys);
    expect(hiddenByVariant('homeassistant', { variant: 'list' })).toEqual(tileKeys);
    expect(hiddenByVariant('homeassistant', { variant: 'tile' })).toEqual(['fields']);
    // A clock's look on a Home Assistant box is "not for me": the list.
    expect(hiddenByVariant('homeassistant', { variant: 'analogue' })).toEqual(tileKeys);
  });

  it('hides the occasion picker off `occasion` and the start date off `progress` (P5.2)', () => {
    // Each is read by one look alone, so on every other look it is a control
    // that moves nothing. Every other countdown control is read by all six.
    expect(hiddenByVariant('countdown', {})).toEqual(['occasion', 'from']);
    for (const variant of ['number', 'page', 'ticket', 'month']) {
      expect(hiddenByVariant('countdown', { variant }), variant).toEqual(['occasion', 'from']);
    }
    expect(hiddenByVariant('countdown', { variant: 'occasion' })).toEqual(['from']);
    expect(hiddenByVariant('countdown', { variant: 'progress' })).toEqual(['occasion']);
  });

  it('hides on each forecast look exactly the controls it does not read (P5.1)', () => {
    // A range row is the style's own columns and `RANGE_TIERS` decides what a
    // narrow box gives up, so the ladder would be a control that moves nothing.
    // The colour look is the strip painted, and keeps every control the strip
    // has. Today is a card about today: no day count and no ladder ("`today`
    // hides the day count", the plan). The advice line is playful's alone, so
    // every other look hides its switch — and playful hides nothing, since it
    // reads the strip's count and ladder as well as its own advice.
    expect(hiddenByVariant('weather', {})).toEqual(['advice']);
    expect(hiddenByVariant('weather', { variant: 'range' })).toEqual(['fields', 'advice']);
    expect(hiddenByVariant('weather', { variant: 'colour' })).toEqual(['advice']);
    expect(hiddenByVariant('weather', { variant: 'today' })).toEqual(['count', 'fields', 'advice']);
    expect(hiddenByVariant('weather', { variant: 'playful' })).toEqual([]);
  });
});
