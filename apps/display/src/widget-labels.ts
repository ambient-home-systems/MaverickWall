/**
 * What the editor calls a widget: the palette it is chosen from, the name on
 * its box and in the Layers list, and the swatch that tells two rows apart.
 *
 * Pure, and out of `boot()` for the reason the other extractions are: there is
 * no DOM in this package's test suite, so a name composed inside a
 * `createElement` call is a name nothing can check. `describeWidget` in
 * particular has already shipped a fault — a box went on saying "Month grid"
 * while drawing a week, because the picker rebuilt the inspector and nothing
 * else — and the fix for that (re-reading every name in place) is only correct
 * while there is exactly one place a name is composed.
 */

import { viewLabel } from './widget-views.js';

/** The first-party palette. No web embed is offered — the wall cannot draw one. */
export const PALETTE: readonly { readonly type: string; readonly label: string }[] = [
  { type: 'clock', label: 'Clock' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'weather', label: 'Weather' },
  { type: 'homeassistant', label: 'Home Assistant' },
  { type: 'shift', label: 'Shift' },
  { type: 'countdown', label: 'Countdown' },
  { type: 'notes', label: 'Notes' },
  { type: 'todo', label: 'To-do' },
  { type: 'chores', label: 'Chores' },
  { type: 'image', label: 'Image' },
  { type: 'external', label: 'Module' },
];

/**
 * A layers-list swatch colour per widget type, from the admin token set (so it
 * follows the admin theme). Only to tell the rows apart at a glance — no meaning
 * on the wall. Unknown types fall back to the muted token.
 */
export const SWATCH: Readonly<Record<string, string>> = {
  clock: 'var(--accent)',
  calendar: 'var(--night)',
  weather: 'var(--ok)',
  homeassistant: 'var(--warn)',
  shift: 'var(--danger)',
  countdown: 'var(--accent)',
  notes: 'var(--muted)',
  todo: 'var(--night)',
  chores: 'var(--ok)',
  image: 'var(--ok)',
  external: 'var(--warn)',
};

/**
 * The type's own name.
 *
 * An unknown type answers with the type itself rather than with nothing: a
 * canvas saved by a newer bundle than the one reading it must still name its
 * boxes, and "external" is a poorer label than "Module" but is not a blank box.
 */
export function labelFor(type: string): string {
  return PALETTE.find((p) => p.type === type)?.label ?? type;
}

/**
 * What a box is called on the canvas and in the Layers list.
 *
 * The type's name, plus which view it is set to when the type has more than
 * one. Two Calendars used to be two boxes both reading "Calendar", and the one
 * showing a month and the one showing the next few events were told apart only
 * by selecting each and reading its Content tab.
 */
export function describeWidget(widget: {
  readonly type: string;
  readonly config?: Record<string, unknown> | undefined;
}): string {
  const base = labelFor(widget.type);
  const view = viewLabel(widget.type, widget.config);
  return view === undefined ? base : `${base} \u2014 ${view}`;
}
