import { describe, expect, it } from 'vitest';
import { shownAt } from '../src/show-until.js';
import type { ManifestWidget } from '../src/manifest.js';

/**
 * A box shown for a while after something happened, taken down by the wall's
 * own clock (plan item M6.5): its fallback in its rectangle, or nothing, and a
 * group with every box inside it.
 */
const box = (id: string, extra: Partial<ManifestWidget> = {}): ManifestWidget => ({
  id,
  type: 'notes',
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.4,
  z: 0,
  config: { text: id },
  ...extra,
});

describe('shownAt', () => {
  const then = { ...box('ignored'), type: 'clock', config: {}, substituted: true };

  it('keeps a box until its time is up, then draws what it draws after, in the same box', () => {
    const widgets = [box('bell', { showUntil: 1000, then }), box('clock')];
    expect(shownAt(widgets, 999)).toEqual(widgets);
    const after = shownAt(widgets, 1000);
    expect(after.map((one) => [one.id, one.type])).toEqual([['bell', 'clock'], ['clock', 'notes']]);
    expect(after[0]).toMatchObject({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it('draws nothing in a box with no fallback once its time is up', () => {
    expect(shownAt([box('bell', { showUntil: 1000 }), box('clock')], 2000).map((one) => one.id)).toEqual(['clock']);
  });

  it('takes a group and every box inside it down together', () => {
    const widgets = [
      box('g', { type: 'group', showUntil: 1000 }),
      box('a', { parentId: 'g', showUntil: 1000 }),
      box('b', { parentId: 'g', showUntil: 1000, then }),
      box('clock'),
    ];
    expect(shownAt(widgets, 1000).map((one) => one.id)).toEqual(['clock']);
  });

  it('reads anything that is not an instant as no pulse', () => {
    const widgets = [box('a', { showUntil: 'soon' }), box('b', { showUntil: Number.NaN }), box('c', { showUntil: 5, then: 'x' })];
    expect(shownAt(widgets, 10).map((one) => one.id)).toEqual(['a', 'b']);
  });
});
