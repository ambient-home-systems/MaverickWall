import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { qrPayload } from '../src/api/qr-payload.js';
import { encodeQr } from '../src/http/qr.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { decodePixels } from './qr-decode.js';

/**
 * A QR code on one bit (plan item M5.3), read back by decoding the frame.
 *
 * One bit is what a code is made of, so a panel is a natural place for one —
 * and "the frame changed when the network changed" says nothing about whether
 * a phone can read it. So every assertion here hands the panel's own pixels to
 * an independent decoder and asks what the code says, at three panel sizes and
 * three box shapes, and then holds the parts that make a code readable to what
 * a scanner needs: whole pixels a module, two at least, and the quiet zone
 * clear of everything else on the panel.
 */

const AT = Date.UTC(2026, 8, 23, 10, 0, 0);

function manifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 23; d <= 27; d++) days.push({ date: `2026-09-${d}`, shifts: [], events: [] } as unknown as ManifestDay);
  return {
    timezone: 'Europe/London',
    generatedAt: AT,
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [],
    panels: {},
  } as unknown as Manifest;
}

const M = manifest();
const MODEL = buildEpaperModel(M);

interface Case {
  readonly panel: { readonly width: number; readonly height: number };
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

const CASES: Readonly<Record<string, Case>> = {
  '800x480 whole': { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 1, h: 1 } },
  '1872x1404 column': { panel: { width: 1872, height: 1404 }, box: { x: 0.05, y: 0.1, w: 0.3, h: 0.4 } },
  '480x800 strip': { panel: { width: 480, height: 800 }, box: { x: 0, y: 0.5, w: 1, h: 0.3 } },
};

const CONFIGS: Readonly<Record<string, Record<string, unknown>>> = {
  wifi: { ssid: 'Guests', wifiPassword: 'welcome-in' },
  'long wifi': { ssid: 'The Long Family Guest Network 5G', wifiPassword: 'a-much-longer-password-for-visitors-2026' },
  link: { mode: 'link', link: 'https://example.com/menu' },
  text: { mode: 'text', text: 'Café door code 4821 — ring twice' },
};

function render(config: Record<string, unknown>, which: Case, extra: Partial<PlacedEpaperWidget> = {}): Framebuffer {
  const widget: PlacedEpaperWidget = { type: 'qr', ...which.box, z: 0, config, ...extra };
  return renderFreeformEpaper(MODEL, M, [widget], which.panel);
}

/** The frame as the RGBA a camera would hand a decoder: ink black, paper white. */
function decodeFrame(fb: Framebuffer, panel: Case['panel']): string | undefined {
  const data = new Uint8ClampedArray(panel.width * panel.height * 4).fill(255);
  for (let y = 0; y < panel.height; y++) {
    for (let x = 0; x < panel.width; x++) {
      if (!fb.get(x, y)) continue;
      const at = (y * panel.width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }
  return decodePixels(data, panel.width, panel.height);
}

/** The run of ink along one row, as [start, end) pairs. */
function inkRuns(fb: Framebuffer, y: number, from: number, to: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = from; x <= to; x++) {
    const on = x < to && fb.get(x, y);
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Where the code's top-left finder starts, or undefined when the frame holds
 * nothing shaped like a code: the first row with a run of ink seven modules
 * wide and another run ending exactly the code's width further on, which is
 * the top row of the two upper finders. The widget's hairline frame is a run
 * of its own, so it is stepped over rather than mistaken for the code's edge.
 */
function findCode(
  fb: Framebuffer,
  panel: Case['panel'],
  modules: number,
): { x: number; y: number; scale: number } | undefined {
  for (let y = 0; y < panel.height; y++) {
    const runs = inkRuns(fb, y, 0, panel.width);
    for (const [start, end] of runs) {
      const width = end - start;
      if (width % 7 !== 0) continue;
      const scale = width / 7;
      if (runs.some(([, stop]) => stop === start + modules * scale)) return { x: start, y, scale };
    }
  }
  return undefined;
}

function finder(fb: Framebuffer, panel: Case['panel'], modules: number): { x: number; y: number; scale: number } {
  const at = findCode(fb, panel, modules);
  if (at === undefined) throw new Error('no finder pattern in the frame');
  return at;
}

describe('a QR code on a panel', () => {
  for (const [name, which] of Object.entries(CASES)) {
    for (const [kind, config] of Object.entries(CONFIGS)) {
      it(`reads back as exactly its payload: ${kind}, ${name}`, () => {
        const fb = render(config, which);
        expect(decodeFrame(fb, which.panel)).toBe(qrPayload(config));
      });
    }

    it(`draws whole pixels a module, at least two, with its quiet zone clear: ${name}`, () => {
      const config = CONFIGS['long wifi'] as Record<string, unknown>;
      const fb = render({ ...config, showPassword: true, title: 'Wi-Fi', showTitle: true }, which);
      const matrix = encodeQr(qrPayload(config) as string)!;
      const at = finder(fb, which.panel, matrix.size);
      expect(at.scale).toBeGreaterThanOrEqual(2);
      expect(Number.isInteger(at.scale)).toBe(true);
      // Module for module, the panel's ink is the encoder's matrix.
      for (let row = 0; row < matrix.size; row++) {
        for (let column = 0; column < matrix.size; column++) {
          const on = fb.get(at.x + column * at.scale + 1, at.y + row * at.scale + 1);
          expect(on, `module ${row},${column}`).toBe((matrix.modules[row] as boolean[])[column]);
        }
      }
      // Four modules of paper all round: nothing else on the panel inks them.
      const quiet = 4 * at.scale;
      const side = matrix.size * at.scale;
      for (let y = at.y - quiet; y < at.y + side + quiet; y++) {
        for (let x = at.x - quiet; x < at.x + side + quiet; x++) {
          const inCode = y >= at.y && y < at.y + side && x >= at.x && x < at.x + side;
          if (!inCode) expect(fb.get(x, y), `quiet zone at ${x},${y}`).toBe(false);
        }
      }
    });
  }

  it('writes the password under the code only when asked, and the code says the same either way', () => {
    const which = CASES['800x480 whole'] as Case;
    const config = CONFIGS['wifi'] as Record<string, unknown>;
    const plain = render(config, which);
    const told = render({ ...config, showPassword: true }, which);
    expect(decodeFrame(told, which.panel)).toBe(decodeFrame(plain, which.panel));
    const ink = (fb: Framebuffer): number => {
      let count = 0;
      for (let y = 0; y < which.panel.height; y++) for (let x = 0; x < which.panel.width; x++) if (fb.get(x, y)) count++;
      return count;
    };
    // The words cost the code some size, and add a line of ink under it.
    expect(ink(told)).not.toBe(ink(plain));
  });

  it('gives the words up before a module would go under two pixels, and still reads at every height', () => {
    const panel = { width: 800, height: 480 };
    const config = { ...(CONFIGS['long wifi'] as Record<string, unknown>), showPassword: true };
    const matrix = encodeQr(qrPayload(config) as string)!;
    let decoded = 0;
    for (let height = 60; height <= 400; height += 4) {
      const which: Case = { panel, box: { x: 0, y: 0, w: 1, h: height / panel.height } };
      const fb = render(config, which);
      const read = decodeFrame(fb, panel);
      if (read !== undefined) {
        expect(read).toBe(qrPayload(config));
        expect(finder(fb, panel, matrix.size).scale).toBeGreaterThanOrEqual(2);
        decoded++;
        continue;
      }
      // No code read means no code drawn at all — never one too small to scan.
      expect(findCode(fb, panel, matrix.size), `a ${height}px box drew a code nobody can read`).toBeUndefined();
    }
    // Most of the sweep has room for a code, and every one that drew one reads.
    expect(decoded).toBeGreaterThan(60);
    /*
     * And the code was drawn where only the words were in the way. At the
     * shortest box that reads, the name and the password are both gone: a code
     * that kept them would have needed a taller box, so "no code" there would
     * have been the words winning over the thing the widget is for.
     */
    const shortest = Array.from({ length: 86 }, (_, step) => 60 + step * 4).find((height) => {
      const which: Case = { panel, box: { x: 0, y: 0, w: 1, h: height / panel.height } };
      return decodeFrame(render(config, which), panel) !== undefined;
    }) as number;
    const fb = render(config, { panel, box: { x: 0, y: 0, w: 1, h: shortest / panel.height } });
    const at = finder(fb, panel, matrix.size);
    const below = at.y + (matrix.size + 4) * at.scale;
    let words = 0;
    for (let y = below; y < shortest - 2; y++) {
      for (let x = 4; x < panel.width - 4; x++) if (fb.get(x, y)) words++;
    }
    expect(words, `the ${shortest}px box kept its words under a code`).toBe(0);
  });

  it('says why there is no code, rather than drawing an empty box', () => {
    const which = CASES['800x480 whole'] as Case;
    for (const config of [{}, { ssid: 'Guests' }, { mode: 'link' }]) {
      const fb = render(config, which);
      expect(decodeFrame(fb, which.panel)).toBeUndefined();
      let ink = 0;
      for (let y = 0; y < which.panel.height; y++) for (let x = 0; x < which.panel.width; x++) if (fb.get(x, y)) ink++;
      expect(ink).toBeGreaterThan(0);
    }
  });
});
