import { describe, expect, it } from 'vitest';
import { PALETTE, SWATCH, describeWidget, labelFor } from '../src/widget-labels.js';
import { WIDGET_VIEWS } from '../src/widget-views.js';

/**
 * What the editor calls a widget.
 *
 * The name is on the box, in the Layers list and in the box's accessible name,
 * and it has already shipped a fault: a Calendar went on saying "Month grid"
 * while drawing a week, because the picker rebuilt the inspector and nothing
 * else. The cure was to re-read every name in place — which is only correct
 * while there is exactly one place a name is composed, and that is this module.
 */
describe('the palette', () => {
  it('has a label for every type it offers', () => {
    for (const entry of PALETTE) {
      expect(entry.label.trim(), `${entry.type} has no label`).not.toBe('');
      expect(labelFor(entry.type)).toBe(entry.label);
    }
  });

  it('offers each type once', () => {
    expect(new Set(PALETTE.map((one) => one.type)).size).toBe(PALETTE.length);
  });

  it('has a swatch for every type, so no layer row is unmarked', () => {
    for (const entry of PALETTE) {
      expect(SWATCH[entry.type], `${entry.type} has no swatch`).toBeDefined();
    }
  });

  it('names an unknown type after itself rather than leaving a blank box', () => {
    // A canvas saved by a newer bundle can carry a type this one has no entry
    // for. "future" is a poorer label than a real name and is not a blank one.
    expect(labelFor('future')).toBe('future');
    expect(labelFor('')).toBe('');
  });
});

describe('what a box is called', () => {
  it('is the type alone when the type has one view', () => {
    // A view that is stated rather than chosen adds nothing to the name.
    expect(describeWidget({ type: 'notes' })).toBe('Notes');
  });

  it('carries the view when the type has more than one', () => {
    expect(describeWidget({ type: 'calendar', config: { mode: 'month' } })).toBe(
      'Calendar — Month grid',
    );
    expect(describeWidget({ type: 'calendar', config: { mode: 'list' } })).toBe(
      'Calendar — Upcoming list',
    );
  });

  it('changes when the view does, which is the fault it exists for', () => {
    // Two Calendars used to be two boxes both reading "Calendar", told apart
    // only by selecting each and reading its Content tab.
    const month = describeWidget({ type: 'calendar', config: { mode: 'month' } });
    const week = describeWidget({ type: 'calendar', config: { mode: 'week' } });
    expect(month).not.toBe(week);
  });

  it('names a widget with no options at all', () => {
    // Every widget starts this way: added from the palette, nothing chosen.
    for (const entry of PALETTE) {
      const name = describeWidget({ type: entry.type });
      expect(name.startsWith(entry.label), `${entry.type} lost its own name`).toBe(true);
      expect(name.trim()).not.toBe('');
    }
  });

  it('reads a legacy stored view the way the renderer does', () => {
    /*
     * `skymonth` and `skyweek` were views once and are a density now. A canvas
     * that stored one is left exactly as it is until the household edits that
     * widget, so the name has to resolve it rather than fall through to the
     * first entry — which is what a picker with no matching option does, and is
     * how an assertion in this project once passed with its fix removed.
     */
    expect(describeWidget({ type: 'calendar', config: { mode: 'skyweek' } })).toBe(
      'Calendar — Week columns',
    );
  });

  it('agrees with the view table about which types have a choice to make', () => {
    for (const entry of PALETTE) {
      const views = WIDGET_VIEWS[entry.type] ?? [];
      const named = describeWidget({ type: entry.type }) !== entry.label;
      expect(named, `${entry.type} names ${views.length} view(s) in its box label`).toBe(
        views.length > 1,
      );
    }
  });
});
