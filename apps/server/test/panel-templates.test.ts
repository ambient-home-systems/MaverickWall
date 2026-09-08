import { describe, expect, it } from 'vitest';

import { PANEL_TEMPLATES, findPanelTemplate, TEMPLATES } from '../src/templates/index.js';
import { templateSchema } from '../src/api/templates.js';
import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The e-paper panel's own starting layouts.
 *
 * A panel used to be handed the *wall* gallery, and every card in it was wrong
 * about the thing it previewed: thirteen colour arrangements on a portrait 9:16
 * canvas, offered to an 800x480 black-and-white device, each captioned with a
 * theme it does not have. The one arrangement its household had actually seen —
 * the built-in view the panel draws out of the box — was not among them, so the
 * layout somebody wanted to start from was the only one they could not.
 *
 * `templates.test.ts` next door validates the wall list against
 * `templateSchema`; this file does the same for the panel list and then asserts
 * the four narrowings that make a panel card a panel card. Each is a property
 * rather than a convention, because a convention is what a future contributor
 * adds a card past — the panel list is precisely where somebody will one day
 * paste a wall template and change the id.
 */

// ---------------------------------------------------------------------------
// A fixture panel with something on it
// ---------------------------------------------------------------------------

/**
 * A household's day, for the ink assertions below.
 *
 * Real-ish rather than minimal: a card that renders ink for an *empty* calendar
 * proves nothing about a card that has to draw one, and "the frame is not
 * blank" is the whole claim these make.
 */
function manifest(): Manifest {
  const days: ManifestDay[] = [
    {
      date: '2026-08-13',
      events: [
        { title: 'Swimming lesson', startsAt: '2026-08-13T07:30:00Z', allDay: false },
        { title: 'Assembly', startsAt: '2026-08-13T09:15:00Z', allDay: false },
      ],
    },
    {
      date: '2026-08-14',
      events: [{ title: 'Bin day', startsAt: '2026-08-14T00:00:00Z', allDay: true }],
    },
  ] as unknown as ManifestDay[];
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 8, 42, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    panels: {},
  } as unknown as Manifest;
}

/** The panel sizes this project supports, as (width, height) in pixels. */
const PANELS = [
  { w: 640, h: 384 },
  { w: 800, h: 480 },
  { w: 1304, h: 984 },
  { w: 1872, h: 1404 },
  { w: 480, h: 800 },
  { w: 1404, h: 1872 },
] as const;

function place(widgets: readonly { type: string; x: number; y: number; w: number; h: number }[]): PlacedEpaperWidget[] {
  return widgets.map((widget, index) => ({
    ...widget,
    z: index,
    config: (widget as { config?: Record<string, unknown> }).config ?? {},
  })) as PlacedEpaperWidget[];
}

function inkCount(w: number, h: number, widgets: readonly PlacedEpaperWidget[]): number {
  const model = buildEpaperModel(manifest());
  const fb = renderFreeformEpaper(model, manifest(), widgets, { width: w, height: h });
  let lit = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fb.get(x, y)) lit++;
  return lit;
}

// ---------------------------------------------------------------------------

describe('the panel template catalogue', () => {
  it('validates through the same schema a wall template does', () => {
    // The whole safety story, unchanged: a panel card can place no widget type
    // a household could not place by hand and set no option the editor cannot.
    for (const template of PANEL_TEMPLATES) {
      expect(() => templateSchema.parse(template), template.id).not.toThrow();
    }
  });

  it('is a separate list from the wall gallery, with no id in common', () => {
    // The split has to be real in the data, not only in the page that renders
    // it: the apply route looks a panel's id up in this list alone, so an id
    // appearing in both would be the one hole in that.
    const wall = new Set(TEMPLATES.map((t) => t.id));
    for (const template of PANEL_TEMPLATES) {
      expect(wall.has(template.id), `${template.id} is in both catalogues`).toBe(false);
    }
    expect(new Set(PANEL_TEMPLATES.map((t) => t.id)).size).toBe(PANEL_TEMPLATES.length);
  });

  it('leads with Blank, then the panel’s own built-in view', () => {
    /*
     * Two cards, two gaps, and the order between them moved once.
     *
     * Built-in closes the gap this list was created for: a household who liked
     * what their panel drew and wanted the month a little larger had to rebuild
     * it from nothing, because the first widget dropped on an empty canvas
     * replaced the built-in layout wholesale and no card resembled it. It led
     * the list on the argument that the card somebody has already seen should
     * not need scrolling to.
     *
     * Blank leads now, and closes the other one: every card was somebody else's
     * arrangement, so building your own meant picking the nearest and deleting
     * its boxes. Built-in's gap is closed by the card *existing* rather than by
     * its position, and on a panel's add page neither is the default anyway —
     * that is `builtin`, the real fixed renderer, which is not a template.
     */
    expect(PANEL_TEMPLATES[0]?.id).toBe('panel-blank');
    expect(PANEL_TEMPLATES[1]?.id).toBe('panel-built-in');
    expect(findPanelTemplate('panel-built-in')).toBeDefined();
    expect(findPanelTemplate('panel-blank')).toBeDefined();

    // And it is the built-in layout's own shape rather than a fresh guess: the
    // agenda takes the larger share of a landscape panel, which is
    // `epaperBlocks`' 0.54 split and the reason for it (titles need width more
    // than a grid does).
    const land = PANEL_TEMPLATES[1]!.landscape.widgets;
    const agenda = land.find((w) => (w.config as { mode?: string } | undefined)?.mode === 'list');
    const month = land.find((w) => (w.config as { mode?: string } | undefined)?.mode === 'month');
    expect(agenda?.w).toBeCloseTo(0.54, 2);
    expect(month?.w).toBeCloseTo(0.46, 2);
    expect(agenda?.x).toBeLessThan(month?.x ?? 0);
  });

  it('names no theme and no background — a panel has neither', () => {
    /*
     * The fault the wall gallery had on a panel, stated as a property.
     *
     * Every wall card but Classic declares a theme, and the gallery draws
     * "Looks best in Paper Almanac — change it after" from it. On a panel that
     * sentence is about a control that does not exist, which is this project's
     * oldest recurring bug in its purest form: an option that does nothing is
     * worse than an option not offered.
     */
    for (const template of PANEL_TEMPLATES) {
      expect(template.theme, `${template.id} declares a theme`).toBeUndefined();
      expect(template.portrait.background, `${template.id} portrait`).toBeUndefined();
      expect(template.landscape.background, `${template.id} landscape`).toBeUndefined();
    }
  });

  it('sets no colour, corner or shadow option on any widget', () => {
    /*
     * The same rule one level down. A 1-bit frame has one ground and one ink;
     * a card shipping `background: '#112233'` would be storing a value the
     * device cannot honour on every panel started from it — and the design
     * page's own intro promises the opposite in as many words ("Colour,
     * gradient and shadow options do not apply on e-paper").
     */
    for (const template of PANEL_TEMPLATES) {
      for (const canvas of [template.portrait, template.landscape]) {
        for (const widget of canvas.widgets) {
          const config = (widget.config ?? {}) as Record<string, unknown>;
          for (const key of ['background', 'opacity', 'corners', 'shadow']) {
            expect(config[key], `${template.id} ${widget.type}.${key}`).toBeUndefined();
          }
        }
      }
    }
  });

  it('authors both orientations, so a panel turned sideways is never letterboxed', () => {
    for (const template of PANEL_TEMPLATES) {
      /*
       * The wall catalogue's rule, in the same words: the fault this guards
       * against is a card that places boxes in one orientation and not the
       * other, so it asks the two canvases to *agree* rather than asking each
       * to be non-empty. Blank is empty in both, deliberately, and naming it as
       * an exception would have made this the weaker test.
       */
      expect(
        template.portrait.widgets.length > 0,
        `${template.id}: one orientation is empty and the other is not`,
      ).toBe(template.landscape.widgets.length > 0);
      expect(template.portrait.aspect, `${template.id} portrait aspect`).toBeGreaterThan(0);
      expect(template.landscape.aspect, `${template.id} landscape aspect`).toBeGreaterThan(0);
    }
  });

  it('tiles its canvas: every box is inside it, and none is a sliver', () => {
    /*
     * `classic.ts`'s rule, applied here. A box reaching past the canvas is
     * drawn clipped by the renderer and reads as a fault; a box a couple of
     * per cent tall is a widget that can never draw anything and so is a hole
     * with a name on it.
     */
    for (const template of PANEL_TEMPLATES) {
      for (const canvas of [template.portrait, template.landscape]) {
        for (const widget of canvas.widgets) {
          expect(widget.x, `${template.id} ${widget.type}.x`).toBeGreaterThanOrEqual(0);
          expect(widget.y, `${template.id} ${widget.type}.y`).toBeGreaterThanOrEqual(0);
          expect(widget.x + widget.w, `${template.id} ${widget.type} right edge`).toBeLessThanOrEqual(1.0001);
          expect(widget.y + widget.h, `${template.id} ${widget.type} bottom edge`).toBeLessThanOrEqual(1.0001);
          expect(widget.w * widget.h, `${template.id} ${widget.type} area`).toBeGreaterThan(0.02);
        }
      }
    }
  });

  it('draws real ink on every supported panel, in both orientations', () => {
    /*
     * The assertion that would have caught a card authored against a shape
     * nobody rendered.
     *
     * The frames are decoded rather than reasoned about — the QR rule, and the
     * reason `epaper-ink.test.ts` renders instead of reading tables. A card
     * whose boxes are legal and whose frame is blank is a card that looks
     * finished in the source and is an empty panel in a kitchen.
     *
     * The Chores card is exempt and that is deliberate rather than convenient:
     * `keepWidgetsWithSomethingToSay` drops a widget with nothing behind it and
     * this fixture defines no chores, so its board is legitimately empty. Its
     * *calendar* still has to draw, which is what is checked instead — an
     * exemption that excused the whole card would excuse a broken one.
     */
    for (const template of PANEL_TEMPLATES) {
      for (const { w, h } of PANELS) {
        const portrait = h > w;
        const canvas = portrait ? template.portrait : template.landscape;
        const widgets = place(
          template.id === 'panel-chores'
            ? canvas.widgets.filter((one) => one.type !== 'chores')
            : canvas.widgets,
        );
        const lit = inkCount(w, h, widgets);
        expect(lit, `${template.id} at ${w}x${h} drew nothing`).toBeGreaterThan(0);
        // And not a solid block, which is what a widget filling its box with
        // ink looks like and is how a renderer fault reads from a count alone.
        expect(lit, `${template.id} at ${w}x${h} is solid ink`).toBeLessThan(w * h * 0.5);
      }
    }
  });
});
