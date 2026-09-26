import { describe, expect, it } from 'vitest';

import { haReadingHandle, type Manifest, type ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The Home Assistant readings on a panel.
 *
 * This exists because of a divergence found by rendering one and looking at it.
 * `display_mode` is a per-entity setting with four named shapes, and the panel
 * ignored it outright: every reading went through `drawPanel`'s tolerant reader
 * and came out as "label: value". So a reading the household set to `value`
 * said `Locked` on the wall and `Front door: Locked` on a panel — one stored
 * value, two renderers, two answers, which is the same fault as `shifts[0]`.
 *
 * The assertions are written so a renderer that ignores the mode fails them
 * rather than merely differing: each case is pinned to an equivalence against a
 * ladder written out by hand.
 */

const PANEL = { width: 520, height: 220 } as const;
const TODAY = '2026-08-22';

interface Reading {
  key: string;
  label: string;
  value: string;
  icon: string;
  mode: string;
}

/*
 * Every reading carries its handle, because the house panel mints one on each
 * since P1.3 and a widget's `readings` resolve to handles — a panel drawn by
 * this server never sees a reading without one. The fixture used to leave it
 * out, which was the whole shape then; the letter moved and the case each
 * test below asks about did not.
 */
const reading = (label: string, value: string, mode: string): Reading => ({
  key: haReadingHandle(`sensor.${label.toLowerCase().replace(/\W+/g, '_')}`),
  label,
  value,
  icon: 'x',
  mode,
});

function manifestOf(readings: readonly Reading[]): Manifest {
  const days: ManifestDay[] = [{ date: TODAY, shifts: [], events: [] } as unknown as ManifestDay];
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    panels: { home: { readings, fetchedAt: 1 } },
  } as unknown as Manifest;
}

function frameOf(
  manifest: Manifest,
  config: Record<string, unknown>,
  box: Partial<PlacedEpaperWidget> = {},
): Framebuffer {
  const widget: PlacedEpaperWidget = {
    type: 'homeassistant', x: 0, y: 0, w: 1, h: 1, z: 0, config, ...box,
  };
  return renderFreeformEpaper(buildEpaperModel(manifest), manifest, [widget], PANEL);
}

const bitsOf = (fb: Framebuffer): number[] => {
  const out: number[] = [];
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) out.push(fb.get(x, y) ? 1 : 0);
  }
  return out;
};

const door = reading('Front door', 'Locked', 'value');
const kitchen = reading('Kitchen', '19.4 C', 'label_value');
const garage = reading('Garage', 'Open', 'icon_state');

describe('the house widget on a panel', () => {
  it('honours the display mode the wall has always honoured', () => {
    /*
     * The divergence, stated as the thing that has to be true: a reading set to
     * `value` draws its value *alone*, which is the frame of a widget whose
     * ladder says exactly that. Before this, every mode drew "label: value" and
     * these two frames could not have matched.
     */
    expect(bitsOf(frameOf(manifestOf([door]), {}))).toEqual(
      bitsOf(frameOf(manifestOf([door]), { fields: ['value'] })),
    );
    // And it is not simply drawing the label-and-value shape for everything:
    // the same reading under `label_value` is a different frame.
    expect(bitsOf(frameOf(manifestOf([door]), {}))).not.toEqual(
      bitsOf(frameOf(manifestOf([reading('Front door', 'Locked', 'label_value')]), {}))
    );
  });

  it('reads each mode as its own shape, per reading and not per widget', () => {
    // Three readings, three modes, in one widget. Changing one entity's mode
    // must change the frame — the setting is per entity, and this is the panel
    // finally saying so.
    const mixed = bitsOf(frameOf(manifestOf([door, kitchen, garage]), {}));
    const flattened = bitsOf(
      frameOf(manifestOf([
        reading('Front door', 'Locked', 'label_value'),
        kitchen,
        garage,
      ]), {}),
    );
    expect(mixed).not.toEqual(flattened);
  });

  it('draws the label and value for a mode whose glyph a 1-bit font lacks', () => {
    /*
     * `icon_state` and `presence` are icon + label + value on the wall; the
     * panel's font is 0x20–0x7E and has no glyph, so the icon rung resolves to
     * nothing and the reading draws its label and value. Pinned as equal to
     * `label_value` rather than left to be discovered, because that *is* what a
     * household sees and it should be a decision rather than an accident.
     */
    expect(bitsOf(frameOf(manifestOf([garage]), {}))).toEqual(
      bitsOf(frameOf(manifestOf([reading('Garage', 'Open', 'label_value')]), {})),
    );
  });

  it('lets a widget’s own list win for every reading in it', () => {
    // The trade the household makes by writing one: per-entity shapes flatten.
    const listed = frameOf(manifestOf([door, kitchen, garage]), { fields: ['value'] });
    expect(bitsOf(listed)).toEqual(
      bitsOf(
        frameOf(
          manifestOf([
            reading('Front door', 'Locked', 'value'),
            reading('Kitchen', '19.4 C', 'value'),
            reading('Garage', 'Open', 'value'),
          ]),
          {},
        ),
      ),
    );
    expect(bitsOf(listed)).not.toEqual(bitsOf(frameOf(manifestOf([door, kitchen, garage]), {})));
  });

  it('draws the parts in the order the household chose', () => {
    expect(bitsOf(frameOf(manifestOf([kitchen]), { fields: ['value', 'label'] }))).not.toEqual(
      bitsOf(frameOf(manifestOf([kitchen]), { fields: ['label', 'value'] })),
    );
  });

  it('shows only the readings the widget asked for', () => {
    const filtered = frameOf(manifestOf([door, kitchen, garage]), { readings: ['Kitchen'] });
    expect(bitsOf(filtered)).toEqual(bitsOf(frameOf(manifestOf([kitchen]), {})));
  });

  /**
   * P5.3 gave every reading a `tone` and a `changedAt` for the tile look, and
   * took the panel's `fetchedAt` away. The list draws none of the three, so
   * adding the first two and removing the third must leave this frame exactly
   * as it was — bit for bit, with a glyph drawn and without.
   */
  it('draws the same frame whether or not a reading carries a tone and when it changed', () => {
    const plain = [
      { label: 'Front door', value: 'Locked', mode: 'icon_state', glyph: 'lock' },
      { label: 'Kitchen', value: '19.4 C', mode: 'label_value', glyph: 'temperature' },
    ];
    const toned = plain.map((entry, index) => ({
      ...entry,
      tone: index === 0 ? 'alert' : null,
      changedAt: 1_787_000_000_000 + index,
    }));
    const before = manifestOf(plain as unknown as Reading[]);
    const after = manifestOf(toned as unknown as Reading[]);
    (after as unknown as { panels: Record<string, unknown> }).panels = { home: { readings: toned, note: null } };
    for (const config of [{}, { fields: ['icon', 'label', 'value'] }, { fields: ['value'] }]) {
      expect(bitsOf(frameOf(after, config))).toEqual(bitsOf(frameOf(before, config)));
    }
  });

  it('draws the five new marks, one each and none the same', () => {
    // `icon_state` leads with the mark, so a frame per glyph differs only by
    // the drawing — which is what says each of them reaches the glass at all.
    const frames = ['light', 'switch', 'fan', 'cover', 'thermostat', 'lock'].map((glyph) =>
      bitsOf(frameOf(manifestOf([{ label: 'Thing', value: 'On', mode: 'icon_state', glyph } as unknown as Reading]), {})),
    );
    const none = bitsOf(frameOf(manifestOf([{ label: 'Thing', value: 'On', mode: 'icon_state' } as unknown as Reading]), {}));
    for (const frame of frames) expect(frame).not.toEqual(none);
    expect(new Set(frames.map((frame) => frame.join(''))).size).toBe(frames.length);
  });

  it('says so plainly when there is nothing to read', () => {
    const empty = bitsOf(frameOf(manifestOf([]), {}));
    expect(bitsOf(frameOf(manifestOf([kitchen]), { readings: ['Nobody'] }))).toEqual(empty);
    // A panel of the wrong shape is the same "not yet", never a crash and never
    // a line of internals.
    const wrong = manifestOf([kitchen]) as unknown as { panels: Record<string, unknown> };
    wrong.panels = { home: { fetchedAt: 1 } };
    expect(bitsOf(frameOf(wrong as unknown as Manifest, {}))).toEqual(empty);
  });
});
