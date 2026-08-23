import { describe, expect, it } from 'vitest';

import { clearLaneKeys, inkOf, mergeInk, setLaneValue } from '../src/ink.js';
import { clockWidgetView, shiftWidgetView } from '../src/widget-options.js';
import { shiftLadder, weatherLadder } from '../src/ladder.js';

/**
 * The two lanes, and the one property that matters more than the rest.
 *
 * A widget carries the household's wall settings and, optionally, an `ink`
 * object saying what it does differently on a panel following the same canvas.
 * **Editing on ink must never change a wall value** — a household who tunes a
 * panel and finds their kitchen wall has quietly changed has lost trust in both
 * screens, and the mistake is one character wide.
 *
 * These are written against the pure module rather than the editor because
 * there is no DOM in this package's test suite: a rule resolved inside a click
 * handler is a rule nothing can check, which is exactly why the shift widget's
 * options were pulled out into `widget-options.ts` first.
 */

describe('reading a widget’s ink lane', () => {
  it('is empty for every widget that has never been touched', () => {
    expect(inkOf(undefined)).toEqual({});
    expect(inkOf({})).toEqual({});
    expect(inkOf({ count: 3 })).toEqual({});
  });

  it('ignores an ink that is not an object', () => {
    // A row from a newer server, or one edited by hand. Never a crash, and
    // never a merge of something that is not a set of settings.
    for (const raw of ['yes', 42, null, ['count'], true]) {
      expect(inkOf({ ink: raw }), JSON.stringify(raw)).toEqual({});
    }
  });

  it('hands back a copy, so a caller cannot edit the widget by accident', () => {
    const config = { ink: { count: 3 } };
    const read = inkOf(config);
    read['count'] = 99;
    expect(config.ink.count).toBe(3);
  });
});

describe('what a panel will draw', () => {
  it('is the wall’s settings when nothing is overridden', () => {
    expect(mergeInk({ count: 6, mode: 'list' })).toEqual({ count: 6, mode: 'list' });
  });

  it('lays the overrides over the top, and drops ink itself', () => {
    // `ink` is the lane, not a setting: leaving it in the merged object would
    // hand the renderer one more key its tolerant readers could trip over.
    expect(mergeInk({ count: 6, mode: 'list', ink: { count: 3 } })).toEqual({
      count: 3,
      mode: 'list',
    });
  });

  it('carries a key the wall never set', () => {
    expect(mergeInk({ ink: { shiftName: 'code' } })).toEqual({ shiftName: 'code' });
  });
});

describe('writing in a lane', () => {
  it('writes the wall lane exactly as it always did', () => {
    expect(setLaneValue({ mode: 'list' }, 'wall', 'count', 3)).toEqual({ mode: 'list', count: 3 });
  });

  it('never touches a wall value from the ink lane', () => {
    /*
     * The whole point of the module. The wall keeps every setting it had, and
     * the override sits beside them.
     */
    const wall = { count: 6, mode: 'list', background: '#ff0000' };
    const next = setLaneValue(wall, 'ink', 'count', 3);
    expect(next).toEqual({ count: 6, mode: 'list', background: '#ff0000', ink: { count: 3 } });
    // And the input was not mutated on the way through.
    expect(wall).toEqual({ count: 6, mode: 'list', background: '#ff0000' });
  });

  it('keeps the override one level deep', () => {
    // The server's schema refuses a nested `ink` because it is not among the
    // picked keys; the editor must not be the one trying to write it.
    const next = setLaneValue({ ink: { count: 3 } }, 'ink', 'mode', 'month');
    expect(next).toEqual({ ink: { count: 3, mode: 'month' } });
    expect((next?.['ink'] as Record<string, unknown>)['ink']).toBeUndefined();
  });

  it('treats an empty value as no override, in either lane', () => {
    // Unticking a box, clearing a number, emptying a selection: the same
    // "absent means follow" the wall lane has always used, one level down.
    for (const empty of [undefined, null, '', []]) {
      expect(setLaneValue({ count: 6, ink: { count: 3 } }, 'ink', 'count', empty)).toEqual({
        count: 6,
      });
    }
  });

  it('carries nothing at all once the last override is cleared', () => {
    // Not an empty object: `{ ink: {} }` would round-trip through the schema
    // and back on every save as noise nobody can see or remove.
    expect(setLaneValue({ ink: { count: 3 } }, 'ink', 'count', undefined)).toBeUndefined();
    expect(setLaneValue({ count: 3 }, 'wall', 'count', undefined)).toBeUndefined();
  });

  it('replaces an ink that was not an object rather than merging into it', () => {
    expect(setLaneValue({ ink: 'nonsense' }, 'ink', 'count', 3)).toEqual({ ink: { count: 3 } });
  });
});

describe('the ladder clearing the switches it replaces', () => {
  it('clears them in the wall lane and leaves any override alone', () => {
    expect(clearLaneKeys({ showHours: false, ink: { showHours: false } }, 'wall', ['showHours'])).toEqual(
      { ink: { showHours: false } },
    );
  });

  it('clears them in the ink lane and leaves the wall alone', () => {
    /*
     * The one place the lanes could have quietly leaked. Writing an ink ladder
     * clears the switches it supersedes — and clearing the *wall's* copy of
     * them would be a panel's settings rewriting a kitchen wall.
     */
    expect(clearLaneKeys({ showHours: false, ink: { showHours: false } }, 'ink', ['showHours'])).toEqual(
      { showHours: false },
    );
  });

  it('drops the whole config when nothing is left', () => {
    expect(clearLaneKeys({ ink: { showIcon: false } }, 'ink', ['showIcon'])).toBeUndefined();
  });
});

describe('the wall, reading a widget that has an ink lane', () => {
  it('draws its own settings and never the override', () => {
    /*
     * The lane is one-way at the *renderer* too, and this is where that would
     * break silently: every widget resolver takes the whole stored config, so
     * one that reached into `ink` would put a panel's settings on a kitchen
     * wall. They ignore it because they read named keys — asserted rather than
     * assumed, since "it happens to work" is how `shifts[0]` survived.
     */
    expect(clockWidgetView({ clockFormat: '24', ink: { clockFormat: '12' } }).format).toBe('24');
    expect(clockWidgetView({ ink: { clockFormat: '12' } }).format).toBe('follow');
    expect(clockWidgetView({ showDate: true, ink: { showDate: false } }).date).toBe(true);
  });

  it('resolves its ladders from its own list, not the lane’s', () => {
    expect(shiftLadder({ fields: ['shift'], ink: { fields: ['person'] } })).toEqual(['shift']);
    expect(weatherLadder({ ink: { fields: ['high'] } })).toEqual(['name', 'icon', 'high', 'low']);
  });

  it('picks the same people the wall was told to', () => {
    const today = [
      { shift: { personId: 'p1', personName: 'Amy', label: 'Days' } },
      { shift: { personId: 'p2', personName: 'Ben', label: 'Nights' } },
    ] as unknown as Parameters<typeof shiftWidgetView>[0];
    const view = shiftWidgetView(today, { people: ['p1'], ink: { people: ['p2'] } });
    expect(view.entries.map((entry) => entry.shift.personId)).toEqual(['p1']);
  });
});
