import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { EPAPER_RENDERER_VERSION } from '../src/epaper/frame.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The clock's three variants on one bit (RFC 014 §4.2), decoded.
 *
 * The honours tables say `variant` is honoured by a panel's clock, and
 * `epaper-ink.test.ts` proves that much by rendering: set it, and ink moves.
 * What that cannot say is the other half of shipping a variant to a panel
 * that is already hanging — that **plain is the clock the panel always drew**,
 * to the byte, whether the key is absent or spelled out. A stored canvas holds
 * no `variant` today, so an absent one must draw exactly what it drew before
 * the key existed, and that is why `EPAPER_RENDERER_VERSION` did not move.
 *
 * So the plain frames are pinned to hashes rendered **on a clean worktree of
 * `main` at 38ace88**, the commit this landed on, before the key existed — not
 * from this tree against itself, which would agree with whatever it drew. Four
 * configs at three panel sizes and three box shapes, because the clock's rung
 * is picked from its box and a single full-panel case would say nothing about
 * a narrow column or a 13.3" panel's ladder.
 */

const TIMEZONE = 'Europe/London';
/** 11:00 in London on the fixture's day — `HARNESS_HOUR`, on a panel. */
const AT = Date.UTC(2026, 8, 23, 10, 0, 0);

function manifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 23; d <= 27; d++) {
    days.push({ date: `2026-09-${d}`, shifts: [], events: [] } as unknown as ManifestDay);
  }
  return {
    timezone: TIMEZONE,
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

/** A whole 7.5" panel, a narrow column on a 13.3" one, and a strip on a portrait 7.5". */
const CASES: Readonly<Record<string, Case>> = {
  '800x480 whole': { panel: { width: 800, height: 480 }, box: { x: 0, y: 0, w: 1, h: 1 } },
  '1872x1404 column': { panel: { width: 1872, height: 1404 }, box: { x: 0.05, y: 0.1, w: 0.3, h: 0.25 } },
  '480x800 strip': { panel: { width: 480, height: 800 }, box: { x: 0, y: 0, w: 1, h: 0.2 } },
};

const PLAIN_CONFIGS: Readonly<Record<string, Record<string, unknown>>> = {
  bare: {},
  'no date': { showDate: false },
  '12-hour': { clockFormat: '12' },
  centred: { align: 'center' },
};

function frame(config: Record<string, unknown>, which: Case): string {
  const widget: PlacedEpaperWidget = { type: 'clock', ...which.box, z: 0, config };
  const fb = renderFreeformEpaper(MODEL, M, [widget], which.panel);
  let bits = '';
  for (let y = 0; y < which.panel.height; y++) {
    for (let x = 0; x < which.panel.width; x++) bits += fb.get(x, y) ? '1' : '0';
  }
  return bits;
}

const sha = (bits: string): string => createHash('sha256').update(bits).digest('hex');

/**
 * Rendered on a clean worktree of `main` at 38ace88, with no `variant` key in
 * any schema or renderer — see the file's docstring.
 */
const MAIN_HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '800x480 whole': {
    bare:
      '9a6ccfa52fa5113a4c178a00b586e1ec5ff95f276dcbc853bfc1068394402bca',
    'no date':
      'c3df1c54435bb362542d313c89a0e39a67566f011cadd64716f1ea1e40d60258',
    '12-hour':
      'e1e07023fdf52f030084fcad0a105092cd9c2f977ade73c15c938c39e35c837c',
    centred:
      'ac12e1fe0c355f36469ec9795afc8fabbbad80660255c7553a6b99394565249d',
  },
  '1872x1404 column': {
    bare:
      '31c352b9b626343cda7a74ffc8ed740c591c0d3a9158da910406cbc3dab01085',
    'no date':
      'f9a9ef533a8106c5dc9982fdf66bc0e0aa2ba4eff5b3e7275137f98353b51227',
    '12-hour':
      '1220331438e8a9f7003616badcb10933867796fe1661a5ae0a90865bff9b4295',
    centred:
      'c957dd96d5345d5c7b5d29840af611859df98fbd75f959268c9d3131716c9725',
  },
  '480x800 strip': {
    bare:
      'e9e98e58be173cbfb9eae4652581cfaf985780765b7aa86b464b240ae978b603',
    'no date':
      'da59dc7f7c1b20e463b10dfc370add39e40891bb48511b7a34d031aa921f1399',
    '12-hour':
      '43e79fbe322b854b36de3f7c563b421fd68a7f79cb7bd0dd4f8bd952d2796f42',
    centred:
      'bcc614b58f88181b8f0217555984b66068f21e754de511423c0b8d8fd9747887',
  },
};

describe('plain is the clock a panel always drew', () => {
  for (const [name, which] of Object.entries(CASES)) {
    for (const [label, config] of Object.entries(PLAIN_CONFIGS)) {
      it(`${name}, ${label}: absent and "plain" both draw main's bytes`, () => {
        const expected = MAIN_HASHES[name]?.[label];
        expect(sha(frame(config, which))).toBe(expected);
        expect(sha(frame({ ...config, variant: 'plain' }, which))).toBe(expected);
      });
    }
  }

  it('reads a variant belonging to another widget as plain — "not for me"', () => {
    // `variant` is one enum for every type. A value the clock does not draw
    // cannot reach it today (the schema lists only the clock's), but a row
    // from a newer server can, and it must draw the clock's default rather
    // than nothing.
    const which = CASES['800x480 whole']!;
    expect(frame({ variant: 'strip' }, which)).toBe(frame({}, which));
  });

  it('did not need the renderer version to move', () => {
    // Nothing stored carries a variant yet, so no panel's pixels change on
    // upgrade — which is the only thing the version is for.
    expect(EPAPER_RENDERER_VERSION).toBe(9);
  });
});

describe('the other two are different drawings', () => {
  for (const [name, which] of Object.entries(CASES)) {
    it(`${name}: stacked and analogue each draw something plain does not`, () => {
      const plain = frame({}, which);
      const stacked = frame({ variant: 'stacked' }, which);
      const analogue = frame({ variant: 'analogue' }, which);
      expect(stacked, 'stacked drew the plain clock').not.toBe(plain);
      expect(analogue, 'analogue drew the plain clock').not.toBe(plain);
      expect(analogue, 'analogue drew the stacked clock').not.toBe(stacked);
      expect(analogue.includes('1'), 'analogue drew nothing at all').toBe(true);
    });
  }

  it('stacks the weekday and the date on lines of their own', () => {
    // Rows of ink, counted as bands: plain is the digits and one date line,
    // stacked the digits and two — the drawing the variant is named for,
    // rather than merely a different one.
    const which = CASES['800x480 whole']!;
    const bands = (bits: string): number => {
      let count = 0;
      let inBand = false;
      // Inside the widget's own hairline outline, which inks every edge.
      for (let y = 2; y < which.panel.height - 2; y++) {
        const row = bits.slice(y * which.panel.width + 2, (y + 1) * which.panel.width - 2);
        const inked = row.includes('1');
        if (inked && !inBand) count++;
        inBand = inked;
      }
      return count;
    };
    expect(bands(frame({}, which))).toBe(2);
    expect(bands(frame({ variant: 'stacked' }, which))).toBe(3);
  });

  it('draws the face at the box’s short side, square and centred', () => {
    const which = CASES['1872x1404 column']!;
    const bits = frame({ variant: 'analogue' }, which);
    const { width, height } = which.panel;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    // The widget's own outline is a hairline round the box; the face is
    // measured inside it.
    const left = Math.round(which.box.x * width) + 3;
    const right = Math.round((which.box.x + which.box.w) * width) - 3;
    const top = Math.round(which.box.y * height) + 3;
    const bottom = Math.round((which.box.y + which.box.h) * height) - 3;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (bits[y * width + x] !== '1') continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const faceW = maxX - minX + 1;
    const faceH = maxY - minY + 1;
    const short = Math.min(right - left, bottom - top);
    expect(Math.abs(faceW - faceH), `the face is ${faceW}x${faceH}`).toBeLessThanOrEqual(2);
    expect(faceH / short, `the face is ${faceH}px in a ${short}px short side`).toBeGreaterThan(0.85);
    const centreX = (minX + maxX) / 2;
    expect(Math.abs(centreX - (left + right) / 2), 'the face is not centred across its box').toBeLessThanOrEqual(3);
  });
});
