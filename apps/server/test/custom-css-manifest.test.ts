import { describe, expect, it } from 'vitest';
import { buildManifest, manifestEtag, type BuildManifestInput } from '../src/api/manifest.js';
import { sanitiseCustomCss } from '../src/api/custom-css.js';

/**
 * How a household's CSS travels (RFC 014 §7): the scoped text and nothing
 * else, and — the property that matters most, on the `wall-sizing` argument —
 * nothing at all until somebody writes one. `manifestEtag` hashes the
 * serialisation, so a `"customCss": null` on every widget in the world would
 * churn every stored ETag at one image pull for a household who never opened
 * the page. Compared as text, because that is what the hash and the wire
 * carry.
 */

const HOUSEHOLD = {
  timezone: 'Europe/London',
  shiftEnabled: 0,
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  clock24: 1,
  weekStart: 'sunday',
  layoutMode: 'freeform',
  layoutAspect: 0.5625,
  layoutLandscapeAspect: 1.7778,
  layoutBackground: null,
  layoutLandscapeBackground: null,
} as unknown as BuildManifestInput['household'];

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

const WIDGET = { id: 'w1', type: 'clock', x: 0, y: 0, w: 1, h: 0.2, z: 0, config: { align: 'center' } };

const BASE: BuildManifestInput = {
  household: HOUSEHOLD,
  events: [],
  sources: [],
  people: [],
  shiftTypes: [],
  shiftPlans: [],
  shiftOverrides: [],
  today: '2026-09-10',
  daysBefore: 1,
  daysAfter: 5,
  now: NOW,
  appVersion: '0.1.0-test',
  layoutWidgetsPortrait: [WIDGET],
  screen: { orientation: 'auto', rotation: 0, allowDismiss: false, allowChores: false, theme: 'panels' },
};

describe('a wall nobody has written CSS for', () => {
  it('sends the document it sent before the columns existed, byte for byte', () => {
    const untouched = buildManifest(BASE);
    const nulled = buildManifest({
      ...BASE,
      screen: { ...BASE.screen!, customCss: null },
      layoutWidgetsPortrait: [{ ...WIDGET }],
    });
    const emptied = buildManifest({
      ...BASE,
      screen: { ...BASE.screen!, customCss: '' },
    });
    expect(JSON.stringify(nulled)).toBe(JSON.stringify(untouched));
    expect(JSON.stringify(emptied)).toBe(JSON.stringify(untouched));
    expect(manifestEtag(nulled)).toBe(manifestEtag(untouched));
    expect(JSON.stringify(untouched)).not.toContain('customCss');
  });
});

describe('a wall somebody has written CSS for', () => {
  const wall = sanitiseCustomCss('.fw { padding: 0 }', { kind: 'wall' });
  const widget = sanitiseCustomCss('.clock { color: #ff0000 }', { kind: 'widget', id: 'w1' });
  if (!wall.ok || !widget.ok) throw new Error('the fixture blocks must sanitise');

  const styled = buildManifest({
    ...BASE,
    screen: { ...BASE.screen!, customCss: wall.css },
    layoutWidgetsPortrait: [{ ...WIDGET, customCss: widget.css }],
  });

  it('carries the scoped text, on the wall and on the widget, and nothing the household typed', () => {
    expect(styled.screen.customCss).toBe('.canvas .fw,.canvas.fw{padding:0}');
    const drawn = styled.layout.portrait.widgets[0];
    expect(drawn?.customCss).toBe('[data-widget-id="w1"] .clock,[data-widget-id="w1"].clock{color:#ff0000}');
    expect(JSON.stringify(styled)).not.toContain('.fw { padding: 0 }');
  });

  it('moves the ETag, so a wall picks the change up on its next poll', () => {
    expect(manifestEtag(styled)).not.toBe(manifestEtag(buildManifest(BASE)));
    const wallOnly = buildManifest({ ...BASE, screen: { ...BASE.screen!, customCss: wall.css } });
    expect(manifestEtag(wallOnly)).not.toBe(manifestEtag(styled));
  });
});
