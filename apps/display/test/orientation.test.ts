import { describe, expect, it } from 'vitest';
import {
  canvasFor,
  geometryFor,
  normaliseOrientation,
  normaliseRotation,
  physicalScreenFrom,
  pxPerArcminute,
  resolveLayout,
} from '../src/orientation.js';

/**
 * Rotation and orientation, which are easy to conflate and mean different
 * things: one is how the panel is hung, the other is which layout to draw.
 * The relationship between them — a turned widescreen is a portrait canvas —
 * is the whole reason this is a pure function rather than a media query.
 */

const TV = { width: 1920, height: 1080 };
const TABLET = { width: 1080, height: 1920 };

describe('normalising what the database holds', () => {
  it('accepts only quarter turns', () => {
    expect(normaliseRotation(0)).toBe(0);
    expect(normaliseRotation(90)).toBe(90);
    expect(normaliseRotation(270)).toBe(270);
  });

  it('wraps a turn that has gone round, and reads a negative one the short way', () => {
    expect(normaliseRotation(360)).toBe(0);
    expect(normaliseRotation(450)).toBe(90);
    // -90 is 270. A household typing that means "the other way".
    expect(normaliseRotation(-90)).toBe(270);
  });

  it('falls back rather than throwing on nonsense', () => {
    // A hand-edited row must not be able to stop a wall drawing.
    expect(normaliseRotation('sideways')).toBe(0);
    expect(normaliseRotation(undefined)).toBe(0);
    expect(normaliseRotation(Number.NaN)).toBe(0);
    expect(normaliseOrientation('diagonal')).toBe('auto');
    expect(normaliseOrientation(undefined)).toBe('auto');
    expect(normaliseOrientation('portrait')).toBe('portrait');
  });

  it('snaps a near-miss to the turn that was meant', () => {
    expect(normaliseRotation(89)).toBe(90);
    expect(normaliseRotation(181)).toBe(180);
  });
});

describe('the canvas a quarter turn produces', () => {
  it('swaps the axes on 90 and 270, and leaves them alone otherwise', () => {
    expect(canvasFor(TV, 90)).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor(TV, 270)).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor(TV, 180)).toEqual(TV);
    expect(canvasFor(TV, 0)).toEqual(TV);
  });
});

describe('which layout to draw', () => {
  it('follows the screen when nothing is pinned', () => {
    expect(resolveLayout(TV, 0, 'auto')).toBe('landscape');
    expect(resolveLayout(TABLET, 0, 'auto')).toBe('portrait');
  });

  it('gives a rotated widescreen the portrait wall', () => {
    // The case this exists for. A television turned on its end still reports a
    // landscape viewport, and a media query would draw the wrong layout on the
    // one screen the household deliberately mounted sideways.
    expect(resolveLayout(TV, 90, 'auto')).toBe('portrait');
    expect(resolveLayout(TV, 270, 'auto')).toBe('portrait');
  });

  it('gives a rotated tablet the landscape wall', () => {
    expect(resolveLayout(TABLET, 90, 'auto')).toBe('landscape');
  });

  it('is unchanged by a half turn, which only flips the picture', () => {
    expect(resolveLayout(TV, 180, 'auto')).toBe('landscape');
    expect(resolveLayout(TABLET, 180, 'auto')).toBe('portrait');
  });

  it('obeys a pinned orientation over everything the screen reports', () => {
    // A kiosk frame can report a viewport with no relation to how the thing is
    // hung, and there is nobody on site to argue with it.
    expect(resolveLayout(TV, 0, 'portrait')).toBe('portrait');
    expect(resolveLayout(TABLET, 0, 'landscape')).toBe('landscape');
    expect(resolveLayout(TV, 90, 'landscape')).toBe('landscape');
  });

  it('treats a square canvas as portrait', () => {
    // The stacked layout degrades into a narrow column better than the
    // two-column one does.
    expect(resolveLayout({ width: 1000, height: 1000 }, 0, 'auto')).toBe('portrait');
  });
});

describe('the geometry handed to the page', () => {
  it('swaps the frame and the rem basis on a quarter turn', () => {
    // After turning, the canvas height is the viewport *width*. A rem still
    // reading from vh would size the whole design against the wrong axis on
    // exactly the screens that needed rotating.
    const turned = geometryFor(TV, 90, 'auto');
    expect(turned.frame).toEqual({ width: '100vh', height: '100vw' });
    expect(turned.rootFontSize).toBe('calc(100vw / 100)');
    expect(turned.layout).toBe('portrait');
  });

  it('leaves both alone when the screen is the right way up', () => {
    const upright = geometryFor(TABLET, 0, 'auto');
    expect(upright.frame).toEqual({ width: '100vw', height: '100vh' });
    expect(upright.rootFontSize).toBe('calc(100vh / 100)');
  });

  it('keeps the viewport basis on a half turn', () => {
    // 180 does not swap the axes, so nothing about sizing changes.
    const flipped = geometryFor(TV, 180, 'auto');
    expect(flipped.frame).toEqual({ width: '100vw', height: '100vh' });
    expect(flipped.rootFontSize).toBe('calc(100vh / 100)');
  });

  it('reports the rotation it was given, so the page can turn itself', () => {
    expect(geometryFor(TV, 270, 'auto').rotation).toBe(270);
  });
});

/**
 * How many pixels one arc-minute of the reader's vision is worth.
 *
 * The number every legibility decision in this product wants and none of them
 * has ever had — a type floor stated in pixels is only right on the screen it
 * was measured on. The two examples below are the ones the design argument is
 * made from: a 32" panel hung portrait and read from a sofa, and a 7.5" e-ink
 * panel read from arm's length.
 */
describe('pixels per arc-minute', () => {
  /** 708mm of picture over 1920px, read from 1200mm. */
  const TV_32 = { panelWidthMm: 398, panelHeightMm: 708, readDistanceMm: 1200 };
  /** 98mm of picture over 480px, read from 600mm. */
  const EINK_75 = { panelWidthMm: 163, panelHeightMm: 98, readDistanceMm: 600 };

  it('works the worked examples', () => {
    /*
     * (1200 × π/10800) / (708/1920) = 0.349066 / 0.36875 = 0.94662, and
     * (600 × π/10800) / (98/480) = 0.174533 / 0.204167 = 0.85486. Written out
     * so the arithmetic can be checked without running anything — a constant
     * nobody can re-derive is a constant nobody can correct.
     */
    expect(pxPerArcminute(TV_32, { width: 1080, height: 1920 }, 0)).toBeCloseTo(0.9466, 3);
    expect(pxPerArcminute(EINK_75, { width: 800, height: 480 }, 0)).toBeCloseTo(0.8549, 3);
  });

  it('is why the distance is asked for separately from the size', () => {
    /*
     * The same 32" television, in a kitchen and at the end of a hall. Nothing
     * about the hardware changed and the stylesheet is identical, but a 22px
     * word goes from 23 arc-minutes — comfortable — to 9, which is a familiar
     * word at the acuity limit rather than a sentence somebody reads. That is
     * the whole argument for a distance that stays editable after a size is
     * picked, and no list of screen sizes can answer it.
     */
    const portrait = { width: 1080, height: 1920 };
    const inTheKitchen = 22 / (pxPerArcminute(TV_32, portrait, 0) as number);
    const downTheHall =
      22 / (pxPerArcminute({ ...TV_32, readDistanceMm: 3000 }, portrait, 0) as number);
    expect(inTheKitchen).toBeCloseTo(23.2, 1);
    expect(downTheHall).toBeCloseTo(9.3, 1);
  });

  it('reads the rotated frame, not the raw viewport', () => {
    /*
     * A 1920x1080 television hung on its end reports a landscape viewport and
     * draws a portrait canvas. Measuring against the viewport would divide
     * 708mm of picture by 1080px and come out 1.78x wrong — plausible, silent,
     * and in the direction that makes every name on the wall too small.
     */
    const turned = pxPerArcminute(TV_32, { width: 1920, height: 1080 }, 90);
    const upright = pxPerArcminute(TV_32, { width: 1080, height: 1920 }, 0);
    expect(turned).toBeCloseTo(upright as number, 6);
    /*
     * And it is nowhere near what the raw viewport gives: 708mm of picture over
     * the 1080px that are its *width* on this screen. Not a rounding error —
     * 0.53 against 0.95, which is every size on the wall out by nearly half.
     *
     * The tight comparison above is the assertion that actually holds the fix
     * down: drop `canvasFor` here and `turned` becomes 0.947214 against an
     * `upright` of 0.946619, which six digits catches and two would not.
     */
    const rawViewport = (1200 * (Math.PI / 10_800)) / (708 / 1080);
    expect(rawViewport).toBeCloseTo(0.5325, 3);
    expect(Math.abs((turned as number) - rawViewport)).toBeGreaterThan(0.3);
  });

  it('turns the millimetres to agree with the frame, whichever way they were stored', () => {
    /*
     * The columns hold the picture as it is mounted, but a household turns a
     * wall a year after measuring it and an operating system that rotates a
     * panel reports no rotation here at all. So the stored way-up is a claim
     * and the frame is the measured truth: a landscape pair on a portrait
     * frame is read the other way round rather than believed.
     */
    const asPanelSells = { panelWidthMm: 708, panelHeightMm: 398, readDistanceMm: 1200 };
    const asMounted = { panelWidthMm: 398, panelHeightMm: 708, readDistanceMm: 1200 };
    const portrait = { width: 1080, height: 1920 };
    expect(pxPerArcminute(asPanelSells, portrait, 0)).toBeCloseTo(
      pxPerArcminute(asMounted, portrait, 0) as number,
      6,
    );
    // The landscape frame of the same television agrees with itself too.
    const landscape = { width: 1920, height: 1080 };
    expect(pxPerArcminute(asPanelSells, landscape, 0)).toBeCloseTo(
      pxPerArcminute(asMounted, landscape, 0) as number,
      6,
    );
  });

  it('answers nothing rather than a number when it has not been told', () => {
    const viewport = { width: 1080, height: 1920 };
    expect(pxPerArcminute(undefined, viewport, 0)).toBeUndefined();
    // A hand-edited row, or a document from a server that means something else
    // by these fields. Nothing here may throw or answer a nonsense size.
    expect(pxPerArcminute({ ...TV_32, readDistanceMm: 0 }, viewport, 0)).toBeUndefined();
    expect(pxPerArcminute({ ...TV_32, panelHeightMm: -1 }, viewport, 0)).toBeUndefined();
    expect(
      pxPerArcminute({ ...TV_32, panelWidthMm: Number.NaN }, viewport, 0),
    ).toBeUndefined();
    // A frame with no size at all: a page measured before it has been laid out.
    expect(pxPerArcminute(TV_32, { width: 0, height: 0 }, 0)).toBeUndefined();
  });

  it('takes two of the three as none of them', () => {
    // Not half an answer — it derives nothing, so it is the same state as
    // never having been measured.
    expect(physicalScreenFrom(398, 708, 1200)).toEqual({
      panelWidthMm: 398,
      panelHeightMm: 708,
      readDistanceMm: 1200,
    });
    expect(physicalScreenFrom(398, 708, undefined)).toBeUndefined();
    expect(physicalScreenFrom(398, undefined, 1200)).toBeUndefined();
    expect(physicalScreenFrom(undefined, undefined, undefined)).toBeUndefined();
    // Whatever a manifest actually holds, not what its types promise.
    expect(physicalScreenFrom('398', 708, 1200)).toBeUndefined();
    expect(physicalScreenFrom(null, null, null)).toBeUndefined();
  });
});

describe('an unmeasured wall is the wall it was', () => {
  it('adds nothing at all to the geometry', () => {
    /*
     * Byte-for-byte the object `geometryFor` has always returned — not the same
     * object with `pxArcmin: undefined` on it. Every household who never opens
     * the setting is on this branch, and the promise of the whole change is
     * that nothing about them moves.
     */
    const before = geometryFor(TABLET, 0, 'auto');
    expect(Object.keys(before).sort()).toEqual(['frame', 'layout', 'rootFontSize', 'rotation']);
    expect(before).toStrictEqual({
      rotation: 0,
      layout: 'portrait',
      frame: { width: '100vw', height: '100vh' },
      rootFontSize: 'calc(100vh / 100)',
    });
    // And a half-measurement is on the same branch.
    expect(
      Object.keys(geometryFor(TABLET, 0, 'auto', undefined)).sort(),
    ).toEqual(['frame', 'layout', 'rootFontSize', 'rotation']);
  });

  it('carries the number and nothing else once it has been measured', () => {
    const geo = geometryFor(TABLET, 0, 'auto', {
      panelWidthMm: 398,
      panelHeightMm: 708,
      readDistanceMm: 1200,
    });
    expect(geo.pxArcmin).toBeCloseTo(0.9466, 3);
    // The four it always had are untouched: this is an addition, not a change.
    expect(geo.layout).toBe('portrait');
    expect(geo.rootFontSize).toBe('calc(100vh / 100)');
    expect(geo.frame).toEqual({ width: '100vw', height: '100vh' });
  });
});
