import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestPersonShift } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The shift widget answers the settings the designer offers.
 *
 * Written the way `epaper-calendar-widget.test.ts` is, and for the same reason:
 * "the frame changed" is never enough on its own, because a frame changes just
 * as readily if a setting moved something unrelated. Each case is pinned to an
 * *equivalence* — the filtered frame is the frame of a manifest with the other
 * person deleted, the short-code frame is the frame of a manifest whose label
 * already was the code, the hours-off frame is the frame of an untimed shift.
 * A renderer that ignored the config could not pass any of them.
 *
 * The first case is the one that matters most. Until 0.45.0 the wall drew
 * `shifts[0]` and the panel drew everybody, so the same arrangement said
 * different things on the two screens and no setting anywhere could reconcile
 * them.
 */

const PANEL = { width: 800, height: 480 } as const;
const TODAY = '2026-08-13';

function shift(over: Partial<ManifestPersonShift>): ManifestPersonShift {
  return {
    key: 'day',
    label: 'Days',
    shortCode: 'D',
    colorToken: '--s-day',
    isWorking: true,
    source: 'pattern',
    startTime: '07:00',
    endTime: '19:00',
    personId: 'amy',
    personName: 'Amy',
    personColor: '#4C7FD1',
    personAvatarUrl: null,
    ...over,
  } as unknown as ManifestPersonShift;
}

function manifestOf(shifts: ManifestPersonShift[]): Manifest {
  const days: ManifestDay[] = [{ date: TODAY, shifts, events: [] } as unknown as ManifestDay];
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 12, 0, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
  } as unknown as Manifest;
}

/** One shift widget filling the panel, with whatever config is under test. */
/** One shift widget on the panel — filling it, or in whatever box is asked for. */
function frameOf(
  manifest: Manifest,
  config: Record<string, unknown>,
  box: Partial<PlacedEpaperWidget> = {},
): Framebuffer {
  const widget: PlacedEpaperWidget = {
    type: 'shift', x: 0, y: 0, w: 1, h: 1, z: 0, config, ...box,
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

const amy = shift({});
const ben = shift({
  key: 'night',
  label: 'Nights',
  shortCode: 'N',
  colorToken: '--s-night',
  startTime: '19:00',
  endTime: '07:00',
  personId: 'ben',
  personName: 'Ben',
  personColor: '#C05C7E',
});

describe('the shift widget on a panel', () => {
  it('draws everybody on a rota when nobody is picked out', () => {
    /*
     * An untouched widget: no config at all, both people on today.
     *
     * Asserted by *dependence* rather than by ink, which is not a proxy for how
     * many people are drawn — one person in a tall box gets the big card and
     * two get a compact line each, so a correct two-person frame carries less
     * ink than a correct one-person frame. Renaming a person changes the frame
     * only if that person is on it, so doing it to each in turn proves both are.
     */
    const both = bitsOf(frameOf(manifestOf([amy, ben]), {}));
    const amyRenamed = { ...amy, personName: 'Zed' } as ManifestPersonShift;
    const benRenamed = { ...ben, personName: 'Zed' } as ManifestPersonShift;
    expect(bitsOf(frameOf(manifestOf([amyRenamed, ben]), {}))).not.toEqual(both);
    expect(bitsOf(frameOf(manifestOf([amy, benRenamed]), {}))).not.toEqual(both);
    // And "none picked" is the same request as "all of them picked".
    expect(bitsOf(frameOf(manifestOf([amy, ben]), { people: ['amy', 'ben'] }))).toEqual(both);
  });

  it('draws only the person the household picked', () => {
    // The equivalence: filtering to Ben is the frame of a manifest that only
    // ever had Ben on it. A renderer that ignored `people` would draw Amy too
    // and fail this, not merely differ from the default.
    const filtered = frameOf(manifestOf([amy, ben]), { people: ['ben'] });
    expect(bitsOf(filtered)).toEqual(bitsOf(frameOf(manifestOf([ben]), {})));
    expect(bitsOf(filtered)).not.toEqual(bitsOf(frameOf(manifestOf([amy, ben]), {})));
  });

  it('says so plainly when the person it watches is off today', () => {
    // A box pointed at one person must not quietly promote somebody else's
    // shift into it on the days they are off.
    const off = frameOf(manifestOf([ben]), { people: ['amy'] });
    expect(bitsOf(off)).toEqual(bitsOf(frameOf(manifestOf([]), {})));
  });

  it('draws the short code instead of the name when asked', () => {
    const coded = frameOf(manifestOf([amy]), { shiftName: 'code' });
    // The same frame as a rota whose full name already was the code.
    expect(bitsOf(coded)).toEqual(bitsOf(frameOf(manifestOf([shift({ label: 'D' })]), {})));
    expect(bitsOf(coded)).not.toEqual(bitsOf(frameOf(manifestOf([amy]), {})));
  });

  it('drops the hours when asked, on the card and on the compact lines', () => {
    // Omitted, not set to undefined: an untimed shift is one with no window at
    // all, which is what the manifest carries and what the renderer reads.
    const untimed = (s: ManifestPersonShift): ManifestPersonShift => {
      const { startTime: _start, endTime: _end, ...rest } = s;
      return rest as ManifestPersonShift;
    };
    // One person: the card, whose third row is the hours.
    expect(bitsOf(frameOf(manifestOf([amy]), { showHours: false }))).toEqual(
      bitsOf(frameOf(manifestOf([untimed(amy)]), {})),
    );
    // Two: a compact line each, where the hours ride on the end of the line.
    expect(bitsOf(frameOf(manifestOf([amy, ben]), { showHours: false }))).toEqual(
      bitsOf(frameOf(manifestOf([untimed(amy), untimed(ben)]), {})),
    );
  });

  it('gives up the ladder from the bottom as the box gets shorter', () => {
    /*
     * What replaced `box.h >= 44`. The threshold was a renderer's private
     * opinion about the household's box; the ladder is arithmetic against the
     * box there actually is, and it cuts from the bottom of a list the
     * household wrote.
     *
     * Asserted by equivalence, not by "the frame changed": a short box drawing
     * the top of the ladder is the frame of a *ladder that was that short to
     * begin with*, in a box tall enough for it. A renderer that merely drew
     * everything smaller would fail this.
     */
    // 0.11 of this 480px panel is a 53px box: room for the person and the
    // shift, not for the hours underneath them.
    const tall = frameOf(manifestOf([amy]), {}, { h: 1 });
    const short = frameOf(manifestOf([amy]), {}, { h: 0.11 });
    expect(bitsOf(short)).not.toEqual(bitsOf(tall));
    expect(bitsOf(short)).toEqual(
      bitsOf(frameOf(manifestOf([amy]), { fields: ['person', 'shift'] }, { h: 0.11 })),
    );
  });

  it('gives up in the household\u2019s order, so reordering changes what survives', () => {
    // The claim the ladder rests on. Two ladders over the same shift in the
    // same short box, differing only in order, must not draw the same frame.
    const personFirst = frameOf(manifestOf([amy]), { fields: ['person', 'hours'] });
    const hoursFirst = frameOf(manifestOf([amy]), { fields: ['hours', 'person'] });
    expect(bitsOf(personFirst)).not.toEqual(bitsOf(hoursFirst));
    // And in a box too short for both, what survives differs too — which is the
    // half a row of switches could never express.
    const tiny = { h: 0.08 } as const;
    expect(
      bitsOf(frameOf(manifestOf([amy]), { fields: ['person', 'hours'] }, tiny)),
    ).not.toEqual(
      bitsOf(frameOf(manifestOf([amy]), { fields: ['hours', 'person'] }, tiny)),
    );
  });

  it('never draws an empty badge, however short the box', () => {
    // Rule nine: the head of the ladder survives, clipped if it comes to that.
    const sliver = frameOf(manifestOf([amy]), {}, { h: 0.08 });
    let ink = 0;
    for (const bit of bitsOf(sliver)) ink += bit;
    expect(ink).toBeGreaterThan(0);
  });

  it('is unchanged for a widget saved before the ladder existed', () => {
    // The compatibility that matters: a stored `showHours: false` resolves to
    // the same ladder, and so to the same frame, as writing it out by hand.
    expect(bitsOf(frameOf(manifestOf([amy]), { showHours: false }, { h: 1 }))).toEqual(
      bitsOf(frameOf(manifestOf([amy]), { fields: ['person', 'shift', 'run'] }, { h: 1 })),
    );
  });

  it('changes nothing for an option the panel has no row for', () => {
    /*
     * `showRun` is the wall's. This renderer has never drawn the run line, and
     * an option whose absence means "on" would otherwise make every existing
     * panel grow a row nobody asked for on upgrade. Pinned as identical rather
     * than left to be discovered.
     */
    expect(bitsOf(frameOf(manifestOf([amy]), { showRun: false }))).toEqual(
      bitsOf(frameOf(manifestOf([amy]), {})),
    );
  });
});
