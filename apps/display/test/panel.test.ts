import { describe, expect, it } from 'vitest';
import { panelFrom } from '../src/viewmodel.js';

/**
 * The defensive read of a module panel.
 *
 * The server validates the module's body, but the display reads it as untrusted
 * all the same — a wall a version ahead of the server must still draw something
 * sane, and a hostile string must never survive to the DOM. These tests are
 * about what it refuses and what it strips.
 */
describe('panelFrom', () => {
  it('shapes a readings panel, keeping the glyph and dropping a bad row', () => {
    const panel = panelFrom({
      kind: 'readings',
      title: 'The house',
      items: [
        { label: 'Front door', value: 'Locked', glyph: 'lock' },
        { label: 'Nope' }, // no value → dropped
        { value: 'Nope' }, // no label → dropped
      ],
    });
    expect(panel).toEqual({
      kind: 'readings',
      title: 'The house',
      items: [{ label: 'Front door', value: 'Locked', glyph: 'lock' }],
    });
  });

  it('shapes stat, tiles and text', () => {
    expect(panelFrom({ kind: 'stat', value: '135', caption: 'days' })).toEqual({
      kind: 'stat',
      value: '135',
      caption: 'days',
    });
    expect(panelFrom({ kind: 'tiles', items: [{ label: 'Mon', value: '24°' }] })).toEqual({
      kind: 'tiles',
      items: [{ label: 'Mon', value: '24°' }],
    });
    expect(panelFrom({ kind: 'text', text: 'Bins out tonight' })).toEqual({
      kind: 'text',
      text: 'Bins out tonight',
    });
  });

  it('refuses anything outside the vocabulary', () => {
    expect(panelFrom(null)).toBeNull();
    expect(panelFrom('nope')).toBeNull();
    expect(panelFrom({ kind: 'website', url: 'https://x' })).toBeNull();
    expect(panelFrom({ kind: 'readings', items: [] })).toBeNull();
    expect(panelFrom({ kind: 'stat' })).toBeNull(); // no value
    expect(panelFrom({ kind: 'text' })).toBeNull(); // no text
  });

  it('strips control and bidi characters, and caps a long value', () => {
    const panel = panelFrom({
      kind: 'readings',
      items: [{ label: 'Room‮evil', value: 'x'.repeat(200) }],
    });
    if (panel === null || panel.kind !== 'readings') throw new Error('expected readings');
    // The bidi override is gone.
    expect(panel.items[0]?.label).toBe('Roomevil');
    // Capped to 60, ellipsis included.
    expect(panel.items[0]?.value.length).toBe(60);
  });

  it('caps a readings list at twelve items', () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ label: `L${n}`, value: `V${n}` }));
    const panel = panelFrom({ kind: 'readings', items });
    if (panel === null || panel.kind !== 'readings') throw new Error('expected readings');
    expect(panel.items).toHaveLength(12);
  });
});
