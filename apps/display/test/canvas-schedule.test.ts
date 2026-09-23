import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readSchedule, scheduledSlot, slotWidgets, windowContains } from '../src/canvas-schedule.js';
import { canvasKey, parseCanvasKey } from '../src/canvas-state.js';
import { daytimeActive } from '../src/theme.js';

/**
 * Which canvas the clock selects (RFC 014 §5.2), asked without a browser.
 *
 * `browser-scheduled-canvas.test.ts` next door drives a real wall across a
 * window's boundary; this asks the questions a rendered page cannot ask
 * cheaply — every minute of the day against every shape of window, the exact
 * boundary minute, and what an unreadable schedule does — which is where a
 * wall left blank between 06:30 and 08:30 would actually come from.
 */

const MINUTES: string[] = [];
for (let h = 0; h < 24; h += 1) {
  for (let m = 0; m < 60; m += 1) {
    MINUTES.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

describe('a schedule window', () => {
  it('contains the minute it starts on and not the minute it ends on', () => {
    expect(windowContains('06:30', '08:30', '06:29')).toBe(false);
    expect(windowContains('06:30', '08:30', '06:30')).toBe(true);
    expect(windowContains('06:30', '08:30', '08:29')).toBe(true);
    expect(windowContains('06:30', '08:30', '08:30')).toBe(false);
  });

  it('wraps past midnight the way the daylight theme’s window does', () => {
    expect(windowContains('21:00', '06:00', '23:59')).toBe(true);
    expect(windowContains('21:00', '06:00', '00:00')).toBe(true);
    expect(windowContains('21:00', '06:00', '05:59')).toBe(true);
    expect(windowContains('21:00', '06:00', '06:00')).toBe(false);
    expect(windowContains('21:00', '06:00', '12:00')).toBe(false);
  });

  it('is never a window of no length', () => {
    for (const minute of MINUTES) expect(windowContains('07:00', '07:00', minute)).toBe(false);
  });

  it('reads exactly as the daylight theme reads its own window, at every minute', () => {
    /*
     * The theme switches on `daytimeActive`; the canvas switches on this. A
     * wall whose colours changed at one minute and whose arrangement changed
     * at the next would look broken twice a day, so the two are held to one
     * answer over every minute and four shapes of window rather than assumed
     * to agree because the code looks the same.
     */
    const windows: [string, string][] = [['06:30', '08:30'], ['21:00', '06:00'], ['00:00', '23:59'], ['12:00', '12:00']];
    for (const [from, to] of windows) {
      for (const minute of MINUTES) {
        expect(windowContains(from, to, minute), `${from}–${to} at ${minute}`).toBe(
          daytimeActive(minute, 'any', from, to),
        );
      }
    }
  });
});

describe('the slot the schedule selects', () => {
  const schedule = [
    { slot: 'morning', from: '06:30', to: '08:30' },
    { slot: 'evening', from: '20:00', to: '23:00' },
  ];

  it('names the slot whose window contains now, and nothing outside every window', () => {
    expect(scheduledSlot(schedule, '11:00')).toBeUndefined();
    expect(scheduledSlot(schedule, '06:30')).toBe('morning');
    expect(scheduledSlot(schedule, '08:29')).toBe('morning');
    expect(scheduledSlot(schedule, '08:30')).toBeUndefined();
    expect(scheduledSlot(schedule, '20:00')).toBe('evening');
  });

  it('moves with the window by exactly one minute', () => {
    // The mutation the browser test makes by hand: a window that starts one
    // minute after now selects nothing, and the default draws.
    expect(scheduledSlot([{ slot: 'morning', from: '06:31', to: '08:30' }], '06:30')).toBeUndefined();
    expect(scheduledSlot([{ slot: 'morning', from: '06:31', to: '08:30' }], '06:31')).toBe('morning');
  });

  it('lets the first of two overlapping rows win', () => {
    expect(
      scheduledSlot(
        [{ slot: 'a', from: '06:00', to: '09:00' }, { slot: 'b', from: '07:00', to: '10:00' }],
        '08:00',
      ),
    ).toBe('a');
  });

  it('reads nothing from a schedule this bundle cannot read', () => {
    // A stored copy written by an older bundle carries no schedule at all; a
    // newer server might carry a shape this one has never seen. Either way the
    // answer is the default canvas, never a throw inside the tick.
    expect(scheduledSlot(undefined, '07:00')).toBeUndefined();
    expect(scheduledSlot(null, '07:00')).toBeUndefined();
    expect(scheduledSlot('06:30-08:30', '07:00')).toBeUndefined();
    expect(scheduledSlot([{ slot: 'x', from: '6:30', to: '08:30' }], '07:00')).toBeUndefined();
    expect(scheduledSlot([{ slot: '', from: '06:30', to: '08:30' }], '07:00')).toBeUndefined();
    expect(scheduledSlot([null, 4, 'row', { slot: 'x', from: '06:30', to: '08:30' }], '07:00')).toBe('x');
    expect(readSchedule([{ slot: 'x', from: '06:30', to: '08:30', extra: 1 }])).toEqual([
      { slot: 'x', from: '06:30', to: '08:30' },
    ]);
  });
});

describe('a slot’s canvas on one orientation', () => {
  const slots = [
    { slot: 'morning', portrait: { widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 1, h: 1, z: 0 }] }, landscape: { widgets: [] } },
  ];

  it('answers the widgets where the slot has some, and nothing where it has none', () => {
    expect(slotWidgets(slots, 'portrait', 'morning')?.map((w) => w.id)).toEqual(['a']);
    /*
     * The landscape canvas of a slot arranged only in portrait is *undefined*,
     * not `[]`: the caller draws the default slot's landscape for it, because
     * a household who never arranged the morning landscape did not ask for an
     * empty landscape wall every morning.
     */
    expect(slotWidgets(slots, 'landscape', 'morning')).toBeUndefined();
    expect(slotWidgets(slots, 'portrait', 'evening')).toBeUndefined();
    expect(slotWidgets(undefined, 'portrait', 'morning')).toBeUndefined();
    expect(slotWidgets([{ slot: 'morning', portrait: 'x' }], 'portrait', 'morning')).toBeUndefined();
  });
});

describe('the editor’s canvas key', () => {
  it('round-trips an orientation and a slot, with the default as no slot', () => {
    for (const orientation of ['portrait', 'landscape'] as const) {
      for (const slot of [null, 'morning', 'a-b-1']) {
        expect(parseCanvasKey(canvasKey(orientation, slot))).toEqual([orientation, slot]);
      }
    }
    expect(canvasKey('portrait', null)).not.toBe(canvasKey('landscape', null));
    expect(canvasKey('portrait', 'x')).not.toBe(canvasKey('portrait', null));
  });
});

describe('the wall’s pick', () => {
  /*
   * `pickCanvas` lives in `main.ts`, which has no test harness, so its one
   * new rule is asserted on the source: the slot's widgets replace the
   * orientation's own, and the aspect and background do not move with them.
   * The measurement is `browser-scheduled-canvas.test.ts`.
   */
  it('takes the slot’s widgets and keeps the orientation’s geometry', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const pick = source.slice(source.indexOf('function pickCanvas('), source.indexOf('function start('));
    expect(pick).toContain('scheduledSlot(layout?.schedule, localHhmm)');
    expect(pick).toContain('slotWidgets(layout?.slots, orientation, slot)');
    expect(pick).toContain('widgets: scheduled,');
    expect(pick).toContain('aspect: primary?.aspect ??');
  });
});
