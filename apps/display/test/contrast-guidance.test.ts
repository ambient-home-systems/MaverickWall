import { describe, expect, it } from 'vitest';

import { contrastWarnings } from '../src/contrast-guidance.js';

/** The theme builder's guidance, shared with the widget inspector (RFC 014 §4.1). */
describe('contrast guidance', () => {
  it('says nothing about a readable pair', () => {
    expect(contrastWarnings({ '--bg': '#14181E', '--ink': '#EDEBE6', '--muted': '#9AA5B2', '--accent': '#5C93E0' })).toEqual([]);
  });

  it('warns, and names the pair, about text that would vanish at ten feet', () => {
    const warnings = contrastWarnings({ '--bg': '#FFF8E7', '--ink': '#EDEBE6' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Body text may be hard to read at ten feet/);
  });

  it('checks only what it was given', () => {
    expect(contrastWarnings({ '--bg': '#FFFFFF' })).toEqual([]);
  });
});
