import { describe, expect, it } from 'vitest';

import type { Manifest } from '../src/manifest.js';
import { activeLayout, refreshDue } from '../src/wall-commands.js';

/**
 * The two commands a wall acts on from elsewhere (plan items M1.2, M1.3):
 * whose layout to draw, by the wall's own clock, and whether to reload.
 */

const NOW = Date.UTC(2026, 9, 6, 9, 0, 0);
const own = { mode: 'freeform', portrait: { aspect: 0.5625, widgets: [] } } as unknown as Manifest['layout'];
const borrowed = { mode: 'freeform', portrait: { aspect: 0.5625, widgets: [{ id: 'b' }] } } as unknown as Manifest['layout'];
const manifest = (extra: Partial<Manifest>): Manifest => ({ layout: own, ...extra }) as unknown as Manifest;

describe('activeLayout', () => {
  it('draws the borrowed layout until its time, and this wall’s own from that instant', () => {
    const m = manifest({ layoutOverride: { from: 'Kitchen', until: NOW + 1, layout: borrowed } });
    expect(activeLayout(m, NOW)).toBe(borrowed);
    expect(activeLayout(m, NOW + 1)).toBe(own);
  });

  it('draws this wall’s own when nothing is borrowed, or the borrowed one is not one', () => {
    expect(activeLayout(manifest({}), NOW)).toBe(own);
    expect(activeLayout(manifest({ layoutOverride: { until: NOW + 60_000 } }), NOW)).toBe(own);
    expect(activeLayout(manifest({ layoutOverride: { until: Number.NaN, layout: borrowed } }), NOW)).toBe(own);
    expect(
      activeLayout(manifest({ layoutOverride: { until: 'later', layout: borrowed } } as unknown as Partial<Manifest>), NOW),
    ).toBe(own);
  });
});

describe('refreshDue', () => {
  const asked = (at: unknown): Manifest => manifest({ screen: { refreshRequestedAt: at } } as unknown as Partial<Manifest>);

  it('reloads a page that started before the request, and never one started after it', () => {
    expect(refreshDue(asked(NOW), NOW - 1)).toBe(true);
    expect(refreshDue(asked(NOW), NOW)).toBe(false);
    expect(refreshDue(asked(NOW), NOW + 1)).toBe(false);
  });

  it('does nothing before the page knows when it started, or when nobody asked', () => {
    expect(refreshDue(asked(NOW), undefined)).toBe(false);
    expect(refreshDue(manifest({}), NOW - 1)).toBe(false);
    expect(refreshDue(asked('now'), NOW - 1)).toBe(false);
  });
});
