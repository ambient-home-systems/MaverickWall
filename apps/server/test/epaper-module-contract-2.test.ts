import { describe, expect, it } from 'vitest';

import type { Manifest } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { bitString } from './epaper-frame.js';
import { decodePixels } from './qr-decode.js';

/**
 * Contract 2's QR code, countdown, timeline and picture on one bit (plan item
 * M7.5).
 *
 * A panel shows one picture for up to an hour, so a countdown says when and a
 * timeline lists what is still to come, worked out at the frame's own time —
 * which is held by drawing the same frame as the plain rows a module could
 * have sent with those words, byte for byte. The code is read back by an
 * independent decoder; the picture is never drawn (MQ11), only its caption.
 */

const PANEL = { width: 800, height: 480 } as const;
const GENERATED = Date.UTC(2026, 9, 14, 10, 0); // Wednesday 14 October, 11:00 in London.

function manifestWith(panel: unknown, at = GENERATED): Manifest {
  return {
    timezone: 'Europe/London',
    generatedAt: at,
    window: { from: '2026-10-01', to: '2026-11-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [],
    sources: [],
    panels: { 'ext:mod': panel },
  } as unknown as Manifest;
}

function frame(panel: unknown, at = GENERATED, h = 0.6): Framebuffer {
  const manifest = manifestWith(panel, at);
  const widget: PlacedEpaperWidget = { type: 'external', x: 0.05, y: 0.05, w: 0.9, h, z: 0, config: { module: 'mod' } };
  return renderFreeformEpaper(buildEpaperModel(manifest), manifest, [widget], PANEL);
}

const bits = (panel: unknown, at = GENERATED): string => bitString(frame(panel, at));

function decode(fb: Framebuffer): string | undefined {
  const data = new Uint8ClampedArray(PANEL.width * PANEL.height * 4).fill(255);
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) {
      if (!fb.get(x, y)) continue;
      const at = (y * PANEL.width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }
  return decodePixels(data, PANEL.width, PANEL.height);
}

describe('contract 2 on a panel', () => {
  it('draws a module’s code that a phone reads back as the module’s text', () => {
    const text = 'WIFI:T:WPA;S:Guest;P:correct-horse;;';
    expect(decode(frame({ kind: 'qr', text, label: 'Guest Wi-Fi' }))).toBe(text);
    expect(decode(frame({ kind: 'qr', text: 'https://example.com/a' }))).toBe('https://example.com/a');
    // The label is words under the code, and a different one is a different frame.
    expect(bits({ kind: 'qr', text, label: 'Guest Wi-Fi' })).not.toBe(bits({ kind: 'qr', text }));
  });

  it('says when a countdown is, the same frame as the line a module could have sent', () => {
    const countdown = { kind: 'countdown', label: 'Bins', at: '2026-10-16T06:00:00Z' };
    expect(bits(countdown)).toBe(bits({ kind: 'readings', items: [{ label: 'Bins', value: 'Fri 16 Oct 07:00' }] }));
    // The same frame ten minutes later: a panel is not redrawn to count down.
    expect(bits(countdown, GENERATED + 10 * 60_000)).toBe(bits(countdown));
    // Past its instant, it says since when.
    expect(bits(countdown, Date.UTC(2026, 9, 17))).toBe(
      bits({ kind: 'readings', items: [{ label: 'Bins', value: 'since Fri 16 Oct 07:00' }] }),
    );
  });

  it('lists what is still to come on a timeline, the time alone today and the weekday otherwise', () => {
    const timeline = {
      kind: 'timeline',
      items: [
        { at: '2026-10-14T08:00:00Z', label: 'School run' },
        { at: '2026-10-14T13:00:00Z', label: 'Dentist', detail: 'Dr Smith', tone: 'alert' },
        { at: '2026-10-15T06:00:00Z', label: 'Bins' },
      ],
    };
    expect(bits(timeline)).toBe(
      bits({ kind: 'readings', items: ['! 14:00 Dentist - Dr Smith', 'Thu 07:00 Bins'] }),
    );
    expect(bits(timeline, Date.UTC(2026, 9, 16))).toBe(bits({ kind: 'readings', items: ['Nothing more to come'] }));
  });

  it('draws no picture, only the box’s words, so the frame does not change with the picture', () => {
    const one = bits({ kind: 'image', image: `${'a'.repeat(64)}.jpg`, caption: 'Rain at 14:00' });
    expect(one).toBe(bits({ kind: 'image', image: `${'b'.repeat(64)}.jpg`, caption: 'Rain at 14:00' }));
    expect(one).not.toBe(bits({ kind: 'image', image: `${'a'.repeat(64)}.jpg`, caption: 'Dry all day' }));
    // Not the tolerant reader's dump of the panel's fields.
    expect(one).not.toBe(bits({ items: ['kind: image', 'caption: Rain at 14:00'] }));
  });
});
