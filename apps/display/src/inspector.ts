/**
 * What the inspector should show, as a decision rather than as a render.
 *
 * `renderConfigPanel` empties a panel and rebuilds it, and along the way it
 * answers seven questions no test could reach: whether there is anything to
 * show at all, what the widget is called, whether the lane switch appears,
 * which lane is actually in force, whether the ink lane is carrying overrides,
 * whether this box is one the wall leaves out (and the sentence that says so),
 * and which of the two tabs the body comes from.
 *
 * Two of those have a history. **The lane is forced** when no panel follows
 * this canvas — a widget rendered on the ink lane with no panel to override
 * would write overrides nothing reads. And **the note belongs to the wall lane
 * only**: the ink lane is about what a panel says differently, and "not on the
 * wall yet" over a panel's overrides is an answer to a question nobody asked
 * there.
 *
 * Returning a description rather than drawing means the questions can be asked
 * without a browser — this package's test suite has no DOM — and, more to the
 * point, asked all at once, where "the ink lane is showing while the lane bar
 * is hidden" is a contradiction a reader can see.
 */

import { inkOf } from './ink.js';
import { omittedReason, omissionNote, type NotDrawn, type Surface } from './omission.js';
import { labelFor } from './widget-labels.js';

export type InspectorTab = 'content' | 'style';
export type InspectorLane = 'wall' | 'ink';

/** All the inspector needs of a widget. */
export interface InspectableWidget {
  readonly id: string;
  readonly type: string;
  readonly config?: Record<string, unknown> | undefined;
}

export interface InspectorInput {
  readonly widgets: readonly InspectableWidget[];
  /** The selected widget's id, or nothing. */
  readonly selected: string | undefined;
  /** Which lane the person last chose. Ignored when no panel follows. */
  readonly lane: InspectorLane;
  /** Whether a panel follows this canvas, so an override would be read. */
  readonly inkAvailable: boolean;
  /** Which tab the person last chose. The wall lane only has tabs. */
  readonly tab: InspectorTab;
  readonly notDrawn: NotDrawn;
  readonly surface: Surface;
}

/**
 * Nothing selected — or a selection whose widget has gone, which is the same
 * thing. `restoreCanvas` already drops a selection an undo removed; this is the
 * second reading of that rule, so a stale id closes the panel rather than
 * describing a box that is not there.
 */
export interface EmptyInspector {
  readonly kind: 'empty';
}

export interface WidgetInspector {
  readonly kind: 'widget';
  readonly widgetId: string;
  readonly type: string;
  /** The heading: which widget this is, said outright. */
  readonly title: string;
  /** The destructive action, named after what it destroys. */
  readonly removeLabel: string;
  /** Whether the wall/ink switch is offered at all. */
  readonly laneBarVisible: boolean;
  /** The lane actually in force, which is `wall` whenever no panel follows. */
  readonly lane: InspectorLane;
  /** Whether this widget already says something different on a panel. */
  readonly hasInkOverrides: boolean;
  /** Why the wall leaves this box out, said in full. Wall lane only. */
  readonly note?: string | undefined;
  /**
   * Which tab supplies the body — and its absence is the ink lane, which has no
   * Content/Style split: a panel honours a handful of keys and they are one
   * short list, so two tabs over them would be two mostly-empty tabs.
   */
  readonly tab?: InspectorTab | undefined;
}

export type InspectorView = EmptyInspector | WidgetInspector;

export function inspectorView(input: InspectorInput): InspectorView {
  const widget = input.widgets.find((one) => one.id === input.selected);
  if (widget === undefined) return { kind: 'empty' };

  const name = labelFor(widget.type);
  // The lane the person chose only survives when there is a panel to override.
  const lane: InspectorLane = input.inkAvailable ? input.lane : 'wall';
  const base = {
    kind: 'widget' as const,
    widgetId: widget.id,
    type: widget.type,
    title: `${name} widget`,
    removeLabel: `Remove this ${name.toLowerCase()} widget`,
    laneBarVisible: input.inkAvailable,
    lane,
    hasInkOverrides: Object.keys(inkOf(widget.config)).length > 0,
  };
  if (lane === 'ink') return base;

  const why = omittedReason(widget, input.widgets, input.notDrawn);
  return {
    ...base,
    ...(why === undefined ? {} : { note: omissionNote(why, input.surface) }),
    tab: input.tab,
  };
}
