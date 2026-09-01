import { describe, expect, it } from 'vitest';
import {
  matchWallSize,
  mountedSize,
  physicalWall,
  resolveWallSize,
  wallSizePreset,
  PANEL_MM_MAX,
  PANEL_MM_MIN,
  READ_DISTANCE_MM_MAX,
  READ_DISTANCE_MM_MIN,
  WALL_SIZE_CUSTOM,
  WALL_SIZE_PRESETS,
} from '../src/wall-sizes.js';
import { buildManifest, manifestEtag, type BuildManifestInput } from '../src/api/manifest.js';
import { renderScreenFrame, type FrameScreen } from '../src/epaper/frame.js';

/**
 * How large a wall is and how far away it is read from — the two facts that
 * decide whether type on a wall can be read, and the two this product has
 * never had.
 *
 * The property the whole change turns on is the *absence* one, which is why it
 * gets the most room here: with all three columns null a wall and a panel must
 * draw byte-for-byte what they drew before, because that is every household who
 * never opens the setting. An assertion about the presence of a new field is
 * easy and proves little; an assertion that a document is unchanged is the one
 * that fails if somebody later emits `panelWidthMm: null` and churns every
 * stored ETag in the world.
 */

// ---------------------------------------------------------------------------
// The list a household picks from
// ---------------------------------------------------------------------------

describe('the sizes a household can recognise', () => {
  it('offers a distance that suits the size it is paired with', () => {
    /*
     * Not decoration: the distance is what makes each entry an answer rather
     * than a measurement, so a preset with somebody's typo in it would size a
     * wall wrongly for everyone who picked it and there is nothing on screen
     * that would look wrong. Every one of these sits between three and six
     * times the picture's own height, which is where people stand.
     */
    for (const preset of WALL_SIZE_PRESETS) {
      const shortest = Math.min(preset.widthMm, preset.heightMm);
      const ratio = preset.readAtMm / shortest;
      expect(ratio, `${preset.label} is read at ${ratio.toFixed(1)}x its height`)
        .toBeGreaterThan(2.5);
      expect(ratio, `${preset.label} is read at ${ratio.toFixed(1)}x its height`)
        .toBeLessThan(8);
      // And every one is a plausible picture, by the same band the manifest uses.
      expect(physicalWall(preset.widthMm, preset.heightMm, preset.readAtMm)).toBeDefined();
    }
    // Distinct keys, or one preset silently shadows another in the picker.
    expect(new Set(WALL_SIZE_PRESETS.map((p) => p.key)).size).toBe(WALL_SIZE_PRESETS.length);
  });

  it('turns a preset to how the wall is hung', () => {
    const tv = wallSizePreset('tv-32');
    expect(tv).toBeDefined();
    // Upright and upside down are the same way up; a quarter turn is not.
    expect(mountedSize(tv!, 0)).toEqual({ widthMm: 708, heightMm: 398 });
    expect(mountedSize(tv!, 180)).toEqual({ widthMm: 708, heightMm: 398 });
    expect(mountedSize(tv!, 90)).toEqual({ widthMm: 398, heightMm: 708 });
    expect(mountedSize(tv!, 270)).toEqual({ widthMm: 398, heightMm: 708 });
  });

  it('reads a stored pair back as the television it is, whichever way up', () => {
    // A wall hung sideways stored 398x708. Matching on an ordered pair would
    // drop the household onto "Enter my own" and imply they typed numbers they
    // never typed.
    expect(matchWallSize(708, 398)?.key).toBe('tv-32');
    expect(matchWallSize(398, 708)?.key).toBe('tv-32');
    expect(matchWallSize(700, 398)).toBeUndefined();
    expect(matchWallSize(null, 398)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Three fields, one answer
// ---------------------------------------------------------------------------

describe('what the form means', () => {
  const ok = (choice: ReturnType<typeof resolveWallSize>) => {
    expect(choice.ok, 'ok' in choice && choice.ok ? '' : (choice as { message: string }).message)
      .toBe(true);
    const { widthMm, heightMm, distanceMm } = choice as {
      widthMm: number | null;
      heightMm: number | null;
      distanceMm: number | null;
    };
    return { widthMm, heightMm, distanceMm };
  };

  it('fills the size from a preset and the distance from the preset only if blank', () => {
    expect(ok(resolveWallSize({ size: 'tv-32' }, 0))).toMatchObject({
      widthMm: 708, heightMm: 398, distanceMm: 1200,
    });
    // A household who has said where they stand keeps it when they correct the
    // size: the distance is a fact about the room, not about the hardware.
    expect(ok(resolveWallSize({ size: 'tv-32', distanceMm: '3000' }, 0))).toMatchObject({
      widthMm: 708, heightMm: 398, distanceMm: 3000,
    });
    // And the rotation being saved decides which way up it is stored.
    expect(ok(resolveWallSize({ size: 'tv-32' }, 90))).toMatchObject({
      widthMm: 398, heightMm: 708,
    });
  });

  it('clears all three, ignoring numbers the browser sent anyway', () => {
    /*
     * The whole reason this is worth a test: a hidden input is submitted
     * exactly as a visible one is, so the width and height of the wall this
     * used to be are still in the body when somebody chooses "Not set".
     * Reading them there would make taking a measurement back impossible from
     * the one control that offers it.
     */
    expect(ok(resolveWallSize(
      { size: '', widthMm: '708', heightMm: '398', distanceMm: '1200' },
      0,
    ))).toEqual({ widthMm: null, heightMm: null, distanceMm: null });
    expect(ok(resolveWallSize({}, 0))).toEqual({ widthMm: null, heightMm: null, distanceMm: null });
  });

  it('takes a measurement somebody typed, exactly as typed', () => {
    expect(ok(resolveWallSize(
      { size: WALL_SIZE_CUSTOM, widthMm: '480', heightMm: '270', distanceMm: '1500' },
      // Not turned by the rotation: these are what a person measured on the
      // wall in front of them, which is already the mounted way up.
      90,
    ))).toEqual({ widthMm: 480, heightMm: 270, distanceMm: 1500 });
  });

  it('refuses half a measurement rather than storing one', () => {
    // Two of three derives nothing, so storing it would read as set on this
    // form and as absent everywhere else.
    const half = resolveWallSize({ size: WALL_SIZE_CUSTOM, widthMm: '480', heightMm: '270' }, 0);
    expect(half.ok).toBe(false);
    expect((half as { message: string }).message).toContain('reading distance');
  });

  it('says which field is wrong, in millimetres, for somebody standing at a screen', () => {
    const cases: readonly [Record<string, string>, string][] = [
      [{ size: WALL_SIZE_CUSTOM, widthMm: 'wide', heightMm: '270', distanceMm: '1500' }, 'The width'],
      [{ size: WALL_SIZE_CUSTOM, widthMm: '480', heightMm: '0', distanceMm: '1500' }, 'The height'],
      [{ size: WALL_SIZE_CUSTOM, widthMm: '480', heightMm: '270', distanceMm: '9' }, 'The reading distance'],
      [{ size: 'tv-99' }, 'Pick a size'],
    ];
    for (const [fields, says] of cases) {
      const choice = resolveWallSize(fields, 0);
      expect(choice.ok, JSON.stringify(fields)).toBe(false);
      expect((choice as { message: string }).message).toContain(says);
    }
  });

  it('bounds a measurement without refusing an honest odd one', () => {
    expect(resolveWallSize(
      { size: WALL_SIZE_CUSTOM, widthMm: String(PANEL_MM_MAX + 1), heightMm: '270', distanceMm: '1500' },
      0,
    ).ok).toBe(false);
    expect(resolveWallSize(
      { size: WALL_SIZE_CUSTOM, widthMm: String(PANEL_MM_MIN), heightMm: String(PANEL_MM_MAX), distanceMm: String(READ_DISTANCE_MM_MAX) },
      0,
    ).ok).toBe(true);
    expect(resolveWallSize(
      { size: WALL_SIZE_CUSTOM, widthMm: '480', heightMm: '270', distanceMm: String(READ_DISTANCE_MM_MIN - 1) },
      0,
    ).ok).toBe(false);
  });
});

describe('a measurement the manifest will act on', () => {
  it('is all three or none, and refused rather than clamped', () => {
    expect(physicalWall(708, 398, 1200)).toEqual({
      panelWidthMm: 708, panelHeightMm: 398, readDistanceMm: 1200,
    });
    expect(physicalWall(708, 398, null)).toBeUndefined();
    expect(physicalWall(null, null, null)).toBeUndefined();
    /*
     * A hand-edited row. Clamping 999999 to 5000 draws a wall confidently sized
     * for a stadium; dropping it draws the wall the household had yesterday,
     * which is the side rule nine takes.
     */
    expect(physicalWall(999_999, 398, 1200)).toBeUndefined();
    expect(physicalWall(708, 398, 0)).toBeUndefined();
    expect(physicalWall(Number.NaN, 398, 1200)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Absent means unchanged
// ---------------------------------------------------------------------------

const HOUSEHOLD = {
  timezone: 'Europe/London',
  theme: 'board',
  daytimeTheme: null,
  daytimeStartsAt: null,
  daytimeEndsAt: null,
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

const BASE: BuildManifestInput = {
  household: HOUSEHOLD,
  events: [
    {
      id: 'e1', sourceId: 's1', uid: 'u1', title: 'Dentist', location: null,
      startsAt: NOW, endsAt: NOW + 3_600_000, allDay: 0,
      startLocalDate: '2026-09-10', endLocalDate: '2026-09-10', status: 'CONFIRMED',
    },
  ],
  sources: [
    {
      id: 's1', name: 'Family', color: '#E8A33D', visible: 1, showInGrid: 1, personId: null,
      lastSuccessAt: NOW - 60_000, lastError: null, consecutiveFailures: 0, eventCount: 1,
    },
  ],
  people: [],
  shiftTypes: [],
  shiftPlans: [],
  shiftOverrides: [],
  today: '2026-09-10',
  daysBefore: 1,
  daysAfter: 5,
  now: NOW,
  appVersion: '0.1.0-test',
};

/** A wall's screen slice as it was before any of this existed. */
const UNMEASURED = {
  orientation: 'auto',
  rotation: 0,
  allowDismiss: false,
  allowChores: false,
} as const;

const PANEL: FrameScreen = {
  panelWidth: 800, panelHeight: 480, panelColour: 'bw', rotation: 0,
};

describe('a wall nobody has measured', () => {
  it('sends the document it sent before the fields existed, byte for byte', () => {
    /*
     * Not "the new keys are undefined" — *absent*. `manifestEtag` hashes the
     * serialisation, so a `"panelWidthMm": null` on a wall nobody has measured
     * would churn every stored ETag in the world at one image pull, for a
     * household who never opened the setting. Compared as text rather than by
     * shape, because that is what the hash and the wire actually carry.
     */
    const untouched = buildManifest({ ...BASE, screen: UNMEASURED });
    const nulled = buildManifest({
      ...BASE,
      screen: { ...UNMEASURED, panelWidthMm: null, panelHeightMm: null, readDistanceMm: null },
    });
    expect(JSON.stringify(nulled)).toBe(JSON.stringify(untouched));
    expect(manifestEtag(nulled)).toBe(manifestEtag(untouched));
    expect(Object.keys(nulled.screen)).toEqual([
      'orientation', 'rotation', 'allowDismiss', 'allowChores',
    ]);
    // And a half-measurement is on that same branch rather than half on it.
    const half = buildManifest({
      ...BASE,
      screen: { ...UNMEASURED, panelWidthMm: 708, panelHeightMm: 398, readDistanceMm: null },
    });
    expect(JSON.stringify(half)).toBe(JSON.stringify(untouched));
  });

  it('draws the same panel frame, to the pixel and to the ETag', () => {
    const untouched = renderScreenFrame(buildManifest({ ...BASE, screen: UNMEASURED }), PANEL);
    const nulled = renderScreenFrame(
      buildManifest({
        ...BASE,
        screen: { ...UNMEASURED, panelWidthMm: null, panelHeightMm: null, readDistanceMm: null },
      }),
      PANEL,
    );
    expect(Buffer.from(nulled.fb.bits)).toEqual(Buffer.from(untouched.fb.bits));
    expect(nulled.etag).toBe(untouched.etag);
  });
});

describe('a wall somebody has measured', () => {
  const measured = buildManifest({
    ...BASE,
    screen: { ...UNMEASURED, panelWidthMm: 398, panelHeightMm: 708, readDistanceMm: 1200 },
  });

  it('carries the facts, and not a size in pixels', () => {
    /*
     * Millimetres and a distance, never a derived scale: the server does not
     * know what this browser calls a pixel, and the page does. Pinned by name
     * so a later phase cannot quietly start sending an answer instead of the
     * inputs to one.
     */
    expect(measured.screen).toEqual({
      orientation: 'auto',
      rotation: 0,
      allowDismiss: false,
      allowChores: false,
      panelWidthMm: 398,
      panelHeightMm: 708,
      readDistanceMm: 1200,
    });
  });

  it('changes the ETag, so a wall and a panel both pick the measurement up', () => {
    // Free rather than designed — the screen slice is inside `manifestEtag`'s
    // preimage and the panel's frame ETag is built from that — so it is pinned
    // here. Without it, measuring a wall would reach nothing until its calendar
    // happened to change.
    const untouched = buildManifest({ ...BASE, screen: UNMEASURED });
    expect(manifestEtag(measured)).not.toBe(manifestEtag(untouched));
    expect(renderScreenFrame(measured, PANEL).etag).not.toBe(
      renderScreenFrame(untouched, PANEL).etag,
    );
  });
});
