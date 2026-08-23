import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The Swiss month mode, at the two boundaries a display change has to cross.
 *
 * The renderer itself is the wall's, and the wall is verified by measuring a
 * real paired screen — there is no DOM in this suite and none in the display's.
 * What *is* checkable here is the pair of places a new stored value goes wrong
 * silently:
 *
 * 1. **The schema.** `cellEvents` is a closed enum. A value the form accepts
 *    and the schema rejects is a setting that appears to save and does nothing
 *    — the `options.json` fault, one field along.
 *
 * 2. **The panel.** `epaper/honours.ts` declares `cellEvents` honoured, and the
 *    panel used to read it as `=== 'pills'`. Left alone, `swiss` would have
 *    fallen through to quiet dots while the wall it follows drew event names:
 *    one stored value, two renderers, two answers — which is the exact shape of
 *    the `shifts[0]` and `display_mode` bugs this project has already shipped
 *    twice. On one bit there is no difference between a coloured bubble and a
 *    coloured dot, so both modes must resolve to the same question: does the
 *    cell show the name, or only that something is on?
 */

const PANEL = { width: 520, height: 300 } as const;
const TODAY = '2026-08-22';

function manifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 22; d <= 27; d++) {
    days.push({
      date: `2026-08-${d}`,
      shifts: [],
      // Epoch millis and `startsAt`/`endsAt`, which is the manifest's own
      // shape — an ISO string here parses to Invalid Date inside the model and
      // fails before a single assertion runs.
      events: [
        {
          id: `e${d}`, uid: `e${d}`, title: `Dentist ${d}`,
          startsAt: Date.UTC(2026, 7, d, 9), endsAt: Date.UTC(2026, 7, d, 10),
          allDay: false, sourceId: 's1', color: '#4C7FD1',
          status: 'confirmed', continues: false,
        },
      ],
    } as unknown as ManifestDay);
  }
  return {
    manifestVersion: 1,
    appVersion: 'test',
    generatedAt: Date.UTC(2026, 7, 22, 8, 0, 0),
    timezone: 'UTC',
    theme: { active: 'swiss' },
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    people: [],
    sources: [{ id: 's1', name: 'Family', color: '#4C7FD1' }],
    notices: [],
    panels: {},
  } as unknown as Manifest;
}

const M = manifest();
const MODEL = buildEpaperModel(M);

function frame(config: Record<string, unknown>): string {
  const widget: PlacedEpaperWidget = { type: 'calendar', x: 0, y: 0, w: 1, h: 1, z: 0, config };
  const fb: Framebuffer = renderFreeformEpaper(MODEL, M, [widget], PANEL);
  let bits = '';
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) bits += fb.get(x, y) ? '1' : '0';
  }
  return bits;
}

describe('the swiss cellEvents value', () => {
  it('survives the widget schema', () => {
    const parsed = widgetConfigBody.safeParse({ mode: 'month', cellEvents: 'swiss' });
    expect(parsed.success, 'the schema refuses a value the editor offers').toBe(true);
  });

  it('still refuses a value no renderer reads', () => {
    // The enum has to stay closed, or this test proves only that Zod exists.
    expect(widgetConfigBody.safeParse({ mode: 'month', cellEvents: 'brutalist' }).success).toBe(
      false,
    );
  });
});

describe('the e-paper panel, given a swiss month', () => {
  it('draws the event names, exactly as it does for pills', () => {
    // Identical frames is the assertion, not merely "different from dots": on
    // one bit the two modes ask the same question, and any daylight between
    // them is a panel disagreeing with the wall it is following.
    expect(frame({ mode: 'month', cellEvents: 'swiss' })).toBe(
      frame({ mode: 'month', cellEvents: 'pills' }),
    );
  });

  it('does not quietly fall back to dots', () => {
    // The bug this file exists for. Without the mapping, `swiss` reads as
    // not-pills and the panel drops to marks while the wall draws names.
    expect(frame({ mode: 'month', cellEvents: 'swiss' })).not.toBe(
      frame({ mode: 'month', cellEvents: 'dots' }),
    );
  });
});
