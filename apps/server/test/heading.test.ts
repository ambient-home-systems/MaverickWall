import { describe, expect, it } from 'vitest';

import {
  headingDivider,
  headingPlace,
  headingSecond,
  headingSize,
  headingSizesFrom,
  headingText,
} from '../src/api/heading.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';

/**
 * How a Heading widget reads its config (plan item M5.4), and what the schema
 * will store. Both renderers read through these functions, so what is pinned
 * here is what a wall and a panel both draw.
 */
describe('a heading’s config, read', () => {
  it('is medium and in the middle unless asked otherwise', () => {
    expect(headingSize({})).toBe('medium');
    expect(headingSize({ textSize: 'huge' })).toBe('medium');
    expect(headingSize({ textSize: 'large' })).toBe('large');
    expect(headingPlace({})).toBe('middle');
    expect(headingPlace({ valign: 'bottom' })).toBe('bottom');
  });

  it('steps down from the size asked for and never up', () => {
    expect(headingSizesFrom({ textSize: 'large' })).toEqual(['large', 'medium', 'small']);
    expect(headingSizesFrom({})).toEqual(['medium', 'small']);
    expect(headingSizesFrom({ textSize: 'small' })).toEqual(['small']);
  });

  it('draws the words as typed, capitalised only when asked, and treats blank as nothing', () => {
    expect(headingText({ text: 'This week' })).toBe('This week');
    expect(headingText({ text: 'This week', uppercase: true })).toBe('THIS WEEK');
    expect(headingSecond({ subtitle: 'Bins on Tuesday', uppercase: true })).toBe('BINS ON TUESDAY');
    expect(headingText({ text: '   ' })).toBeUndefined();
    // What the household typed is theirs: nothing is stripped.
    expect(headingText({ text: 'Grandma’s 80th 🎉' })).toBe('Grandma’s 80th 🎉');
  });

  it('draws a rule only when asked and only under a heading', () => {
    expect(headingDivider({ text: 'This week' })).toBe(false);
    expect(headingDivider({ text: 'This week', divider: true })).toBe(true);
    expect(headingDivider({ subtitle: 'Only a second line', divider: true })).toBe(false);
  });
});

describe('the schema', () => {
  const ok = (config: Record<string, unknown>) => widgetConfigBody.safeParse(config).success;

  it('stores every key a heading is made from', () => {
    expect(
      ok({
        text: 'This week',
        subtitle: 'Bins on Tuesday',
        textSize: 'large',
        valign: 'top',
        glyph: 'person',
        divider: true,
        uppercase: true,
      }),
    ).toBe(true);
  });

  it('refuses a picture outside the drawn set, a size or place it does not know, and a long second line', () => {
    expect(ok({ glyph: 'party-popper' })).toBe(false);
    expect(ok({ textSize: 'huge' })).toBe(false);
    expect(ok({ valign: 'center' })).toBe(false);
    expect(ok({ subtitle: 'x'.repeat(201) })).toBe(false);
  });

  it('lets a panel lay a heading out differently, and nothing else of it', () => {
    expect(ok({ ink: { textSize: 'small', valign: 'top', align: 'center' } })).toBe(true);
    expect(ok({ ink: { text: 'Another heading' } })).toBe(false);
    expect(ok({ ink: { glyph: 'clear' } })).toBe(false);
  });
});
